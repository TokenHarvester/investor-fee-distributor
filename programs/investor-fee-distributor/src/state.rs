use anchor_lang::prelude::*;

/// Configuration for fee distribution policy
#[account]
pub struct DistributionPolicy {
    /// Vault this policy belongs to
    pub vault: Pubkey,
    
    /// Quote token mint
    pub quote_mint: Pubkey,
    
    /// Creator wallet to receive remainder fees
    pub creator_wallet: Pubkey,
    
    /// Total investor allocation minted at TGE (Y0)
    pub total_investor_allocation: u64,
    
    /// Maximum investor fee share in basis points (0-10000)
    /// Actual share = min(this, locked_percentage * 10000)
    pub investor_fee_share_bps: u16,
    
    /// Optional daily cap on distributions (in quote token lamports)
    /// 0 means no cap
    pub daily_cap_lamports: u64,
    
    /// Minimum payout per investor to avoid dust
    pub min_payout_lamports: u64,
    
    /// Bump for PDA derivation
    pub bump: u8,
}

impl DistributionPolicy {
    pub const LEN: usize = 8 + // discriminator
        32 + // vault
        32 + // quote_mint
        32 + // creator_wallet
        8 +  // total_investor_allocation
        2 +  // investor_fee_share_bps
        8 +  // daily_cap_lamports
        8 +  // min_payout_lamports
        1;   // bump
}

/// Tracks the state of ongoing distribution across days and pages
#[account]
pub struct DistributionProgress {
    /// Vault this progress belongs to
    pub vault: Pubkey,
    
    /// Timestamp of last distribution start
    pub last_distribution_ts: i64,
    
    /// Total quote fees claimed in current day
    pub current_day_claimed: u64,
    
    /// Total quote fees distributed to investors in current day
    pub current_day_distributed_investors: u64,
    
    /// Total quote fees sent to creator in current day
    pub current_day_distributed_creator: u64,
    
    /// Dust carried over from previous pages
    pub carry_over_dust: u64,
    
    /// Current pagination cursor (investor index)
    pub pagination_cursor: u32,
    
    /// Whether the current day's distribution is completed
    pub day_completed: bool,
    
    /// Total investors in the distribution set
    pub total_investors: u32,
    
    /// Bump for PDA derivation
    pub bump: u8,
}

impl DistributionProgress {
    pub const LEN: usize = 8 + // discriminator
        32 + // vault
        8 +  // last_distribution_ts
        8 +  // current_day_claimed
        8 +  // current_day_distributed_investors
        8 +  // current_day_distributed_creator
        8 +  // carry_over_dust
        4 +  // pagination_cursor
        1 +  // day_completed
        4 +  // total_investors
        1;   // bump
    
    /// Check if a new day has started
    pub fn is_new_day(&self, current_ts: i64) -> bool {
        current_ts >= self.last_distribution_ts + crate::constants::SECONDS_PER_DAY
    }
    
    /// Reset for a new day
    pub fn start_new_day(&mut self, current_ts: i64) {
        self.last_distribution_ts = current_ts;
        self.current_day_claimed = 0;
        self.current_day_distributed_investors = 0;
        self.current_day_distributed_creator = 0;
        self.carry_over_dust = 0;
        self.pagination_cursor = 0;
        self.day_completed = false;
    }
}

/// Represents a single investor in the distribution
/// This is passed as remaining accounts, not stored on-chain
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InvestorDistributionEntry {
    /// Investor's quote token ATA
    pub investor_quote_ata: Pubkey,
    /// Streamflow stream account
    pub stream_account: Pubkey,
}