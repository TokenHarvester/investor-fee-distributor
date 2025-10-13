import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { InvestorFeeDistributor } from "../target/types/investor_fee_distributor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";

// Configuration
const CLUSTER = "localnet"; // Change to "devnet" or "mainnet-beta" for production
const RPC_URL = CLUSTER === "localnet" 
  ? "http://127.0.0.1:8899" 
  : `https://api.${CLUSTER}.solana.com`;

// Distribution parameters
const TOTAL_INVESTOR_ALLOCATION = 1_000_000 * LAMPORTS_PER_SOL;
const INVESTOR_FEE_SHARE_BPS = 5000; // 50%
const DAILY_CAP_LAMPORTS = 0; // No cap
const MIN_PAYOUT_LAMPORTS = 1_000_000; // 0.001 SOL equivalent
const NUM_INVESTORS = 20;
const PAGE_SIZE = 10;

// Seeds
const VAULT_SEED = Buffer.from("vault");
const POLICY_SEED = Buffer.from("policy");
const PROGRESS_SEED = Buffer.from("progress");
const TREASURY_SEED = Buffer.from("treasury");
const INVESTOR_FEE_POS_OWNER_SEED = Buffer.from("investor_fee_pos_owner");

interface Investor {
  keypair: Keypair;
  quoteAta: PublicKey;
  streamAccount: Keypair;
  lockedAmount: number;
}

class DistributionManager {
  private program: Program<InvestorFeeDistributor>;
  private connection: Connection;
  private payer: Keypair;
  
  private vault: Keypair;
  private quoteMint: PublicKey;
  private creator: Keypair;
  private creatorQuoteAta: PublicKey;
  
  private policyPda: PublicKey;
  private progressPda: PublicKey;
  private treasuryPda: PublicKey;
  private treasuryAuthorityPda: PublicKey;
  
  private investors: Investor[] = [];
  
  constructor(
    program: Program<InvestorFeeDistributor>,
    connection: Connection,
    payer: Keypair
  ) {
    this.program = program;
    this.connection = connection;
    this.payer = payer;
  }
  
  async setup() {
    console.log("\n📦 Setting up distribution system...\n");
    
    // Create vault identifier
    this.vault = Keypair.generate();
    console.log("✓ Vault:", this.vault.publicKey.toBase58());
    
    // Create quote mint
    this.quoteMint = await createMint(
      this.connection,
      this.payer,
      this.payer.publicKey,
      null,
      9
    );
    console.log("✓ Quote Mint:", this.quoteMint.toBase58());
    
    // Create creator
    this.creator = Keypair.generate();
    
    // Airdrop to creator
    if (CLUSTER === "localnet") {
      const sig = await this.connection.requestAirdrop(
        this.creator.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await this.connection.confirmTransaction(sig);
    }
    
    this.creatorQuoteAta = await createAccount(
      this.connection,
      this.payer,
      this.quoteMint,
      this.creator.publicKey
    );
    console.log("✓ Creator:", this.creator.publicKey.toBase58());
    console.log("✓ Creator ATA:", this.creatorQuoteAta.toBase58());
    
    // Derive PDAs
    [this.policyPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, this.vault.publicKey.toBuffer(), POLICY_SEED],
      this.program.programId
    );
    console.log("✓ Policy PDA:", this.policyPda.toBase58());
    
    [this.progressPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, this.vault.publicKey.toBuffer(), PROGRESS_SEED],
      this.program.programId
    );
    console.log("✓ Progress PDA:", this.progressPda.toBase58());
    
