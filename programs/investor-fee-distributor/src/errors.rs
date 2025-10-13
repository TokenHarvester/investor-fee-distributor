use anchor_lang::prelude::*;

#[error_code]
pub enum FeeDistributorError {
    #[msg("Base token fees detected - only quote token fees allowed")]
    BaseFeesNotAllowed,
    
    #[msg("Invalid pool configuration - cannot guarantee quote-only fees")]
    InvalidPoolConfiguration,
    
    #[msg("Quote mint validation failed")]
    InvalidQuoteMint,
    
    #[msg("Cannot distribute - must wait 24 hours since last distribution")]
    TooSoonToDistribute,
    
    #[msg("Distribution for this day already completed")]
    DayAlreadyCompleted,
    
    #[msg("Pagination cursor out of bounds")]
    InvalidPaginationCursor,
    
    #[msg("Arithmetic overflow in fee calculation")]
    ArithmeticOverflow,
    
    #[msg("Total locked amount is zero - no investors to distribute to")]
    NoLockedTokens,
    
    #[msg("Invalid investor page size - exceeds maximum")]
    InvalidPageSize,
    
    #[msg("Daily cap exceeded")]
    DailyCapExceeded,
    
    #[msg("Streamflow stream account invalid or not locked")]
    InvalidStreamAccount,
    
    #[msg("Investor ATA does not match expected quote mint")]
    InvalidInvestorATA,
    
    #[msg("Not the first page of the day - cannot claim fees")]
    NotFirstPage,
    
    #[msg("Must complete previous page before starting new one")]
    PaginationNotSequential,
    
    #[msg("Invalid basis points value - must be <= 10000")]
    InvalidBasisPoints,
}