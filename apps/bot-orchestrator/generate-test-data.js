/**
 * Generate test historical data for portfolio charts
 * This script creates fake data points spanning 30 days for testing
 * RUN: node generate-test-data.js <userId>
 */

const fs = require('fs-extra');
const path = require('path');

const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '..', 'freqtrade-instances');

async function generateTestData(userId) {
    if (!userId) {
        console.error('Usage: node generate-test-data.js <userId>');
        console.log('Available users:');
        const users = await fs.readdir(BOT_BASE_DIR);
        users.forEach(u => console.log(`  - ${u}`));
        process.exit(1);
    }

    const userDir = path.join(BOT_BASE_DIR, userId);
    const snapshotPath = path.join(userDir, 'portfolio_snapshots.json');
    const backupPath = path.join(userDir, 'portfolio_snapshots_original_backup.json');

    console.log(`\n=== Generating Test Data for User: ${userId} ===\n`);

    // Backup existing data first
    if (await fs.pathExists(snapshotPath)) {
        console.log('📦 Backing up existing data to portfolio_snapshots_original_backup.json...');
        await fs.copy(snapshotPath, backupPath);
        console.log('✅ Backup created successfully');
    }

    // Generate 30 days of data
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    const snapshots = [];

    // Starting values
    let portfolioValue = 5000;
    let startingBalance = 5000;

    // Generate data points every 5 minutes for 30 days
    // This creates: 30 days * 24 hours * 12 points/hour = 8640 data points
    const intervalMs = 5 * 60 * 1000; // 5 minutes

    console.log('📊 Generating test data points...');
    console.log(`   Time range: ${new Date(thirtyDaysAgo).toISOString()} to ${new Date(now).toISOString()}`);

    for (let timestamp = thirtyDaysAgo; timestamp <= now; timestamp += intervalMs) {
        // Simulate some variation in portfolio value
        // Add random walk with slight upward trend
        const randomChange = (Math.random() - 0.48) * 50; // Slight upward bias
        portfolioValue = Math.max(4000, portfolioValue + randomChange);

        // Add some realistic patterns
        const dayOfWeek = new Date(timestamp).getDay();
        const hourOfDay = new Date(timestamp).getHours();

        // Weekend dip simulation
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            portfolioValue *= 0.9995;
        }

        // Volatility during market hours (9-16 UTC)
        if (hourOfDay >= 9 && hourOfDay <= 16) {
            portfolioValue += (Math.random() - 0.5) * 30;
        }

        const totalPnL = portfolioValue - startingBalance;
        const pnlPercentage = (totalPnL / startingBalance) * 100;

        snapshots.push({
            timestamp,
            portfolioValue: Number(portfolioValue.toFixed(2)),
            totalPnL: Number(totalPnL.toFixed(2)),
            pnlPercentage: Number(pnlPercentage.toFixed(2)),
            activeBots: 1,
            botCount: 1,
            totalBalance: Number(portfolioValue.toFixed(2)),
            startingBalance
        });
    }

    console.log(`✅ Generated ${snapshots.length} data points`);

    // Create the data structure
    const data = {
        metadata: {
            firstSnapshot: thirtyDaysAgo,
            lastSnapshot: now,
            totalSnapshots: snapshots.length,
            accountCreated: thirtyDaysAgo,
            isTestData: true, // Mark as test data
            compressionHistory: []
        },
        snapshots,
        lastUpdated: now,
        version: '2.0'
    };

    // Write the test data
    console.log('💾 Writing test data to file...');
    await fs.ensureDir(userDir);
    await fs.writeJson(snapshotPath, data, { spaces: 2 });
    console.log('✅ Test data written successfully');

    // Summary
    console.log('\n=== Summary ===');
    console.log(`Total snapshots: ${snapshots.length}`);
    console.log(`First snapshot: ${new Date(thirtyDaysAgo).toISOString()}`);
    console.log(`Last snapshot: ${new Date(now).toISOString()}`);
    console.log(`Starting value: $${startingBalance.toFixed(2)}`);
    console.log(`Ending value: $${portfolioValue.toFixed(2)}`);
    console.log(`Total P&L: $${(portfolioValue - startingBalance).toFixed(2)}`);
    console.log('\n🎉 Test data generation complete! Refresh the frontend to see the charts.');
    console.log('\nTo restore original data later, run:');
    console.log(`  cp "${backupPath}" "${snapshotPath}"`);
}

// Run the script
const userId = process.argv[2];
generateTestData(userId).catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
