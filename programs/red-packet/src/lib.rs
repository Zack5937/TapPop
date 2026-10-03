use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use orao_solana_vrf::{
    program::OraoVrf,
    state::{NetworkState, RandomnessV2},
    CONFIG_ACCOUNT_SEED, RANDOMNESS_ACCOUNT_SEED,
};
use solana_sha256_hasher::hashv;
mod allocation;
use allocation::*;
include!(concat!(env!("OUT_DIR"), "/program_id.rs"));

#[program]
pub mod tap_pay_red_packet {
    use super::*;

    pub fn create(
        ctx: Context<Create>,
        nonce: [u8; 32],
        mode: u8,
        total: u64,
        count: u32,
        expires_at: i64,
    ) -> Result<()> {
        validate_creation(mode, total, count, expires_at, Clock::get()?.unix_timestamp)?;
        validate_mint(&ctx.accounts.mint.to_account_info())?;
        ctx.accounts.packet.set_inner(Packet {
            creator: ctx.accounts.creator.key(),
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            nonce,
            mode,
            total,
            remaining: total,
            max_claims: count,
            claimed_count: 0,
            expires_at,
            pending_claim: Pubkey::default(),
            status: 0,
            bump: ctx.bumps.packet,
        });
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            total,
            ctx.accounts.mint.decimals,
        )
    }

    // Equal mode or the deterministic last share of a lucky packet.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let packet = &mut ctx.accounts.packet;
        packet.check_open(Clock::get()?.unix_timestamp)?;
        let left = packet.max_claims - packet.claimed_count;
        require!(
            packet.mode == EQUAL || left == 1,
            PacketError::RequiresRandomness
        );
        let amount = if packet.mode == EQUAL {
            packet.total / packet.max_claims as u64
        } else {
            packet.remaining
        };
        transfer_out(
            packet,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.claim_record.set_inner(ClaimRecord {
            packet: packet.key(),
            claimant: ctx.accounts.claimant.key(),
            vrf_seed: [0; 32],
            amount,
            status: 1,
            bump: ctx.bumps.claim_record,
        });
        packet.finish_claim(amount)
    }

    pub fn reserve_lucky(
        ctx: Context<ReserveLucky>,
        nonce: [u8; 32],
        max_oracle_fee: u64,
    ) -> Result<()> {
        let packet = &mut ctx.accounts.packet;
        packet.check_open(Clock::get()?.unix_timestamp)?;
        require!(
            packet.mode == LUCKY && packet.max_claims - packet.claimed_count > 1,
            PacketError::InvalidMode
        );
        require!(
            ctx.accounts.network_state.config.request_fee <= max_oracle_fee,
            PacketError::OracleFeeChanged
        );
        let seed = request_seed(&packet.key(), &ctx.accounts.claimant.key(), &nonce);
        let (expected, _) =
            Pubkey::find_program_address(&[RANDOMNESS_ACCOUNT_SEED, &seed], &orao_solana_vrf::ID);
        require_keys_eq!(
            ctx.accounts.randomness.key(),
            expected,
            PacketError::InvalidRandomness
        );
        require!(
            ctx.accounts.randomness.owner == &System::id()
                && ctx.accounts.randomness.data_is_empty(),
            PacketError::RandomnessNotFresh
        );
        ctx.accounts.claim_record.set_inner(ClaimRecord {
            packet: packet.key(),
            claimant: ctx.accounts.claimant.key(),
            vrf_seed: seed,
            amount: 0,
            status: 0,
            bump: ctx.bumps.claim_record,
        });
        packet.pending_claim = ctx.accounts.claim_record.key();
        orao_solana_vrf::cpi::request_v2(
            CpiContext::new(
                ctx.accounts.oracle_program.to_account_info(),
                orao_solana_vrf::cpi::accounts::RequestV2 {
                    payer: ctx.accounts.claimant.to_account_info(),
                    network_state: ctx.accounts.network_state.to_account_info(),
                    treasury: ctx.accounts.oracle_treasury.to_account_info(),
                    request: ctx.accounts.randomness.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            seed,
        )
    }

    // Permissionless completion; recipient is fixed by the signed reservation.
    pub fn settle_lucky(ctx: Context<SettleLucky>) -> Result<()> {
        let packet = &mut ctx.accounts.packet;
        let record = &mut ctx.accounts.claim_record;
        require!(
            packet.status == 0 && packet.mode == LUCKY && record.status == 0,
            PacketError::Closed
        );
        require_keys_eq!(
            packet.pending_claim,
            record.key(),
            PacketError::InvalidClaim
        );
        validate_randomness(&ctx.accounts.randomness, record)?;
        let fulfilled = ctx
            .accounts
            .randomness
            .fulfilled()
            .ok_or(PacketError::RandomnessUnavailable)?;
        let amount = lucky_amount(
            packet.remaining,
            packet.max_claims - packet.claimed_count,
            &fulfilled.randomness,
            &record.key(),
        )?;
        transfer_out(
            packet,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        record.amount = amount;
        record.status = 1;
        packet.finish_claim(amount)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let packet = &mut ctx.accounts.packet;
        let now = Clock::get()?.unix_timestamp;
        require!(
            packet.status == 0 && now >= packet.expires_at,
            PacketError::NotRefundable
        );
        if packet.pending_claim != Pubkey::default() {
            let record = ctx
                .accounts
                .pending_record
                .as_mut()
                .ok_or(PacketError::InvalidClaim)?;
            require_keys_eq!(
                record.key(),
                packet.pending_claim,
                PacketError::InvalidClaim
            );
            require_keys_eq!(record.packet, packet.key(), PacketError::InvalidClaim);
            require!(record.status == 0, PacketError::InvalidClaim);
            let random = ctx
                .accounts
                .randomness
                .as_ref()
                .ok_or(PacketError::InvalidRandomness)?;
            validate_randomness(random, record)?;
            require!(
                random.fulfilled().is_none(),
                PacketError::SettleBeforeRefund
            );
            require!(
                now >= packet
                    .expires_at
                    .checked_add(ORACLE_GRACE)
                    .ok_or(PacketError::Overflow)?,
                PacketError::OracleGrace
            );
            record.status = 2;
        }
        let amount = packet.remaining;
        transfer_out(
            packet,
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        packet.remaining = 0;
        packet.pending_claim = Pubkey::default();
        packet.status = 2;
        Ok(())
    }
}

pub fn request_seed(packet: &Pubkey, claimant: &Pubkey, nonce: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"tap-pay-vrf-v1", packet.as_ref(), claimant.as_ref(), nonce]).to_bytes()
}
fn validate_randomness(
    random: &Account<RandomnessV2>,
    record: &Account<ClaimRecord>,
) -> Result<()> {
    let expected = Pubkey::find_program_address(
        &[RANDOMNESS_ACCOUNT_SEED, &record.vrf_seed],
        &orao_solana_vrf::ID,
    )
    .0;
    require_keys_eq!(random.key(), expected, PacketError::InvalidRandomness);
    require!(
        random.seed() == &record.vrf_seed && random.client() == &record.claimant,
        PacketError::InvalidRandomness
    );
    Ok(())
}
fn validate_mint(info: &AccountInfo) -> Result<()> {
    if info.owner == &anchor_spl::token::ID {
        return Ok(());
    }
    use anchor_spl::token_2022::spl_token_2022::{
        extension::{
            scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, ExtensionType,
            StateWithExtensions,
        },
        state::Mint as RawMint,
    };
    let data = info.try_borrow_data()?;
    let mint = StateWithExtensions::<RawMint>::unpack(&data)?;
    require!(
        mint.base.decimals == 6
            && mint.base.mint_authority.is_none()
            && mint.base.freeze_authority.is_none(),
        PacketError::UnsupportedMint
    );
    require!(
        mint.get_extension_types()? == vec![ExtensionType::ScaledUiAmount],
        PacketError::UnsupportedMint
    );
    let scaling = mint.get_extension::<ScaledUiAmountConfig>()?;
    require!(
        Option::<Pubkey>::from(scaling.authority).is_none()
            && f64::from(scaling.multiplier) == 2.0
            && f64::from(scaling.new_multiplier) == 2.0,
        PacketError::UnsupportedMint
    );
    Ok(())
}
fn transfer_out<'info>(
    packet: &Account<'info, Packet>,
    vault: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let bump = [packet.bump];
    let seeds: &[&[u8]] = &[b"packet", packet.creator.as_ref(), &packet.nonce, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: vault,
                mint,
                to: destination,
                authority: packet.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        decimals,
    )
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct Create<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + Packet::INIT_SPACE, seeds = [b"packet", creator.key().as_ref(), &nonce], bump)]
    pub packet: Account<'info, Packet>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = creator, token::token_program = token_program)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = creator, associated_token::mint = mint, associated_token::authority = packet, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [b"packet", packet.creator.as_ref(), &packet.nonce], bump = packet.bump, has_one = mint, has_one = token_program)]
    pub packet: Account<'info, Packet>,
    #[account(init, payer = claimant, space = 8 + ClaimRecord::INIT_SPACE, seeds = [b"claim", packet.key().as_ref(), claimant.key().as_ref()], bump)]
    pub claim_record: Account<'info, ClaimRecord>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = packet, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = claimant, associated_token::mint = mint, associated_token::authority = claimant, associated_token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReserveLucky<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [b"packet", packet.creator.as_ref(), &packet.nonce], bump = packet.bump)]
    pub packet: Account<'info, Packet>,
    #[account(init, payer = claimant, space = 8 + ClaimRecord::INIT_SPACE, seeds = [b"claim", packet.key().as_ref(), claimant.key().as_ref()], bump)]
    pub claim_record: Account<'info, ClaimRecord>,
    /// CHECK: PDA is derived inside the instruction; must be unused before VRF CPI.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, seeds = [CONFIG_ACCOUNT_SEED], bump, seeds::program = orao_solana_vrf::ID)]
    pub network_state: Account<'info, NetworkState>,
    /// CHECK: Only the oracle's configured SOL treasury is accepted.
    #[account(mut, address = network_state.config.treasury)]
    pub oracle_treasury: UncheckedAccount<'info>,
    pub oracle_program: Program<'info, OraoVrf>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleLucky<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Cannot redirect funds: address and ATA are fixed by the reservation.
    #[account(address = claim_record.claimant)]
    pub claimant: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"packet", packet.creator.as_ref(), &packet.nonce], bump = packet.bump, has_one = mint, has_one = token_program)]
    pub packet: Account<'info, Packet>,
    #[account(mut, seeds = [b"claim", packet.key().as_ref(), claimant.key().as_ref()], bump = claim_record.bump, has_one = packet)]
    pub claim_record: Account<'info, ClaimRecord>,
    pub randomness: Account<'info, RandomnessV2>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = packet, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = claimant, associated_token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"packet", packet.creator.as_ref(), &packet.nonce], bump = packet.bump, has_one = creator, has_one = mint, has_one = token_program)]
    pub packet: Account<'info, Packet>,
    #[account(mut)]
    pub pending_record: Option<Account<'info, ClaimRecord>>,
    pub randomness: Option<Account<'info, RandomnessV2>>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = packet, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = creator, associated_token::mint = mint, associated_token::authority = creator, associated_token::token_program = token_program)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Packet {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub nonce: [u8; 32],
    pub mode: u8,
    pub total: u64,
    pub remaining: u64,
    pub max_claims: u32,
    pub claimed_count: u32,
    pub expires_at: i64,
    pub pending_claim: Pubkey,
    pub status: u8,
    pub bump: u8,
}
impl Packet {
    fn check_open(&self, now: i64) -> Result<()> {
        require!(
            self.status == 0 && self.remaining > 0 && self.claimed_count < self.max_claims,
            PacketError::Closed
        );
        require!(now < self.expires_at, PacketError::Expired);
        require!(
            self.pending_claim == Pubkey::default(),
            PacketError::ClaimInProgress
        );
        Ok(())
    }
    fn finish_claim(&mut self, amount: u64) -> Result<()> {
        require!(
            amount > 0 && amount <= self.remaining,
            PacketError::InvalidAmount
        );
        let remaining = self
            .remaining
            .checked_sub(amount)
            .ok_or(PacketError::Overflow)?;
        let claimed_count = self
            .claimed_count
            .checked_add(1)
            .ok_or(PacketError::Overflow)?;
        require!(
            claimed_count <= self.max_claims
                && remaining >= (self.max_claims - claimed_count) as u64,
            PacketError::InvalidAmount
        );
        require!(
            claimed_count != self.max_claims || remaining == 0,
            PacketError::InvalidAmount
        );
        self.remaining = remaining;
        self.claimed_count = claimed_count;
        self.pending_claim = Pubkey::default();
        if self.remaining == 0 {
            self.status = 1;
        }
        Ok(())
    }
}
#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub packet: Pubkey,
    pub claimant: Pubkey,
    pub vrf_seed: [u8; 32],
    pub amount: u64,
    pub status: u8,
    pub bump: u8,
}
#[error_code]
pub enum PacketError {
    #[msg("Unsupported allocation mode")]
    InvalidMode,
    #[msg("Invalid raw amount or claim count")]
    InvalidAmount,
    #[msg("Equal amount must divide exactly")]
    NotDivisible,
    #[msg("Invalid expiry")]
    InvalidExpiry,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("VRF has not fulfilled this request")]
    RandomnessUnavailable,
    #[msg("Packet closed or exhausted")]
    Closed,
    #[msg("Packet expired")]
    Expired,
    #[msg("A reserved claim must finish first")]
    ClaimInProgress,
    #[msg("Lucky claim requires a fresh VRF request")]
    RequiresRandomness,
    #[msg("Oracle fee exceeded the reviewed cap")]
    OracleFeeChanged,
    #[msg("Wrong oracle request identity")]
    InvalidRandomness,
    #[msg("VRF request already exists; use a fresh nonce")]
    RandomnessNotFresh,
    #[msg("Wrong claim record")]
    InvalidClaim,
    #[msg("Unsupported Token-2022 profile")]
    UnsupportedMint,
    #[msg("Packet cannot yet be refunded")]
    NotRefundable,
    #[msg("Settle fulfilled reserved claim before refund")]
    SettleBeforeRefund,
    #[msg("Unfulfilled VRF reservation still in grace period")]
    OracleGrace,
}
