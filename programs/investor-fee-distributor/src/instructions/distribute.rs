use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::{constants::*, errors::FeeDistributorError, state::*};

/// Distribute fees from honorary position - paginated
#[derive(Accounts)]
pub struct DistributeFees<'info> {
    /// Permissionless caller
    #[account(mut)]
    pub caller: Signer<'info>,
    
    /// The vault identifier
    /// CHECK: Used only for PDA derivation
    pub vault: UncheckedAccount<'info>,
    
    /// Distribution policy
    #[account(
        seeds = [VAULT_SEED, vault.key().as_ref(), POLICY_SEED],
        bump = policy.bump,
        has_one = vault,
        has_one = quote_mint,
        has_one = creator_wallet,
    )]
    pub policy: Account<'info, DistributionPolicy>,
    
    /// Distribution progress tracker
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.key().as_ref(), PROGRESS_SEED],
        bump = progress.bump,
        has_one = vault,
    )]
    pub progress: Account<'info, DistributionProgress>,
    
    /// Quote token mint
    pub quote_mint: Account<'info, Mint>,
    
    /// Program's quote treasury
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.key().as_ref(), TREASURY_SEED],
        bump,
        token::mint = quote_mint,
        token::authority = treasury_authority,
    )]
    pub treasury: Account<'info, TokenAccount>,
    
    /// Treasury authority PDA
    /// CHECK: PDA that owns the treasury
    #[account(
        seeds = [VAULT_SEED, vault.key().as_ref(), INVESTOR_FEE_POS_OWNER_SEED],
        bump
    )]
    pub treasury_authority: UncheckedAccount<'info>,
    
    /// Creator's quote token account (receives remainder)
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = creator_wallet,
    )]
    pub creator_quote_ata: Account<'info, TokenAccount>,
    
    /// Creator wallet
    /// CHECK: Validated in policy
    pub creator_wallet: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    
    // Remaining accounts (passed dynamically):
    // For each investor in this page:
    //   1. investor_quote_ata (mut, TokenAccount)
    //   2. stream_account (Streamflow stream)
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DistributeFees<'info>>,
    page_size: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    let current_ts = clock.unix_timestamp;
    
    // Validate page size
    require!(
        page_size > 0 && page_size <= MAX_PAGE_SIZE,
        FeeDistributorError::InvalidPageSize
    );
    
    // Check if this is a new day
    let is_new_day = ctx.accounts.progress.is_new_day(current_ts);
    
    if is_new_day {
        // First page of new day
        require!(
            ctx.accounts.progress.pagination_cursor == 0,
            FeeDistributorError::NotFirstPage
        );
        
        // Claim fees from DAMM v2 position (simulated here)
        let claimed_amount = claim_fees_from_damm(&ctx)?;
        
        // Start new day
        ctx.accounts.progress.start_new_day(current_ts);
        ctx.accounts.progress.current_day_claimed = claimed_amount;
        
        emit!(QuoteFeesClaimed {
            amount: claimed_amount,
            timestamp: current_ts,
        });
    } else {
        // Not a new day - validate we can continue pagination
        require!(
            !ctx.accounts.progress.day_completed,
            FeeDistributorError::DayAlreadyCompleted
        );
        
        require!(
            current_ts >= ctx.accounts.progress.last_distribution_ts,
            FeeDistributorError::TooSoonToDistribute
        );
    }
    
    // Calculate pagination bounds
    let start_idx = ctx.accounts.progress.pagination_cursor as usize;
    let end_idx = std::cmp::min(
        start_idx + page_size as usize,
        ctx.accounts.progress.total_investors as usize
    );
    
    require!(
        start_idx < ctx.accounts.progress.total_investors as usize,
        FeeDistributorError::InvalidPaginationCursor
    );
    
    // Process this page of investors
    let investor_accounts = &ctx.remaining_accounts[0..(end_idx - start_idx) * 2];
    
    let distribution_result = distribute_to_investors(
        &ctx,
        investor_accounts,
        start_idx,
        end_idx,
        current_ts,
    )?;
    
    // Update progress
    ctx.accounts.progress.current_day_distributed_investors = ctx.accounts.progress
        .current_day_distributed_investors
        .checked_add(distribution_result.total_distributed)
        .ok_or(FeeDistributorError::ArithmeticOverflow)?;
    
    ctx.accounts.progress.carry_over_dust = distribution_result.remaining_dust;
    ctx.accounts.progress.pagination_cursor = end_idx as u32;
    
    emit!(InvestorPayoutPage {
        page_start: start_idx as u32,
        page_end: end_idx as u32,
        investors_paid: distribution_result.investors_paid,
        total_amount: distribution_result.total_distributed,
    });
    
    // Check if this is the last page
    if end_idx >= ctx.accounts.progress.total_investors as usize {
        // Distribute remainder to creator
        let remainder = distribute_remainder_to_creator(&ctx)?;
        
        ctx.accounts.progress.current_day_distributed_creator = remainder;
        ctx.accounts.progress.day_completed = true;
        
        emit!(CreatorPayoutDayClosed {
            creator: ctx.accounts.policy.creator_wallet,
            amount: remainder,
            day_timestamp: current_ts,
        });
    }
    
    Ok(())
}

