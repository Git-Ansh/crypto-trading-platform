#!/usr/bin/env node

/**
 * Direct wallet sync script - connects to MongoDB and cleans up orphaned allocations
 * This bypasses the API and directly manipulates the database
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: './apps/api-gateway/.env' });

// Import User model
const User = require('../apps/api-gateway/models/user');

async function syncWallet() {
  try {
    console.log('Connecting to MongoDB...');
    console.log('URI:', process.env.MONGO_URI.replace(/:[^:@]+@/, ':****@'));

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log('✓ Connected to MongoDB');
    console.log('Database:', mongoose.connection.db.databaseName);

    // Find user by email
    const email = 'anshjarvis2003@gmail.com';
    console.log(`\nFinding user: ${email}`);
    
    const user = await User.findOne({ email });
    if (!user) {
      console.error('✗ User not found');
      process.exit(1);
    }

    console.log('✓ User found');
    console.log(`  Current wallet balance: $${user.paperWallet?.balance || 0}`);
    console.log(`  Bot allocations: ${user.botAllocations?.size || 0}`);

    // List all allocations
    if (user.botAllocations && user.botAllocations.size > 0) {
      console.log('\nCurrent allocations:');
      for (const [botId, allocation] of user.botAllocations.entries()) {
        const amount = allocation.currentValue || allocation.allocatedAmount || 0;
        const pnl = (allocation.currentValue || 0) - (allocation.allocatedAmount || 0);
        console.log(`  - ${botId}: $${amount.toFixed(2)} (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`);
      }

      // Clean up all allocations (since we know no bots are running)
      console.log('\n⚠️  Cleaning up all allocations...');
      
      const now = new Date();
      let currentBalance = user.paperWallet?.balance || 0;
      let totalReturned = 0;
      const cleanedBots = [];

      for (const [botId, allocation] of user.botAllocations.entries()) {
        const returnAmount = allocation.currentValue || allocation.allocatedAmount || 0;
        const pnl = (allocation.currentValue || 0) - (allocation.allocatedAmount || 0);

        currentBalance += returnAmount;
        totalReturned += returnAmount;

        // Add transaction
        user.walletTransactions.push({
          type: 'deallocate',
          amount: returnAmount,
          botId,
          botName: allocation.botName || botId,
          description: `Manual cleanup: returned $${returnAmount.toFixed(2)} from orphaned bot (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
          balanceAfter: currentBalance,
          timestamp: now,
        });

        cleanedBots.push({
          botId,
          botName: allocation.botName || botId,
          returned: returnAmount,
          pnl,
        });

        console.log(`  ✓ Cleaned ${botId}: returned $${returnAmount.toFixed(2)}`);
      }

      // Clear all allocations
      user.botAllocations.clear();

      // Update wallet
      user.paperWallet = {
        balance: currentBalance,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: now,
      };

      await user.save();

      console.log('\n✓ Wallet sync completed successfully');
      console.log(`  Total returned: $${totalReturned.toFixed(2)}`);
      console.log(`  New wallet balance: $${currentBalance.toFixed(2)}`);
      console.log(`  Cleaned bots: ${cleanedBots.length}`);
    } else {
      console.log('\n✓ No allocations to clean up');
    }

    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

syncWallet();

