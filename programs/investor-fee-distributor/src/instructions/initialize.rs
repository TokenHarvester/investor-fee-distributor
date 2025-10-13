use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::{constants::*, errors::FeeDistributorError, state::*};

/// Initialize the honorary fee position and distribution policy
#[derive(Accounts)]
#[instruction(total_investor_allocation: u64, investor_fee_share_bps: u16)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// The vault identifier (arbitrary key to scope this distribution)
    /// CHECK: Used only as a seed for PDAs
    pub vault: UncheckedAccount<'info>,
    
    /// Quote token mint (must match pool configuration)
    pub quote_mint: Account<'info, Mint>,
    
    /// Creator wallet that will receive remainder fees
    /// CHECK: Creator's wallet pubkey, validated by authority
    pub creator_wallet: UncheckedAccount<'info>,
    
    /// Distribution policy PDA
    #[account(
        init,
        payer = authority,
        space = DistributionPolicy::LEN,
        seeds = [VAULT_SEED, vault.key().as_ref(), POLICY_SEED],
        bump
    )]
    pub policy: Account<'info, DistributionPolicy>,
    
    /// Distribution progress PDA
    #[account(
        init,
        payer = authority,
        space = DistributionProgress::LEN,
        seeds = [VAULT_SEED, vault.key().as_ref(), PROGRESS_SEED],
        bump
    )]
    pub progress: Account<'info, DistributionProgress>,
    
    /// Program's quote token treasury (PDA owned ATA)
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, vault.key().as_ref(), TREASURY_SEED],
        bump,
        token::mint = quote_mint,
        token::authority = treasury_authority
    )]
    pub treasury: Account<'info, TokenAccount>,
    
    /// Treasury authority PDA
    /// CHECK: PDA that will own the treasury
    #[account(
        seeds = [VAULT_SEED, vault.key().as_ref(), INVESTOR_FEE_POS_OWNER_SEED],
        bump
    )]
    pub treasury_authority: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    total_investor_allocation: u64,
    investor_fee_share_bps: u16,
    daily_cap_lamports: u64,
    min_payout_lamports: u64,
    total_investors: u32,
) -> Result<()> {
    // Validate basis points
    require!(
        investor_fee_share_bps <= crate::constants::BASIS_POINTS_DIVISOR as u16,
        FeeDistributorError::InvalidBasisPoints
    );
    
    // Initialize policy
    let policy = &mut ctx.accounts.policy;
    policy.vault = ctx.accounts.vault.key();
    policy.quote_mint = ctx.accounts.quote_mint.key();
    policy.creator_wallet = ctx.accounts.creator_wallet.key();
    policy.total_investor_allocation = total_investor_allocation;
    policy.investor_fee_share_bps = investor_fee_share_bps;
    policy.daily_cap_lamports = daily_cap_lamports;
    policy.min_payout_lamports = min_payout_lamports;
    policy.bump = ctx.bumps.policy;
    
    // Initialize progress
    let progress = &mut ctx.accounts.progress;
    progress.vault = ctx.accounts.vault.key();
    progress.last_distribution_ts = 0; // Allow immediate first distribution
    progress.current_day_claimed = 0;
    progress.current_day_distributed_investors = 0;
    progress.current_day_distributed_creator = 0;
    progress.carry_over_dust = 0;
    progress.pagination_cursor = 0;
    progress.day_completed = false;
    progress.total_investors = total_investors;
    progress.bump = ctx.bumps.progress;
    
    emit!(HonoraryPositionInitialized {
        vault: ctx.accounts.vault.key(),
        quote_mint: ctx.accounts.quote_mint.key(),
        treasury: ctx.accounts.treasury.key(),
        treasury_authority: ctx.accounts.treasury_authority.key(),
        total_investor_allocation,
        investor_fee_share_bps,
    });
    
    Ok(())
}

#[event]
pub struct HonoraryPositionInitialized {
    pub vault: Pubkey,
    pub quote_mint: Pubkey,
    pub treasury: Pubkey,
    pub treasury_authority: Pubkey,
    pub total_investor_allocation: u64,
    pub investor_fee_share_bps: u16,
}