    [this.treasuryPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, this.vault.publicKey.toBuffer(), TREASURY_SEED],
      this.program.programId
    );
    console.log("✓ Treasury PDA:", this.treasuryPda.toBase58());
    
    [this.treasuryAuthorityPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, this.vault.publicKey.toBuffer(), INVESTOR_FEE_POS_OWNER_SEED],
      this.program.programId
    );
    console.log("✓ Treasury Authority PDA:", this.treasuryAuthorityPda.toBase58());
  }
  
  async createInvestors() {
    console.log(`\n👥 Creating ${NUM_INVESTORS} mock investors...\n`);
    
    for (let i = 0; i < NUM_INVESTORS; i++) {
      const keypair = Keypair.generate();
      
      // Airdrop for local testing
      if (CLUSTER === "localnet") {
        const sig = await this.connection.requestAirdrop(
          keypair.publicKey,
          LAMPORTS_PER_SOL
        );
        await this.connection.confirmTransaction(sig);
      }
      
      const quoteAta = await createAccount(
        this.connection,
        this.payer,
        this.quoteMint,
        keypair.publicKey
      );
      
      // Mock Streamflow account
      const streamAccount = Keypair.generate();
      
      // Simulate varying lock percentages (50% to 100%)
      const lockPercentage = 0.5 + Math.random() * 0.5;
      const lockedAmount = Math.floor(
        (TOTAL_INVESTOR_ALLOCATION / NUM_INVESTORS) * lockPercentage
      );
      
      this.investors.push({
        keypair,
        quoteAta,
        streamAccount,
        lockedAmount,
      });
      
      console.log(`  Investor ${i + 1}: ${(lockPercentage * 100).toFixed(2)}% locked`);
    }
    
    console.log("\n✓ All investors created");
  }
  
  async initialize() {
    console.log("\n🚀 Initializing distribution system...\n");
    
    const tx = await this.program.methods
      .initialize(
        new BN(TOTAL_INVESTOR_ALLOCATION),
        INVESTOR_FEE_SHARE_BPS,
        new BN(DAILY_CAP_LAMPORTS),
        new BN(MIN_PAYOUT_LAMPORTS),
        NUM_INVESTORS
      )
      .accounts({
        authority: this.payer.publicKey,
        vault: this.vault.publicKey,
        quoteMint: this.quoteMint,
        creatorWallet: this.creator.publicKey,
        policy: this.policyPda,
        progress: this.progressPda,
        treasury: this.treasuryPda,
        treasuryAuthority: this.treasuryAuthorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    
    console.log("✓ Initialization tx:", tx);
    
    // Verify initialization
    const policy = await this.program.account.distributionPolicy.fetch(this.policyPda);
    console.log("\n📋 Policy Configuration:");
    console.log("  Total Investor Allocation:", policy.totalInvestorAllocation.toString());
    console.log("  Investor Fee Share:", `${policy.investorFeeShareBps / 100}%`);
    console.log("  Daily Cap:", policy.dailyCapLamports.toString());
    console.log("  Min Payout:", policy.minPayoutLamports.toString());
  }
  
  async createMockStreamAccounts() {
    console.log("\n📝 Creating mock Streamflow accounts...\n");
    
    for (const investor of this.investors) {
      // Create account to simulate Streamflow stream
      const space = 128;
      const lamports = await this.connection.getMinimumBalanceForRentExemption(space);
      
      const createIx = SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: investor.streamAccount.publicKey,
        lamports,
        space,
        programId: SystemProgram.programId,
      });
      
      const tx = new anchor.web3.Transaction().add(createIx);
      await anchor.web3.sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.payer, investor.streamAccount]
      );
      
      // Write locked amount at offset 8 (mock Streamflow data structure)
      // In production, these would be real Streamflow stream accounts
    }
    
    console.log("✓ Mock stream accounts created");
  }
  
  async simulateFeeAccrual(amount: number) {
    console.log(`\n💰 Simulating fee accrual (${amount / LAMPORTS_PER_SOL} tokens)...\n`);
    
    await mintTo(
      this.connection,
      this.payer,
      this.quoteMint,
      this.treasuryPda,
      this.payer,
      amount
    );
    
    const treasuryAccount = await getAccount(this.connection, this.treasuryPda);
    console.log("✓ Treasury balance:", treasuryAccount.amount.toString());
  }
  
  async distributeFeesInPages() {
    console.log("\n🔄 Distributing fees (paginated)...\n");
    
    const numPages = Math.ceil(NUM_INVESTORS / PAGE_SIZE);
    
    for (let page = 0; page < numPages; page++) {
      const startIdx = page * PAGE_SIZE;
      const endIdx = Math.min(startIdx + PAGE_SIZE, NUM_INVESTORS);
      const pageInvestors = this.investors.slice(startIdx, endIdx);
      
      console.log(`\n📄 Page ${page + 1}/${numPages} (investors ${startIdx + 1}-${endIdx})`);
      
      // Build remaining accounts
      const remainingAccounts = [];
      for (const investor of pageInvestors) {
        remainingAccounts.push(
          {
            pubkey: investor.quoteAta,
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: investor.streamAccount.publicKey,
            isSigner: false,
            isWritable: false,
          }
        );
      }
      
      try {
        const tx = await this.program.methods
          .distributeFees(pageInvestors.length)
          .accounts({
            caller: this.payer.publicKey,
            vault: this.vault.publicKey,
            policy: this.policyPda,
            progress: this.progressPda,
            quoteMint: this.quoteMint,
            treasury: this.treasuryPda,
            treasuryAuthority: this.treasuryAuthorityPda,
            creatorQuoteAta: this.creatorQuoteAta,
            creatorWallet: this.creator.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(remainingAccounts)
          .rpc();
        
        console.log("  ✓ Transaction:", tx);
        
        // Get transaction details for compute units
        const txDetails = await this.connection.getTransaction(tx, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        
        if (txDetails?.meta?.computeUnitsConsumed) {
          console.log("  ✓ Compute units:", txDetails.meta.computeUnitsConsumed);
        }
        
      } catch (error) {
        console.error("  ✗ Error:", error);
        throw error;
      }
      
      // Small delay between pages
      if (page < numPages - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  async verifyDistribution() {
    console.log("\n✅ Verifying distribution results...\n");
    
    // Check progress
    const progress = await this.program.account.distributionProgress.fetch(this.progressPda);
    
    console.log("📊 Distribution Summary:");
    console.log("  Total Claimed:", progress.currentDayClaimed.toString());
    console.log("  Distributed to Investors:", progress.currentDayDistributedInvestors.toString());
    console.log("  Distributed to Creator:", progress.currentDayDistributedCreator.toString());
    console.log("  Day Completed:", progress.dayCompleted);
    console.log("  Pagination Cursor:", progress.paginationCursor);
    
    // Check creator balance
    const creatorBalance = await getAccount(this.connection, this.creatorQuoteAta);
    console.log("\n💵 Creator Balance:", creatorBalance.amount.toString());
    
    // Check some investor balances
    console.log("\n👥 Sample Investor Balances:");
    for (let i = 0; i < Math.min(3, this.investors.length); i++) {
      const investor = this.investors[i];
      const balance = await getAccount(this.connection, investor.quoteAta);
      console.log(`  Investor ${i + 1}: ${balance.amount.toString()} (${investor.lockedAmount.toString()} locked)`);
    }
    
    // Calculate percentages
    const totalDistributed = progress.currentDayDistributedInvestors.toNumber() + 
                           progress.currentDayDistributedCreator.toNumber();
    const investorPercentage = (progress.currentDayDistributedInvestors.toNumber() / totalDistributed * 100).toFixed(2);
    const creatorPercentage = (progress.currentDayDistributedCreator.toNumber() / totalDistributed * 100).toFixed(2);
    
    console.log("\n📈 Distribution Breakdown:");
    console.log(`  Investors: ${investorPercentage}%`);
    console.log(`  Creator: ${creatorPercentage}%`);
  }
  
  async listenToEvents() {
    console.log("\n👂 Listening to events...\n");
    
    // Listen to distribution events
    const subscriptionId = this.program.addEventListener(
      "InvestorPayoutPage",
      (event, slot) => {
        console.log(`\n[Event] Investor Payout Page (Slot ${slot}):`);
        console.log("  Page:", `${event.pageStart}-${event.pageEnd}`);
        console.log("  Investors Paid:", event.investorsPaid);
        console.log("  Total Amount:", event.totalAmount.toString());
      }
    );
    
    return subscriptionId;
  }
  
  async demonstrateFullCycle() {
    console.log("\n" + "=".repeat(60));
    console.log("🎯 INVESTOR FEE DISTRIBUTOR - FULL DEMONSTRATION");
    console.log("=".repeat(60));
    
    try {
      // Setup
      await this.setup();
      await this.createInvestors();
      await this.initialize();
      
      // Create mock Streamflow accounts
      await this.createMockStreamAccounts();
      
      // Simulate fee accrual (100 SOL worth)
      await this.simulateFeeAccrual(100 * LAMPORTS_PER_SOL);
      
      // Distribute fees
      await this.distributeFeesInPages();
      
      // Verify results
      await this.verifyDistribution();
      
      console.log("\n" + "=".repeat(60));
      console.log("✅ DEMONSTRATION COMPLETED SUCCESSFULLY");
      console.log("=".repeat(60) + "\n");
      
    } catch (error) {
      console.error("\n" + "=".repeat(60));
      console.error("❌ ERROR OCCURRED");
      console.error("=".repeat(60));
      console.error(error);
      throw error;
    }
  }
}

// Main execution
async function main() {
  // Setup provider
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(
    connection,
    wallet,
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  
  // Load program
  const program = anchor.workspace
    .InvestorFeeDistributor as Program<InvestorFeeDistributor>;
  
  console.log("\n🔗 Connected to:", CLUSTER);
  console.log("📝 Program ID:", program.programId.toBase58());
  console.log("👤 Payer:", provider.wallet.publicKey.toBase58());
  
  // Run demonstration
  const manager = new DistributionManager(
    program,
    connection,
    (provider.wallet as anchor.Wallet).payer
  );
  
  await manager.demonstrateFullCycle();
}

// Error handling
main()
  .then(() => {
    console.log("\n✨ Script completed successfully\n");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  });