use crate::PacketError;
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

pub const EQUAL: u8 = 0;
pub const LUCKY: u8 = 1;
pub const MAX_CLAIMS: u32 = 1000;
pub const MAX_LIFETIME: i64 = 7 * 24 * 3600;
pub const ORACLE_GRACE: i64 = 3600;

pub fn validate_creation(mode: u8, total: u64, count: u32, expires: i64, now: i64) -> Result<()> {
    require!(mode == EQUAL || mode == LUCKY, PacketError::InvalidMode);
    require!(
        count > 0 && count <= MAX_CLAIMS && total >= count as u64,
        PacketError::InvalidAmount
    );
    require!(
        mode != EQUAL || total % count as u64 == 0,
        PacketError::NotDivisible
    );
    require!(
        expires > now && expires <= now.checked_add(MAX_LIFETIME).ok_or(PacketError::Overflow)?,
        PacketError::InvalidExpiry
    );
    Ok(())
}

pub fn lucky_amount(remaining: u64, left: u32, entropy: &[u8; 64], claim: &Pubkey) -> Result<u64> {
    require!(
        left > 0 && remaining >= left as u64,
        PacketError::InvalidAmount
    );
    if left == 1 {
        return Ok(remaining);
    }
    let maximum =
        ((remaining as u128 * 2) / left as u128).min((remaining - (left as u64 - 1)) as u128);
    let limit = u128::MAX - u128::MAX % maximum;
    for counter in 0u32..32 {
        let digest = hashv(&[
            b"tap-pay-lucky-allocation-v1",
            entropy,
            claim.as_ref(),
            &counter.to_le_bytes(),
        ])
        .to_bytes();
        let value = u128::from_le_bytes(digest[..16].try_into().unwrap());
        if value < limit {
            return Ok((value % maximum + 1) as u64);
        }
    }
    err!(PacketError::RandomnessUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equal_creation_rejects_rounding_zero_and_expiry() {
        assert!(validate_creation(EQUAL, 500000, 5, 200, 100).is_ok());
        for (total, count) in [(0, 5), (3, 5), (11, 5), (10, 0), (5000, 1001)] {
            assert!(validate_creation(EQUAL, total, count, 200, 100).is_err());
        }
        assert!(validate_creation(LUCKY, 10, 3, 100, 100).is_err());
        assert!(validate_creation(3, 10, 3, 200, 100).is_err());
    }
    #[test]
    fn lucky_conserves_raw_units_and_reserves_every_remaining_claim() {
        for total in [5, 17, 1000000, u64::MAX] {
            for run in 0u32..200 {
                let mut remaining = total;
                for left in (1..=5).rev() {
                    let mut entropy = [0u8; 64];
                    entropy[..4].copy_from_slice(&run.to_le_bytes());
                    entropy[4] = left as u8;
                    let amount =
                        lucky_amount(remaining, left, &entropy, &Pubkey::new_unique()).unwrap();
                    assert!(amount > 0 && amount <= remaining - (left as u64 - 1));
                    remaining -= amount;
                }
                assert_eq!(remaining, 0);
            }
        }
    }
    #[test]
    fn fixed_entropy_has_fixed_result_and_last_claim_gets_remainder() {
        let claim = Pubkey::new_unique();
        let entropy = [9; 64];
        assert_eq!(
            lucky_amount(100, 3, &entropy, &claim).unwrap(),
            lucky_amount(100, 3, &entropy, &claim).unwrap()
        );
        assert_eq!(lucky_amount(99, 1, &entropy, &claim).unwrap(), 99);
        assert!(lucky_amount(2, 3, &entropy, &claim).is_err());
    }
}