struct DistributionResult {
    total_distributed: u64,
    remaining_dust: u64,
    investors_paid: u8,
}

fn distribute_to_investors<'info>(
    ctx: &Context<'_, '_, '_, 'info, DistributeFees<'info>>,
    investor_accounts: &'info [AccountInfo<'info>],
    _start_idx: usize,
    _end_idx: usize,
    current_ts: i64,
) -> Result<DistributionResult> {
    let policy = &ctx.accounts.policy;
    let progress = &ctx.accounts.progress;
    
    // Calculate total locked amount across all investors in this page
    let mut locked_amounts: Vec<u64> = Vec::new();
    let mut total_locked: u64 = 0;
    
    // Parse investor accounts (pairs of ATA and Stream)
    for i in (0..investor_accounts.len()).step_by(2) {
        let _investor_ata = &investor_accounts[i];
        let stream_account = &investor_accounts[i + 1];
        
        // Read locked amount from Streamflow
        let locked = read_streamflow_locked_amount(stream_account, current_ts)?;
        locked_amounts.push(locked);
        
        total_locked = total_locked
            .checked_add(locked)
            .ok_or(FeeDistributorError::ArithmeticOverflow)?;
    }
    
    // If no locked tokens, skip distribution
    if total_locked == 0 {
        return Ok(DistributionResult {
            total_distributed: 0,
            remaining_dust: progress.carry_over_dust,
            investors_paid: 0,
        });
    }
    
    // Calculate investor share based on locked percentage
    let f_locked = calculate_locked_fraction(total_locked, policy.total_investor_allocation)?;
    let eligible_bps = std::cmp::min(
        policy.investor_fee_share_bps as u64,
        f_locked,
    );
    
    // Calculate total investor allocation for this distribution
    let investor_fee_quote = progress
        .current_day_claimed
        .checked_mul(eligible_bps)
        .ok_or(FeeDistributorError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(FeeDistributorError::ArithmeticOverflow)?;
    
    // Check daily cap
    let remaining_cap = if policy.daily_cap_lamports > 0 {
        policy
            .daily_cap_lamports
            .saturating_sub(progress.current_day_distributed_investors)
    } else {
        u64::MAX
    };
    
    let distributable = std::cmp::min(investor_fee_quote, remaining_cap);
    let mut available = distributable + progress.carry_over_dust;
    
    // Distribute pro-rata to investors
    let vault_key = ctx.accounts.vault.key();
    let treasury_authority_bump = ctx.bumps.treasury_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        vault_key.as_ref(),
        INVESTOR_FEE_POS_OWNER_SEED,
        &[treasury_authority_bump],
    ]];
    
    let mut total_distributed = 0u64;
    let mut investors_paid = 0u8;
    
    for (i, locked) in locked_amounts.iter().enumerate() {
        if *locked == 0 {
            continue;
        }
        
        // Calculate this investor's share
        let weight = (*locked as u128)
            .checked_mul(BASIS_POINTS_DIVISOR as u128)
            .ok_or(FeeDistributorError::ArithmeticOverflow)?
            .checked_div(total_locked as u128)
            .ok_or(FeeDistributorError::ArithmeticOverflow)? as u64;
        
        let payout = (distributable as u128)
            .checked_mul(weight as u128)
            .ok_or(FeeDistributorError::ArithmeticOverflow)?
            .checked_div(BASIS_POINTS_DIVISOR as u128)
            .ok_or(FeeDistributorError::ArithmeticOverflow)? as u64;
        
        // Check minimum payout threshold
        if payout < policy.min_payout_lamports {
            continue;
        }
        
        if payout > available {
            break;
        }
        
        // Transfer to investor
        let investor_ata = &investor_accounts[i * 2];
        
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: investor_ata.to_account_info(),
                    authority: ctx.accounts.treasury_authority.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;
        
        available = available.saturating_sub(payout);
        total_distributed = total_distributed
            .checked_add(payout)
            .ok_or(FeeDistributorError::ArithmeticOverflow)?;
        investors_paid += 1;
    }
    
    Ok(DistributionResult {
        total_distributed,
        remaining_dust: available,
        investors_paid,
    })
}

