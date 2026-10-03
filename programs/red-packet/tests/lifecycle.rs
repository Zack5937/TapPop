//! Executes the compiled program and real SPL programs in a local VM.
//! Oracle fulfillment is an explicit fixture, not a test of the ORAO network/CPI.
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack, system_program};
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token, token::spl_token};
use litesvm::LiteSVM;
use orao_solana_vrf::{
    state::{FulfilledRequest, PendingRequest, RandomnessV2, RequestAccount},
    RANDOMNESS_ACCOUNT_SEED,
};
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use tap_pay_red_packet::{accounts, instruction, ClaimRecord, Packet, ID};

struct Fixture {
    vm: LiteSVM,
    creator: Keypair,
    mint: Pubkey,
    packet: Pubkey,
    vault: Pubkey,
    token_program: Pubkey,
    nonce: [u8; 32],
}

fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    associated_token::get_associated_token_address_with_program_id(owner, mint, program)
}

impl Fixture {
    fn new(scaled: bool) -> Self {
        let mut vm = LiteSVM::new();
        let path = std::env::var("RED_PACKET_SBF").unwrap_or_else(|_| {
            format!(
                "{}/../../target/deploy/tap_pay_red_packet.so",
                env!("CARGO_MANIFEST_DIR")
            )
        });
        vm.add_program_from_file(ID, path)
            .expect("Build the SBF program before running VM tests");
        let creator = Keypair::new();
        vm.airdrop(&creator.pubkey(), 10_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        let token_program = if scaled {
            anchor_spl::token_2022::ID
        } else {
            spl_token::ID
        };
        let base = spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 1_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mint_data = if scaled {
            use anchor_spl::token_2022::spl_token_2022::{
                extension::{
                    scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensionsMut,
                    ExtensionType, StateWithExtensionsMut,
                },
                state::Mint,
            };
            let mut data = vec![
                0;
                ExtensionType::try_calculate_account_len::<Mint>(&[
                    ExtensionType::ScaledUiAmount
                ])
                .unwrap()
            ];
            let mut state =
                StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
            let extension = state.init_extension::<ScaledUiAmountConfig>(false).unwrap();
            extension.multiplier = 2.0.into();
            extension.new_multiplier = 2.0.into();
            state.base = Mint {
                mint_authority: base.mint_authority,
                supply: base.supply,
                decimals: base.decimals,
                is_initialized: true,
                freeze_authority: base.freeze_authority,
            };
            state.pack_base();
            state.init_account_type().unwrap();
            data
        } else {
            let mut data = vec![0; spl_token::state::Mint::LEN];
            spl_token::state::Mint::pack(base, &mut data).unwrap();
            data
        };
        vm.set_account(
            mint,
            Account {
                lamports: 10_000_000,
                data: mint_data,
                owner: token_program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let mut data = vec![0; spl_token::state::Account::LEN];
        spl_token::state::Account::pack(
            spl_token::state::Account {
                mint,
                owner: creator.pubkey(),
                amount: 1_000_000,
                delegate: COption::None,
                state: spl_token::state::AccountState::Initialized,
                is_native: COption::None,
                delegated_amount: 0,
                close_authority: COption::None,
            },
            &mut data,
        )
        .unwrap();
        vm.set_account(
            ata(&creator.pubkey(), &mint, &token_program),
            Account {
                lamports: 10_000_000,
                data,
                owner: token_program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let nonce = [7; 32];
        let packet =
            Pubkey::find_program_address(&[b"packet", creator.pubkey().as_ref(), &nonce], &ID).0;
        let vault = ata(&packet, &mint, &token_program);
        Self {
            vm,
            creator,
            mint,
            packet,
            vault,
            token_program,
            nonce,
        }
    }

    fn execute(&mut self, ix: Instruction, signer: &Keypair) -> bool {
        // A distinct blockhash ensures duplicate attempts reach program constraints.
        self.vm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&signer.pubkey()),
            &[signer],
            self.vm.latest_blockhash(),
        );
        match self.vm.send_transaction(tx) {
            Ok(_) => true,
            Err(error) => {
                eprintln!("Rejected transaction: {error:?}");
                false
            }
        }
    }

    fn create(&mut self, mode: u8, total: u64, count: u32) -> bool {
        let creator = self.creator.insecure_clone();
        self.execute(
            Instruction {
                program_id: ID,
                accounts: accounts::Create {
                    creator: creator.pubkey(),
                    packet: self.packet,
                    mint: self.mint,
                    source: ata(&creator.pubkey(), &self.mint, &self.token_program),
                    vault: self.vault,
                    token_program: self.token_program,
                    associated_token_program: associated_token::ID,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::Create {
                    nonce: self.nonce,
                    mode,
                    total,
                    count,
                    expires_at: 100,
                }
                .data(),
            },
            &creator,
        )
    }

    fn wallet(&mut self) -> Keypair {
        let wallet = Keypair::new();
        self.vm.airdrop(&wallet.pubkey(), 1_000_000_000).unwrap();
        wallet
    }

    fn record(&self, claimant: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"claim", self.packet.as_ref(), claimant.as_ref()], &ID).0
    }

    fn claim_ix(&self, wallet: &Pubkey) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::Claim {
                claimant: *wallet,
                packet: self.packet,
                claim_record: self.record(wallet),
                mint: self.mint,
                vault: self.vault,
                destination: ata(wallet, &self.mint, &self.token_program),
                token_program: self.token_program,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::Claim {}.data(),
        }
    }

    fn packet_state(&self) -> Packet {
        Packet::try_deserialize(&mut self.vm.get_account(&self.packet).unwrap().data.as_slice())
            .unwrap()
    }

    fn balance(&self, owner: &Pubkey) -> u64 {
        let account = self
            .vm
            .get_account(&ata(owner, &self.mint, &self.token_program))
            .unwrap();
        // The base account layout is identical for both token programs.
        spl_token::state::Account::unpack(&account.data[..spl_token::state::Account::LEN])
            .unwrap()
            .amount
    }

    fn store<T: AccountSerialize>(&mut self, key: Pubkey, owner: Pubkey, value: &T) {
        let mut data = vec![];
        value.try_serialize(&mut data).unwrap();
        self.vm
            .set_account(
                key,
                Account {
                    lamports: 10_000_000,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    fn reserve_fixture(&mut self, wallet: &Pubkey, fulfilled: bool) -> Pubkey {
        let record = self.record(wallet);
        let seed = tap_pay_red_packet::request_seed(&self.packet, wallet, &[8; 32]);
        let randomness =
            Pubkey::find_program_address(&[RANDOMNESS_ACCOUNT_SEED, &seed], &orao_solana_vrf::ID).0;
        let mut packet = self.packet_state();
        packet.pending_claim = record;
        self.store(self.packet, ID, &packet);
        self.store(
            record,
            ID,
            &ClaimRecord {
                packet: self.packet,
                claimant: *wallet,
                vrf_seed: seed,
                amount: 0,
                status: 0,
                bump: Pubkey::find_program_address(
                    &[b"claim", self.packet.as_ref(), wallet.as_ref()],
                    &ID,
                )
                .1,
            },
        );
        let request = if fulfilled {
            RequestAccount::Fulfilled(FulfilledRequest {
                client: *wallet,
                seed,
                randomness: [5; 64],
            })
        } else {
            RequestAccount::Pending(PendingRequest {
                client: *wallet,
                seed,
                responses: vec![],
            })
        };
        self.store(randomness, orao_solana_vrf::ID, &RandomnessV2 { request });
        randomness
    }

    fn settle_ix(&self, payer: &Pubkey, claimant: &Pubkey, randomness: Pubkey) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::SettleLucky {
                payer: *payer,
                claimant: *claimant,
                packet: self.packet,
                claim_record: self.record(claimant),
                randomness,
                mint: self.mint,
                vault: self.vault,
                destination: ata(claimant, &self.mint, &self.token_program),
                token_program: self.token_program,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::SettleLucky {}.data(),
        }
    }

    fn refund_ix(&self, pending: Option<(Pubkey, Pubkey)>) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::Refund {
                creator: self.creator.pubkey(),
                packet: self.packet,
                pending_record: pending.map(|p| p.0),
                randomness: pending.map(|p| p.1),
                mint: self.mint,
                vault: self.vault,
                destination: ata(&self.creator.pubkey(), &self.mint, &self.token_program),
                token_program: self.token_program,
                associated_token_program: associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::Refund {}.data(),
        }
    }

    fn time(&mut self, timestamp: i64) {
        let mut clock: Clock = self.vm.get_sysvar();
        clock.unix_timestamp = timestamp;
        self.vm.set_sysvar(&clock);
    }
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn equal_spl_and_scaled_token_conserve_funds_and_reject_double_claims() {
    for scaled in [false, true] {
        let mut f = Fixture::new(scaled);
        assert!(f.create(0, 500_000, 5));
        let first = f.wallet();
        assert!(f.execute(f.claim_ix(&first.pubkey()), &first));
        assert_eq!(f.balance(&first.pubkey()), 100_000);
        assert!(!f.execute(f.claim_ix(&first.pubkey()), &first));
        assert_eq!(f.packet_state().claimed_count, 1);
        for _ in 0..4 {
            let wallet = f.wallet();
            assert!(f.execute(f.claim_ix(&wallet.pubkey()), &wallet));
            assert_eq!(f.balance(&wallet.pubkey()), 100_000);
        }
        assert_eq!(f.balance(&f.packet), 0);
        assert_eq!(f.packet_state().status, 1);
        let sixth = f.wallet();
        assert!(!f.execute(f.claim_ix(&sixth.pubkey()), &sixth));
    }
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn invalid_creation_and_recipient_fail_atomically_then_expiry_refunds_remainder() {
    let mut f = Fixture::new(false);
    assert!(!f.create(0, 11, 5));
    assert!(f.vm.get_account(&f.packet).is_none());
    assert_eq!(f.balance(&f.creator.pubkey()), 1_000_000);
    assert!(f.create(0, 500_000, 5));
    let wallet = f.wallet();
    let thief = f.wallet();
    let mut wrong = f.claim_ix(&wallet.pubkey());
    wrong.accounts[5].pubkey = ata(&thief.pubkey(), &f.mint, &f.token_program);
    assert!(!f.execute(wrong, &wallet));
    assert!(f.vm.get_account(&f.record(&wallet.pubkey())).is_none());
    assert!(f.execute(f.claim_ix(&wallet.pubkey()), &wallet));
    let creator = f.creator.insecure_clone();
    assert!(!f.execute(f.refund_ix(None), &creator));
    f.time(100);
    assert!(!f.execute(f.claim_ix(&thief.pubkey()), &thief));
    assert!(f.execute(f.refund_ix(None), &creator));
    assert_eq!(f.balance(&creator.pubkey()), 900_000);
    assert_eq!(f.balance(&f.packet), 0);
    assert_eq!(f.packet_state().status, 2);
    assert!(!f.execute(f.refund_ix(None), &creator));
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn lucky_fulfillment_cannot_be_redirected_or_refunded_and_finishes_after_expiry() {
    let mut f = Fixture::new(true);
    assert!(f.create(1, 500_000, 5));
    let claimant = f.wallet();
    let payer = f.wallet();
    let oracle = f.reserve_fixture(&claimant.pubkey(), true);
    assert!(!f.execute(f.claim_ix(&payer.pubkey()), &payer));
    let mut wrong = f.settle_ix(&payer.pubkey(), &claimant.pubkey(), oracle);
    wrong.accounts[7].pubkey = ata(&payer.pubkey(), &f.mint, &f.token_program);
    assert!(!f.execute(wrong, &payer));
    f.time(4000);
    let creator = f.creator.insecure_clone();
    assert!(!f.execute(
        f.refund_ix(Some((f.record(&claimant.pubkey()), oracle))),
        &creator
    ));
    assert!(f.execute(
        f.settle_ix(&payer.pubkey(), &claimant.pubkey(), oracle),
        &payer
    ));
    let amount = f.balance(&claimant.pubkey());
    assert!(amount > 0 && amount <= 200_000);
    assert_eq!(f.packet_state().remaining, 500_000 - amount);
    assert!(!f.execute(
        f.settle_ix(&payer.pubkey(), &claimant.pubkey(), oracle),
        &payer
    ));
    assert!(f.execute(f.refund_ix(None), &creator));
    assert_eq!(f.balance(&creator.pubkey()) + amount, 1_000_000);
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn unfulfilled_lucky_waits_for_grace_then_closes_without_reroll() {
    let mut f = Fixture::new(false);
    assert!(f.create(1, 500_000, 5));
    let claimant = f.wallet();
    let oracle = f.reserve_fixture(&claimant.pubkey(), false);
    assert!(!f.execute(
        f.settle_ix(&claimant.pubkey(), &claimant.pubkey(), oracle),
        &claimant
    ));
    let creator = f.creator.insecure_clone();
    f.time(3699);
    assert!(!f.execute(
        f.refund_ix(Some((f.record(&claimant.pubkey()), oracle))),
        &creator
    ));
    f.time(3700);
    assert!(f.execute(
        f.refund_ix(Some((f.record(&claimant.pubkey()), oracle))),
        &creator
    ));
    assert_eq!(f.packet_state().status, 2);
    assert_eq!(f.balance(&creator.pubkey()), 1_000_000);
    let record = ClaimRecord::try_deserialize(
        &mut f
            .vm
            .get_account(&f.record(&claimant.pubkey()))
            .unwrap()
            .data
            .as_slice(),
    )
    .unwrap();
    assert_eq!(record.status, 2);
    assert!(!f.execute(f.claim_ix(&claimant.pubkey()), &claimant));
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn lucky_rejects_wrong_oracle_identity_and_last_claim_gets_exact_remainder() {
    let mut f = Fixture::new(false);
    assert!(f.create(1, 500_000, 5));
    let mut received = 0;
    for _ in 0..4 {
        let wallet = f.wallet();
        assert!(!f.execute(f.claim_ix(&wallet.pubkey()), &wallet));
        let oracle = f.reserve_fixture(&wallet.pubkey(), true);
        let mut account = f.vm.get_account(&oracle).unwrap();
        account.owner = ID;
        f.vm.set_account(oracle, account).unwrap();
        assert!(!f.execute(
            f.settle_ix(&wallet.pubkey(), &wallet.pubkey(), oracle),
            &wallet
        ));
        f.reserve_fixture(&wallet.pubkey(), true);
        let data = f.vm.get_account(&oracle).unwrap().data;
        let mut random = RandomnessV2::try_deserialize(&mut data.as_slice()).unwrap();
        random.fulfilled_mut().unwrap().client = Pubkey::new_unique();
        f.store(oracle, orao_solana_vrf::ID, &random);
        assert!(!f.execute(
            f.settle_ix(&wallet.pubkey(), &wallet.pubkey(), oracle),
            &wallet
        ));
        f.reserve_fixture(&wallet.pubkey(), true);
        assert!(f.execute(
            f.settle_ix(&wallet.pubkey(), &wallet.pubkey(), oracle),
            &wallet
        ));
        received += f.balance(&wallet.pubkey());
        assert!(!f.execute(f.claim_ix(&wallet.pubkey()), &wallet));
        assert_eq!(received + f.balance(&f.packet), 500_000);
    }
    let last = f.wallet();
    let remainder = f.packet_state().remaining;
    assert!(f.execute(f.claim_ix(&last.pubkey()), &last));
    assert_eq!(f.balance(&last.pubkey()), remainder);
    assert_eq!(received + remainder, 500_000);
    assert_eq!(f.packet_state().status, 1);
    assert_eq!(f.balance(&f.packet), 0);
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn mutable_or_wrong_scaled_mints_cannot_fund_packets() {
    use anchor_spl::token_2022::spl_token_2022::{
        extension::{
            scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensionsMut,
            StateWithExtensionsMut,
        },
        state::Mint,
    };
    for variation in 0..4 {
        let mut f = Fixture::new(true);
        let mut account = f.vm.get_account(&f.mint).unwrap();
        let mut mint = StateWithExtensionsMut::<Mint>::unpack(&mut account.data).unwrap();
        match variation {
            0 => mint.base.freeze_authority = COption::Some(Pubkey::new_unique()),
            1 => mint.base.mint_authority = COption::Some(Pubkey::new_unique()),
            2 => {
                mint.get_extension_mut::<ScaledUiAmountConfig>()
                    .unwrap()
                    .new_multiplier = 3.0.into()
            }
            _ => {
                mint.get_extension_mut::<ScaledUiAmountConfig>()
                    .unwrap()
                    .authority = Some(Pubkey::new_unique()).try_into().unwrap()
            }
        }
        mint.pack_base();
        f.vm.set_account(f.mint, account).unwrap();
        assert!(!f.create(0, 500_000, 5));
        assert!(f.vm.get_account(&f.packet).is_none());
        assert_eq!(f.balance(&f.creator.pubkey()), 1_000_000);
    }
}

#[test]
#[ignore = "requires SBF build; run scripts/test-red-packet-vm.sh"]
fn reservation_rejects_preexisting_entropy_and_fee_changes_before_any_cpi() {
    use orao_solana_vrf::{
        state::{NetworkConfiguration, NetworkState},
        CONFIG_ACCOUNT_SEED,
    };
    use solana_sdk::{instruction::InstructionError, transaction::TransactionError};
    let mut f = Fixture::new(false);
    assert!(f.create(1, 500_000, 5));
    let claimant = f.wallet();
    let treasury = f.wallet();
    // Executable identity fixture only. Negative cases must return the exact
    // pre-CPI error below; this does NOT stand in for ORAO request execution.
    let program_account = f.vm.get_account(&ID).unwrap();
    f.vm.set_account(orao_solana_vrf::ID, program_account)
        .unwrap();
    let network = Pubkey::find_program_address(&[CONFIG_ACCOUNT_SEED], &orao_solana_vrf::ID).0;
    f.store(
        network,
        orao_solana_vrf::ID,
        &NetworkState {
            config: NetworkConfiguration {
                authority: treasury.pubkey(),
                treasury: treasury.pubkey(),
                request_fee: 10_000_000,
                fulfillment_authorities: vec![treasury.pubkey()],
                token_fee_config: None,
            },
            num_received: 0,
        },
    );
    let nonce = [8; 32];
    let seed = tap_pay_red_packet::request_seed(&f.packet, &claimant.pubkey(), &nonce);
    let random =
        Pubkey::find_program_address(&[RANDOMNESS_ACCOUNT_SEED, &seed], &orao_solana_vrf::ID).0;
    f.store(
        random,
        orao_solana_vrf::ID,
        &RandomnessV2 {
            request: RequestAccount::Fulfilled(FulfilledRequest {
                client: claimant.pubkey(),
                seed,
                randomness: [5; 64],
            }),
        },
    );
    for (cap, expected) in [(9_999_999, 6010), (10_000_000, 6012)] {
        let ix = Instruction {
            program_id: ID,
            accounts: accounts::ReserveLucky {
                claimant: claimant.pubkey(),
                packet: f.packet,
                claim_record: f.record(&claimant.pubkey()),
                randomness: random,
                network_state: network,
                oracle_treasury: treasury.pubkey(),
                oracle_program: orao_solana_vrf::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::ReserveLucky {
                nonce,
                max_oracle_fee: cap,
            }
            .data(),
        };
        f.vm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&claimant.pubkey()),
            &[&claimant],
            f.vm.latest_blockhash(),
        );
        let error = f.vm.send_transaction(tx).unwrap_err();
        assert_eq!(
            error.err,
            TransactionError::InstructionError(0, InstructionError::Custom(expected))
        );
        assert!(f.vm.get_account(&f.record(&claimant.pubkey())).is_none());
        assert_eq!(f.packet_state().pending_claim, Pubkey::default());
    }
}
