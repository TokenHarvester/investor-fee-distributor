pub const VAULT_SEED: &[u8] = b"vault";
pub const INVESTOR_FEE_POS_OWNER_SEED: &[u8] = b"investor_fee_pos_owner";
pub const POLICY_SEED: &[u8] = b"policy";
pub const PROGRESS_SEED: &[u8] = b"progress";
pub const TREASURY_SEED: &[u8] = b"treasury";

/// Time constants
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Basis points
pub const BASIS_POINTS_DIVISOR: u64 = 10_000;

/// Default minimum payout threshold (0.001 SOL equivalent in lamports)
pub const DEFAULT_MIN_PAYOUT_LAMPORTS: u64 = 1_000_000;

/// Maximum page size for investor distribution
pub const MAX_PAGE_SIZE: u8 = 50;