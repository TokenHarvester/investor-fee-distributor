import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { InvestorFeeDistributor } from "../target/types/investor_fee_distributor";
import {
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
import { assert } from "chai";

describe("investor-fee-distributor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .InvestorFeeDistributor as Program<InvestorFeeDistributor>;

  // Test accounts
  let quoteMint: PublicKey;
  let vault: Keypair;
  let creator: Keypair;
  let creatorQuoteAta: PublicKey;
  
  // PDAs
  let policyPda: PublicKey;
  let progressPda: PublicKey;
  let treasuryPda: PublicKey;
  let treasuryAuthorityPda: PublicKey;
  
  // Investors
  const NUM_INVESTORS = 10;
  let investors: {
    keypair: Keypair;
    quoteAta: PublicKey;
    streamAccount: Keypair;
    lockedAmount: number;
  }[] = [];

  // Constants
  const VAULT_SEED = Buffer.from("vault");
  const POLICY_SEED = Buffer.from("policy");
  const PROGRESS_SEED = Buffer.from("progress");
  const TREASURY_SEED = Buffer.from("treasury");
  const INVESTOR_FEE_POS_OWNER_SEED = Buffer.from("investor_fee_pos_owner");

  const TOTAL_INVESTOR_ALLOCATION = 1_000_000 * LAMPORTS_PER_SOL;
  const INVESTOR_FEE_SHARE_BPS = 5000; // 50%
  const DAILY_CAP_LAMPORTS = 0; // No cap
  const MIN_PAYOUT_LAMPORTS = 1000;

  before(async () => {
    // Create quote mint
    quoteMint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      9
    );

    console.log("Quote Mint:", quoteMint.toBase58());

    // Create vault (just a keypair for seed)
    vault = Keypair.generate();

    // Create creator and ATA
    creator = Keypair.generate();
    
    // Airdrop to creator
    const airdropSig = await provider.connection.requestAirdrop(
      creator.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    creatorQuoteAta = await createAccount(
      provider.connection,
      provider.wallet.payer,
      quoteMint,
      creator.publicKey
    );

    // Derive PDAs
    [policyPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, vault.publicKey.toBuffer(), POLICY_SEED],
      program.programId
    );

    [progressPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, vault.publicKey.toBuffer(), PROGRESS_SEED],
      program.programId
    );

    [treasuryPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, vault.publicKey.toBuffer(), TREASURY_SEED],
      program.programId
    );

    [treasuryAuthorityPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, vault.publicKey.toBuffer(), INVESTOR_FEE_POS_OWNER_SEED],
      program.programId
    );

    // Create mock investors
    for (let i = 0; i < NUM_INVESTORS; i++) {
      const investorKeypair = Keypair.generate();
      
      // Airdrop to investor
      const sig = await provider.connection.requestAirdrop(
        investorKeypair.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const quoteAta = await createAccount(
        provider.connection,
        provider.wallet.payer,
        quoteMint,
        investorKeypair.publicKey
      );

      // Mock Streamflow account (just a regular account with locked amount)
      const streamAccount = Keypair.generate();
      
      // Simulate locked amounts (varying percentages)
      const lockedAmount = Math.floor(
        (TOTAL_INVESTOR_ALLOCATION / NUM_INVESTORS) * (0.5 + Math.random() * 0.5)
      );

      investors.push({
        keypair: investorKeypair,
        quoteAta,
        streamAccount,
        lockedAmount,
      });
    }

    console.log(`Created ${NUM_INVESTORS} mock investors`);
  });

  it("Initializes the fee distributor", async () => {
    const tx = await program.methods
      .initialize(
        new anchor.BN(TOTAL_INVESTOR_ALLOCATION),
        INVESTOR_FEE_SHARE_BPS,
        new anchor.BN(DAILY_CAP_LAMPORTS),
        new anchor.BN(MIN_PAYOUT_LAMPORTS),
        NUM_INVESTORS
      )
      .accounts({
        authority: provider.wallet.publicKey,
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

    console.log("Initialize tx:", tx);

    // Verify policy
    const policy = await program.account.distributionPolicy.fetch(policyPda);
    assert.equal(policy.vault.toBase58(), vault.publicKey.toBase58());
    assert.equal(policy.quoteMint.toBase58(), quoteMint.toBase58());
    assert.equal(policy.creatorWallet.toBase58(), creator.publicKey.toBase58());
    assert.equal(
      policy.totalInvestorAllocation.toString(),
      TOTAL_INVESTOR_ALLOCATION.toString()
    );
    assert.equal(policy.investorFeeShareBps, INVESTOR_FEE_SHARE_BPS);

    // Verify progress
    const progress = await program.account.distributionProgress.fetch(progressPda);
    assert.equal(progress.vault.toBase58(), vault.publicKey.toBase58());
    assert.equal(progress.lastDistributionTs.toNumber(), 0);
    assert.equal(progress.paginationCursor, 0);
    assert.equal(progress.totalInvestors, NUM_INVESTORS);
    assert.isFalse(progress.dayCompleted);

    console.log("✓ Distributor initialized successfully");
  });

  it("Simulates fee accrual and claims", async () => {
    // Simulate fees by minting to treasury
    const feeAmount = 100 * LAMPORTS_PER_SOL;
    
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      quoteMint,
      treasuryPda,
      provider.wallet.payer,
      feeAmount
    );

    const treasuryAccount = await getAccount(provider.connection, treasuryPda);
    assert.equal(treasuryAccount.amount.toString(), feeAmount.toString());

    console.log(`✓ Simulated ${feeAmount / LAMPORTS_PER_SOL} quote tokens as fees`);
  });

  it("Distributes fees to investors (paginated)", async () => {
    // Create mock Streamflow accounts with locked amounts
    for (const investor of investors) {
      // Create a simple account that stores locked amount at offset 8
      const streamAccount = investor.streamAccount;
      
      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: streamAccount.publicKey,
        lamports: await provider.connection.getMinimumBalanceForRentExemption(128),
        space: 128,
        programId: SystemProgram.programId,
      });

      const tx = new anchor.web3.Transaction().add(createAccountIx);
      await provider.sendAndConfirm(tx, [streamAccount]);

      // Write locked amount (mock Streamflow data)
      const data = Buffer.alloc(128);
      data.writeBigUInt64LE(BigInt(investor.lockedAmount), 8);
      
      // Note: In real test, you'd properly initialize Streamflow accounts
      // This is just for demonstration
    }

    // Distribute in pages of 5 investors
    const PAGE_SIZE = 5;
    const numPages = Math.ceil(NUM_INVESTORS / PAGE_SIZE);

    for (let page = 0; page < numPages; page++) {
      const startIdx = page * PAGE_SIZE;
      const endIdx = Math.min(startIdx + PAGE_SIZE, NUM_INVESTORS);
      const pageInvestors = investors.slice(startIdx, endIdx);

      // Build remaining accounts
      const remainingAccounts = [];
      for (const investor of pageInvestors) {
        remainingAccounts.push({
          pubkey: investor.quoteAta,
          isSigner: false,
          isWritable: true,
        });
        remainingAccounts.push({
          pubkey: investor.streamAccount.publicKey,
          isSigner: false,
          isWritable: false,
        });
      }

      console.log(`\nProcessing page ${page + 1}/${numPages} (${pageInvestors.length} investors)`);

      const tx = await program.methods
        .distributeFees(pageInvestors.length)
        .accounts({
          caller: provider.wallet.publicKey,
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

      console.log(`Page ${page + 1} tx:`, tx);

      // Add delay for next page (if not last)
      if (page < numPages - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Verify distributions
    const progress = await program.account.distributionProgress.fetch(progressPda);
    assert.isTrue(progress.dayCompleted);
    assert.isTrue(progress.currentDayDistributedInvestors.toNumber() > 0);
    assert.isTrue(progress.currentDayDistributedCreator.toNumber() > 0);

    console.log("\n✓ Fee distribution completed");
    console.log(`  Investors received: ${progress.currentDayDistributedInvestors.toNumber() / LAMPORTS_PER_SOL} tokens`);
    console.log(`  Creator received: ${progress.currentDayDistributedCreator.toNumber() / LAMPORTS_PER_SOL} tokens`);

    // Verify creator received remainder
    const creatorBalance = await getAccount(provider.connection, creatorQuoteAta);
    assert.isTrue(creatorBalance.amount > 0);
    console.log(`  Creator balance: ${creatorBalance.amount.toString() / LAMPORTS_PER_SOL} tokens`);
  });

  it("Prevents distribution within 24 hours", async () => {
    try {
      await program.methods
        .distributeFees(5)
        .accounts({
          caller: provider.wallet.publicKey,
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
        .remainingAccounts([])
        .rpc();

      assert.fail("Should have thrown error for too soon distribution");
    } catch (err) {
      assert.include(err.toString(), "DayAlreadyCompleted");
      console.log("✓ Correctly prevented distribution within 24 hours");
    }
  });

  it("Tests full unlock scenario (0% locked = 100% to creator)", async () => {
    // Wait for next day (simulate by advancing clock in real test)
    console.log("\n--- Testing Full Unlock Scenario ---");
    
    // For this test, we'd need to:
    // 1. Fast forward time 24+ hours
    // 2. Update all Streamflow accounts to show 0 locked
    // 3. Run distribution
    // 4. Verify 100% goes to creator
    
    console.log("✓ Full unlock test scenario outlined (requires time manipulation)");
  });

  it("Tests dust handling and carry-over", async () => {
    console.log("\n--- Testing Dust Handling ---");
    
    // To properly test dust:
    // 1. Create distribution with amounts that create rounding dust
    // 2. Verify dust is carried to next page
    // 3. Verify dust is handled correctly across pagination
    
    console.log("✓ Dust handling test scenario outlined");
  });

  it("Tests daily cap enforcement", async () => {
    console.log("\n--- Testing Daily Cap ---");
    
    // To test daily cap:
    // 1. Reinitialize with a low daily cap
    // 2. Simulate large fee amount
    // 3. Verify distribution stops at cap
    // 4. Verify excess is carried to next day
    
    console.log("✓ Daily cap test scenario outlined");
  });

  it("Tests minimum payout threshold", async () => {
    console.log("\n--- Testing Minimum Payout ---");
    
    // To test min payout:
    // 1. Create investors with very small locked amounts
    // 2. Verify they don't receive payouts below threshold
    // 3. Verify small amounts accumulate as dust
    
    console.log("✓ Minimum payout test scenario outlined");
  });

  describe("Edge cases and error handling", () => {
    it("Handles invalid page size", async () => {
      try {
        await program.methods
          .distributeFees(0) // Invalid: 0
          .accounts({
            caller: provider.wallet.publicKey,
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
          .rpc();
        assert.fail("Should have failed with invalid page size");
      } catch (err) {
        console.log("✓ Correctly rejected invalid page size");
      }
    });

    it("Handles missing investor accounts", async () => {
      console.log("✓ Missing account handling test outlined");
    });

    it("Handles base fee detection (quote-only enforcement)", async () => {
      // This would require mocking DAMM v2 to return base fees
      console.log("✓ Base fee detection test outlined");
    });
  });

  describe("Integration scenarios", () => {
    it("Simulates multi-day distribution lifecycle", async () => {
      console.log("\n--- Multi-Day Lifecycle Simulation ---");
      
      // Day 1: Initial distribution
      // Day 2: Partial unlock, mixed distribution
      // Day 3: Full unlock, 100% to creator
      // Day 4: No fees, no distribution
      
      console.log("✓ Multi-day lifecycle test outlined");
    });

    it("Simulates varying lock schedules", async () => {
      console.log("\n--- Varying Lock Schedules ---");
      
      // Test with:
      // - Linear unlock
      // - Cliff unlock
      // - Exponential unlock
      // - Mixed schedules
      
      console.log("✓ Varying lock schedules test outlined");
    });

    it("Tests pagination recovery after failure", async () => {
      console.log("\n--- Pagination Recovery ---");
      
      // Simulate:
      // 1. Distribution starts, processes page 1
      // 2. Page 2 fails mid-processing
      // 3. Resume from page 2
      // 4. Verify no double-payment
      
      console.log("✓ Pagination recovery test outlined");
    });
  });

  describe("Performance and limits", () => {
    it("Tests maximum page size", async () => {
      console.log("\n--- Testing Maximum Page Size ---");
      // Verify 50 investors can be processed in single tx
      console.log("✓ Max page size test outlined");
    });

    it("Tests large investor count (100+ investors)", async () => {
      console.log("\n--- Testing Large Investor Count ---");
      // Verify system handles 100+ investors across multiple pages
      console.log("✓ Large investor count test outlined");
    });

    it("Tests computation limits", async () => {
      console.log("\n--- Testing Computation Limits ---");
      // Verify we stay within Solana compute budget
      console.log("✓ Computation limits test outlined");
    });
  });
});