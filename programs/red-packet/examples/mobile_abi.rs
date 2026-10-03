//! Generate deterministic public fixtures for the TypeScript ABI compatibility tests.
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token, token_2022};
use orao_solana_vrf::{
    state::{FulfilledRequest, NetworkConfiguration, NetworkState, RandomnessV2, RequestAccount},
    CONFIG_ACCOUNT_SEED, RANDOMNESS_ACCOUNT_SEED,
};
use tap_pay_red_packet::{accounts, instruction, ClaimRecord, Packet, ID};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn data(value: &impl AccountSerialize) -> String {
    let mut bytes = vec![];
    value.try_serialize(&mut bytes).unwrap();
    hex(&bytes)
}
fn keys(value: &impl ToAccountMetas) -> Vec<String> {
    value
        .to_account_metas(None)
        .iter()
        .map(|a| format!("{}:{}:{}", a.pubkey, a.is_writable, a.is_signer))
        .collect()
}
fn main() {
    let creator = Pubkey::new_from_array([1; 32]);
    let mint = Pubkey::new_from_array([2; 32]);
    let claimant = Pubkey::new_from_array([3; 32]);
    let nonce = [7; 32];
    let (packet, bump) = Pubkey::find_program_address(&[b"packet", creator.as_ref(), &nonce], &ID);
    let (record, claim_bump) =
        Pubkey::find_program_address(&[b"claim", packet.as_ref(), claimant.as_ref()], &ID);
    let seed = tap_pay_red_packet::request_seed(&packet, &claimant, &[8; 32]);
    let random =
        Pubkey::find_program_address(&[RANDOMNESS_ACCOUNT_SEED, &seed], &orao_solana_vrf::ID).0;
    let state = Packet {
        creator,
        mint,
        token_program: token_2022::ID,
        nonce,
        mode: 1,
        total: 500_000,
        remaining: 400_000,
        max_claims: 5,
        claimed_count: 1,
        expires_at: 1_900_000_000,
        pending_claim: record,
        status: 0,
        bump,
    };
    let claim = ClaimRecord {
        packet,
        claimant,
        vrf_seed: seed,
        amount: 0,
        status: 0,
        bump: claim_bump,
    };
    let oracle = RandomnessV2 {
        request: RequestAccount::Fulfilled(FulfilledRequest {
            client: claimant,
            seed,
            randomness: [5; 64],
        }),
    };
    let network = NetworkState {
        config: NetworkConfiguration {
            authority: creator,
            treasury: creator,
            request_fee: 10_000_000,
            fulfillment_authorities: vec![creator],
            token_fee_config: None,
        },
        num_received: 1,
    };
    let ata = |owner: &Pubkey| {
        associated_token::get_associated_token_address_with_program_id(
            owner,
            &mint,
            &token_2022::ID,
        )
    };
    let create = accounts::Create {
        creator,
        packet,
        mint,
        source: ata(&creator),
        vault: ata(&packet),
        token_program: token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let claim_accounts = accounts::Claim {
        claimant,
        packet,
        claim_record: record,
        mint,
        vault: ata(&packet),
        destination: ata(&claimant),
        token_program: token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let reserve = accounts::ReserveLucky {
        claimant,
        packet,
        claim_record: record,
        randomness: random,
        network_state: Pubkey::find_program_address(&[CONFIG_ACCOUNT_SEED], &orao_solana_vrf::ID).0,
        oracle_treasury: creator,
        oracle_program: orao_solana_vrf::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let settle = accounts::SettleLucky {
        payer: creator,
        claimant,
        packet,
        claim_record: record,
        randomness: random,
        mint,
        vault: ata(&packet),
        destination: ata(&claimant),
        token_program: token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    let refund = accounts::Refund {
        creator,
        packet,
        pending_record: Some(record),
        randomness: Some(random),
        mint,
        vault: ata(&packet),
        destination: ata(&creator),
        token_program: token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    };
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "program": ID.to_string(), "packetAddress": packet.to_string(), "claimAddress": record.to_string(),
        "oracleAddress": random.to_string(), "creator": creator.to_string(), "claimant": claimant.to_string(), "mint": mint.to_string(),
        "packet": data(&state), "claim": data(&claim), "oracle": data(&oracle), "network": data(&network), "seed": hex(&seed),
        "oracleRequestSize": 8 + RandomnessV2::PENDING_SIZE,
        "create": { "data": hex(&instruction::Create { nonce, mode: 1, total: 500_000, count: 5, expires_at: 1_900_000_000 }.data()), "keys": keys(&create) },
        "claimInstruction": { "data": hex(&instruction::Claim {}.data()), "keys": keys(&claim_accounts) },
        "reserve": { "data": hex(&instruction::ReserveLucky { nonce: [8; 32], max_oracle_fee: 10_000_000 }.data()), "keys": keys(&reserve) },
        "settle": { "data": hex(&instruction::SettleLucky {}.data()), "keys": keys(&settle) },
        "refund": { "data": hex(&instruction::Refund {}.data()), "keys": keys(&refund) }
    })).unwrap());
}
