# Investor Fee Distributor

A Solana program for managing an honorary DAMM v2 LP position that accrues quote-only fees and distributes them to investors based on still-locked tokens (from Streamflow) with a permissionless 24-hour crank mechanism.

[![Solana](https://img.shields.io/badge/Solana-Program-blueviolet?logo=solana)](https://solana.com/)
[![Anchor](https://img.shields.io/badge/Anchor-0.30.1-purple)](https://www.anchor-lang.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🎯 Overview

This program enables decentralized fee distribution for token launches on Solana:

- **Honorary Position**: A DAMM v2 LP position owned by program PDA that accrues fees exclusively in the quote token
- **24h Distribution Crank**: Permissionless, paginated fee distribution mechanism
- **Pro-rata Distribution**: Fees split between investors (based on locked tokens) and creator
- **Quote-Only Enforcement**: System fails deterministically if base token fees are detected

Built for **[Star](https://star.new)** - a fundraising platform for ambitious startups and founders.

## ✨ Features

- ⚡ **Permissionless Crank**: Anyone can trigger fee distribution once per 24 hours
- 📄 **Paginated Distribution**: Handle 100+ investors efficiently with pagination
- 🔒 **Quote-Only Safety**: Validates that only quote token fees are distributed
- 💎 **Dust Management**: Tracks and carries over small amounts across pages
- 📊 **Pro-rata Calculation**: Fair distribution based on still-locked percentages
- 🎯 **Daily Caps**: Optional rate limiting for controlled distributions
- 🔄 **Idempotent**: Safe to retry failed pages without double-payment
- 📡 **Event Emission**: Complete audit trail via Solana events

## 🏗️ Architecture

### Key Components

```
┌─────────────────────────────────────────────────┐
│           Investor Fee Distributor              │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────┐        ┌──────────────┐       │
│  │  Initialize  │───────▶│   Policy     │      │
│  │ Instruction  │        │   Account    │       │
│  └──────────────┘        └──────────────┘       │
│                                                 │
│  ┌──────────────┐        ┌──────────────┐       │
│  │  Distribute  │───────▶│  Progress    │      │
│  │ Instruction  │        │   Account    │       │
│  └──────────────┘        └──────────────┘       │
│                                                 │
│  ┌──────────────┐        ┌──────────────┐       │
│  │   Treasury   │◀──────▶│ DAMM v2 Pool │      │
│  │  (PDA-owned) │        │  (Honorary)  │       │
│  └──────────────┘        └──────────────┘       │
│                                                 │
│  ┌──────────────┐        ┌──────────────┐       │
│  │  Streamflow  │───────▶│  Investors   │      │
│  │   Streams    │        │  (Pro-rata)  │       │
│  └──────────────┘        └──────────────┘       │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Distribution Formula

```rust
locked_total(t) = Σ locked_i(t)  // Sum of all locked tokens
f_locked(t) = locked_total(t) / Y0  // Locked fraction
eligible_bps = min(investor_fee_share_bps, floor(f_locked(t) * 10000))
investor_fee_quote = floor(claimed_quote * eligible_bps / 10000)

// Per investor:
weight_i = locked_i(t) / locked_total(t)
payout_i = floor(investor_fee_quote * weight_i)

// Creator receives remainder:
creator_amount = claimed_quote - total_distributed_to_investors
```

## 🚀 Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (v1.76+)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (v1.18+)
- [Anchor](https://www.anchor-lang.com/docs/installation) (v0.30.1+)
- [Node.js](https://nodejs.org/) (v18+)

### Installation

```bash
# Clone the repository
git clone https://github.com/TokenHarvester/investor-fee-distributor.git
cd investor-fee-distributor

# Install dependencies
yarn install

# Build the program
anchor build

# Get the program ID
solana address -k target/deploy/investor_fee_distributor-keypair.json

# Update program ID in lib.rs and Anchor.toml with the generated ID

# Rebuild
anchor build

# Run tests
anchor test
```

## 📖 Usage

### Initialize Distribution

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { InvestorFeeDistributor } from "./target/types/investor_fee_distributor";

const program = anchor.workspace.InvestorFeeDistributor as Program<InvestorFeeDistributor>;

// Derive PDAs
const [policyPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), vault.toBuffer(), Buffer.from("policy")],
  program.programId
);

// Initialize
await program.methods
  .initialize(
    new anchor.BN(1_000_000_000_000), // total_investor_allocation (Y0)
    5000,                              // investor_fee_share_bps (50%)
    new anchor.BN(0),                  // daily_cap_lamports (0 = no cap)
    new anchor.BN(1_000_000),          // min_payout_lamports
    100                                // total_investors
  )
  .accounts({
    authority: wallet.publicKey,
    vault: vault.publicKey,
    quoteMint: quoteMint,
    creatorWallet: creator.publicKey,
    policy: policyPda,
    progress: progressPda,
    treasury: treasuryPda,
    treasuryAuthority: treasuryAuthorityPda,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

### Distribute Fees (Paginated)

```typescript
const PAGE_SIZE = 20; // Process 20 investors per transaction

for (let page = 0; page < totalPages; page++) {
  const pageInvestors = allInvestors.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  
  // Build remaining accounts (investor ATAs + stream accounts)
  const remainingAccounts = [];
  for (const investor of pageInvestors) {
    remainingAccounts.push(
      { pubkey: investor.quoteAta, isSigner: false, isWritable: true },
      { pubkey: investor.streamAccount, isSigner: false, isWritable: false }
    );
  }
  
  // Execute distribution
  await program.methods
    .distributeFees(pageInvestors.length)
    .accounts({
      caller: wallet.publicKey,
      vault: vault.publicKey,
      policy: policyPda,
      progress: progressPda,
      quoteMint: quoteMint,
      treasury: treasuryPda,
      treasuryAuthority: treasuryAuthorityPda,
      creatorQuoteAta: creatorQuoteAta,
      creatorWallet: creator.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .rpc();
}
```

## 🧪 Testing

```bash
# Run all tests
anchor test

# Run with detailed output
anchor test -- --nocapture

# Run specific test file
anchor test tests/investor-fee-distributor.ts
```

### Test Coverage

- ✅ Initialize distribution policy
- ✅ Simulate fee accrual
- ✅ Paginated distribution (10 investors across 2 pages)
- ✅ 24h gating enforcement
- ✅ Quote-only validation
- ✅ Edge cases (dust, caps, minimum payouts)
- ✅ Error handling

## 📋 Program Instructions

### `initialize`

Sets up the distribution system with policy parameters.

**Arguments:**
- `total_investor_allocation` - Y0: Total investor allocation minted at TGE
- `investor_fee_share_bps` - Maximum investor share (0-10000 basis points)
- `daily_cap_lamports` - Optional daily distribution cap (0 = no cap)
- `min_payout_lamports` - Minimum payout to avoid dust transfers
- `total_investors` - Total number of investors

### `distribute_fees`

Executes paginated fee distribution (permissionless, once per 24h).

**Arguments:**
- `page_size` - Number of investors to process (1-50)

**Remaining Accounts:** Pairs of `[investor_quote_ata, stream_account]` for each investor in the page.

## 🔐 Security

- **Checked Arithmetic**: All calculations use checked math to prevent overflows
- **PDA Validation**: All PDAs properly seeded and verified
- **Quote-Only Enforcement**: Fails deterministically if base fees detected
- **Reentrancy Protection**: State updated before external transfers
- **Idempotent Design**: Safe to retry failed transactions

## 🔧 Integration Requirements

### DAMM v2 Integration

The program includes placeholder functions that need implementation:

**Location:** `programs/investor-fee-distributor/src/instructions/distribute.rs`

```rust
fn claim_fees_from_damm<'info>(
    ctx: &Context<DistributeFees<'info>>,
) -> Result<u64> {
    // TODO: Implement actual DAMM v2 CPI
    // 1. Call DAMM's collect_fees instruction
    // 2. Verify no base token fees
    // 3. Return quote token amount
}
```

### Streamflow Integration

```rust
fn read_streamflow_locked_amount(
    stream_account: &AccountInfo,
    current_ts: i64,
) -> Result<u64> {
    // TODO: Parse actual Streamflow account structure
    // Return still-locked amount at current_ts
}
```

## 📊 Events

The program emits events for monitoring and auditing:

```rust
pub struct HonoraryPositionInitialized {
    pub vault: Pubkey,
    pub quote_mint: Pubkey,
    pub treasury: Pubkey,
    pub treasury_authority: Pubkey,
    pub total_investor_allocation: u64,
    pub investor_fee_share_bps: u16,
}

pub struct QuoteFeesClaimed {
    pub amount: u64,
    pub timestamp: i64,
}

pub struct InvestorPayoutPage {
    pub page_start: u32,
    pub page_end: u32,
    pub investors_paid: u8,
    pub total_amount: u64,
}

pub struct CreatorPayoutDayClosed {
    pub creator: Pubkey,
    pub amount: u64,
    pub day_timestamp: i64,
}
```

## 🐛 Error Codes

| Code | Error | Description |
|------|-------|-------------|
| 6000 | `BaseFeesNotAllowed` | Base token fees detected |
| 6001 | `InvalidPoolConfiguration` | Cannot guarantee quote-only fees |
| 6002 | `InvalidQuoteMint` | Quote mint validation failed |
| 6003 | `TooSoonToDistribute` | Must wait 24 hours |
| 6004 | `DayAlreadyCompleted` | Distribution already completed |
| 6005 | `InvalidPaginationCursor` | Cursor out of bounds |
| 6006 | `ArithmeticOverflow` | Overflow in calculation |
| 6007 | `NoLockedTokens` | No investors to distribute to |
| 6008 | `InvalidPageSize` | Page size exceeds maximum (50) |
| 6009 | `DailyCapExceeded` | Daily cap reached |
| 6010 | `InvalidStreamAccount` | Streamflow account invalid |
| 6011 | `InvalidInvestorATA` | ATA doesn't match quote mint |
| 6012 | `NotFirstPage` | Can't claim fees on non-first page |
| 6013 | `PaginationNotSequential` | Must complete previous page |
| 6014 | `InvalidBasisPoints` | Basis points must be ≤ 10000 |

## 📚 Documentation

- [Complete Documentation](./README.md) - Full usage guide

## 🛠️ Development

### Project Structure

```
investor-fee-distributor/
├── programs/
│   └── investor-fee-distributor/
│       └── src/
│           ├── lib.rs              # Program entry point
│           ├── state.rs            # Account structures
│           ├── errors.rs           # Error definitions
│           ├── constants.rs        # Constants and seeds
│           └── instructions/
│               ├── initialize.rs   # Setup instruction
│               └── distribute.rs   # Distribution crank
├── tests/
│   └── investor-fee-distributor.ts # Test suite
├── scripts/
│   └── example-distribution.ts     # Example usage
└── target/
    └── types/
        └── investor_fee_distributor.ts # TypeScript types
```

### Build Commands

```bash
# Build
anchor build

# Test
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Deploy to mainnet
anchor deploy --provider.cluster mainnet-beta

# Clean
anchor clean
```

## 🚢 Deployment

### Devnet

```bash
solana config set --url devnet
anchor build
anchor deploy --provider.cluster devnet
```

### Mainnet

⚠️ **Important:** Complete security audit before mainnet deployment!

```bash
solana config set --url mainnet-beta
anchor build --verifiable
anchor deploy --provider.cluster mainnet-beta
```

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License.