fn distribute_remainder_to_creator<'info>(
    ctx: &Context<'_, '_, '_, 'info, DistributeFees<'info>>,
) -> Result<u64> {
    let progress = &ctx.accounts.progress;
    let treasury_balance = ctx.accounts.treasury.amount;
    
    if treasury_balance == 0 {
        return Ok(0);
    }
    
    let vault_key = ctx.accounts.vault.key();
    let treasury_authority_bump = ctx.bumps.treasury_authority;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        vault_key.as_ref(),
        INVESTOR_FEE_POS_OWNER_SEED,
        &[treasury_authority_bump],
    ]];
    
    // Calculate remainder (claimed - distributed to investors)
    let remainder = progress
        .current_day_claimed
        .saturating_sub(progress.current_day_distributed_investors);
    
    let transfer_amount = std::cmp::min(remainder, treasury_balance);
    
    if transfer_amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.creator_quote_ata.to_account_info(),
                    authority: ctx.accounts.treasury_authority.to_account_info(),
                },
                signer_seeds,
            ),
            transfer_amount,
        )?;
    }
    
    Ok(transfer_amount)
}

fn calculate_locked_fraction(locked_total: u64, y0: u64) -> Result<u64> {
    if y0 == 0 {
        return Ok(0);
    }
    
    // f_locked = (locked_total / y0) * 10000
    let fraction = (locked_total as u128)
        .checked_mul(BASIS_POINTS_DIVISOR as u128)
        .ok_or(FeeDistributorError::ArithmeticOverflow)?
        .checked_div(y0 as u128)
        .ok_or(FeeDistributorError::ArithmeticOverflow)? as u64;
    
    Ok(std::cmp::min(fraction, BASIS_POINTS_DIVISOR))
}

fn read_streamflow_locked_amount(
    stream_account: &AccountInfo,
    _current_ts: i64,
) -> Result<u64> {
    // PLACEHOLDER: Parse Streamflow account data
    // In production, you need Streamflow's account structure
    // For now, we'll simulate by reading a u64 at offset 8
    
    let data = stream_account.try_borrow_data()?;
    
    if data.len() < 16 {
        return Err(FeeDistributorError::InvalidStreamAccount.into());
    }
    
    // This is a placeholder - actual Streamflow parsing needed
    let locked = u64::from_le_bytes(
        data[8..16]
            .try_into()
            .map_err(|_| FeeDistributorError::InvalidStreamAccount)?
    );
    
    Ok(locked)
}

fn claim_fees_from_damm<'info>(
    ctx: &Context<'_, '_, '_, 'info, DistributeFees<'info>>,
) -> Result<u64> {
    // PLACEHOLDER: Call actual DAMM v2 claim instruction
    // This would be a CPI to the DAMM program
    
    // For testing, we'll simulate by checking treasury balance
    let current_balance = ctx.accounts.treasury.amount;
    
    // In production, you'd:
    // 1. Call DAMM v2's collect_fees instruction
    // 2. Verify no base token fees were claimed
    // 3. Return the quote token amount claimed
    
    Ok(current_balance)
}

#[event]
pub struct QuoteFeesClaimed {
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct InvestorPayoutPage {
    pub page_start: u32,
    pub page_end: u32,
    pub investors_paid: u8,
    pub total_amount: u64,
}

#[event]
pub struct CreatorPayoutDayClosed {
    pub creator: Pubkey,
    pub amount: u64,
    pub day_timestamp: i64,
}