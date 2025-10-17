use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("4uZxW8UrmijWukHwDShTqwc8EyhQxJ5rxaijnVXKbZaF");

#[program]
pub mod investor_fee_distributor {
    use super::*;

    /// Initialize the honorary fee position and distribution policy
    pub fn initialize(
        ctx: Context<Initialize>,
        total_investor_allocation: u64,
        investor_fee_share_bps: u16,
        daily_cap_lamports: u64,
        min_payout_lamports: u64,
        total_investors: u32,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            total_investor_allocation,
            investor_fee_share_bps,
            daily_cap_lamports,
            min_payout_lamports,
            total_investors,
        )
    }

    /// Distribute fees to investors - paginated and permissionless
    pub fn distribute_fees<'info>(
        ctx: Context<'_, '_, 'info, 'info, DistributeFees<'info>>,
        page_size: u8,
    ) -> Result<()> {
        instructions::distribute::handler(ctx, page_size)
    }
}