#!/usr/bin/env node

/**
 * Direct Pool Load Test
 * Directly calls pool provisioner to test with 30+ bots
 */

const path = require('path');
const fs = require('fs-extra');

// Set environment variables
process.env.NODE_ENV = 'production';
process.env.POOL_MODE_ENABLED = 'true';
process.env.MAX_BOTS_PER_CONTAINER = '10';

const { poolProvisioner, initPoolSystem } = require('../apps/bot-orchestrator/lib/pool-integration');
const { execSync } = require('child_process');

const NUM_TEST_USERS = 2;
const BOTS_PER_USER = 8;
const TOTAL_BOTS = NUM_TEST_USERS * BOTS_PER_USER; // 16 bots total

const testUsers = [
  'Js1Gaz4sMPPiDNgFbmAgDFLe4je2', // Existing user 1
  'nKgFQvmMslUSBAV7SgLMzTRehhI2', // Existing user 2
  'test-load-user-3' // New test user
];

async function provisionBot(userId, botNumber) {
  const instanceId = `${userId.substring(0, 12)}-loadtest-${botNumber}`;

  try {
    const result = await poolProvisioner.provisionBot({
      userId,
      instanceId,
      strategy: 'EmaRsiStrategy',
      initialBalance: 1000, // Required parameter
      stake_amount: 100,
      max_open_trades: 3,
      timeframe: '15m',
      exchange: 'kraken',
      stake_currency: 'USD',
      tradingPairs: ['BTC/USD', 'ETH/USD'],
      exchangeConfig: {
        name: 'kraken',
        key: 'dummy',
        secret: 'dummy'
      },
      apiUsername: 'admin',
      apiPassword: 'password'
    });

    return { success: true, instanceId, poolId: result.poolId };
  } catch (err) {
    return { success: false, instanceId, error: err.message };
  }
}

async function getDockerStats() {
  try {
    const output = execSync(
      'docker stats --no-stream --format "{{.Name}},{{.MemUsage}},{{.CPUPerc}}" | grep freqtrade-pool',
      { encoding: 'utf-8' }
    );
    
    const stats = [];
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const [name, memory, cpu] = line.split(',');
      stats.push({ name, memory, cpu });
    }
    return stats;
  } catch (err) {
    return [];
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('DIRECT POOL LOAD TEST - 30+ BOTS');
  console.log('='.repeat(80));
  console.log(`\nTest Configuration:`);
  console.log(`  - Users: ${NUM_TEST_USERS}`);
  console.log(`  - Bots per user: ${BOTS_PER_USER}`);
  console.log(`  - Total bots: ${TOTAL_BOTS}`);
  console.log(`  - Max bots per pool: ${process.env.MAX_BOTS_PER_CONTAINER}\n`);

  const results = {
    startTime: new Date(),
    provisioned: [],
    failed: [],
    poolStats: {},
    dockerStats: []
  };

  // Initialize pool system
  console.log('Initializing pool system...');
  try {
    await initPoolSystem();
    console.log('✓ Pool system initialized\n');
  } catch (err) {
    console.error('✗ Failed to initialize pool system:', err.message);
    process.exit(1);
  }

  // Phase 1: Provision bots
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 1: PROVISIONING BOTS');
  console.log('='.repeat(80) + '\n');

  for (let userIdx = 0; userIdx < NUM_TEST_USERS; userIdx++) {
    const userId = testUsers[userIdx];
    console.log(`\nProvisioning bots for user ${userIdx + 1} (${userId.substring(0, 12)}...)...`);
    
    for (let botNum = 1; botNum <= BOTS_PER_USER; botNum++) {
      process.stdout.write(`  Bot ${botNum}/${BOTS_PER_USER}... `);
      
      const result = await provisionBot(userId, botNum);
      
      if (result.success) {
        console.log(`✓ (pool: ${result.poolId})`);
        results.provisioned.push(result);
      } else {
        console.log(`✗ (${result.error})`);
        results.failed.push(result);
      }
      
      // Small delay
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  console.log(`\n✅ Provisioning complete:`);
  console.log(`   - Success: ${results.provisioned.length}`);
  console.log(`   - Failed: ${results.failed.length}`);

  // Phase 2: Get pool statistics
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 2: POOL STATISTICS');
  console.log('='.repeat(80) + '\n');

  console.log('Fetching pool stats...');
  results.poolStats = poolProvisioner.getPoolStats();
  
  if (results.poolStats) {
    console.log(`\nPool System Status:`);
    console.log(`  - Pool Mode: ${results.poolStats.poolMode ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  - Total Pools: ${results.poolStats.totalPools || 0}`);
    console.log(`  - Total Bots: ${results.poolStats.totalBots || 0}`);
    console.log(`  - Max Bots/Pool: ${results.poolStats.maxBotsPerPool || 0}`);

    if (results.poolStats.pools) {
      console.log(`\nPool Details:`);
      for (const pool of results.poolStats.pools) {
        console.log(`  - ${pool.id}:`);
        console.log(`      Bots: ${pool.botsCount}/${pool.capacity}`);
        console.log(`      Status: ${pool.status}`);
        console.log(`      Utilization: ${pool.utilizationPercent}%`);
      }
    }
  }

  // Phase 3: Docker stats
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 3: DOCKER CONTAINER METRICS');
  console.log('='.repeat(80) + '\n');

  console.log('Collecting Docker stats...');
  results.dockerStats = await getDockerStats();

  if (results.dockerStats.length > 0) {
    console.log(`\nContainer Resource Usage:`);
    for (const stat of results.dockerStats) {
      console.log(`  - ${stat.name}:`);
      console.log(`      Memory: ${stat.memory}`);
      console.log(`      CPU: ${stat.cpu}`);
    }
  }

  // Phase 4: Health check
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 4: HEALTH CHECK');
  console.log('='.repeat(80) + '\n');

  console.log('Running health check (this may take a while)...');
  try {
    const healthResults = await poolProvisioner.runHealthCheck();
    results.healthCheck = healthResults;

    console.log(`\nHealth Check Results:`);
    console.log(`  - Duration: ${healthResults.durationMs}ms`);
    console.log(`  - Pools Checked: ${healthResults.pools?.length || 0}`);
    console.log(`  - Bots Checked: ${healthResults.bots?.length || 0}`);
    console.log(`  - Issues Found: ${healthResults.issues?.length || 0}`);
    console.log(`  - Recovery Actions: ${healthResults.recoveryActions?.length || 0}`);

    if (healthResults.issues && healthResults.issues.length > 0) {
      console.log(`\nIssues:`);
      for (const issue of healthResults.issues.slice(0, 10)) {
        console.log(`  - ${issue.type}: ${issue.id} - ${issue.message}`);
      }
      if (healthResults.issues.length > 10) {
        console.log(`  ... and ${healthResults.issues.length - 10} more`);
      }
    }
  } catch (err) {
    console.error('Health check failed:', err.message);
  }

  // Final summary
  results.endTime = new Date();
  results.duration = (results.endTime - results.startTime) / 1000;

  console.log('\n' + '='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80) + '\n');

  console.log(`Test Duration: ${results.duration.toFixed(2)}s`);
  console.log(`Bots Provisioned: ${results.provisioned.length}/${TOTAL_BOTS}`);
  console.log(`Success Rate: ${((results.provisioned.length / TOTAL_BOTS) * 100).toFixed(1)}%`);

  if (results.poolStats && results.poolStats.pools) {
    console.log(`\nPool Efficiency:`);
    const avgUtilization = results.poolStats.pools.reduce((sum, p) => sum + p.utilizationPercent, 0) / results.poolStats.pools.length;
    console.log(`  - Average Pool Utilization: ${avgUtilization.toFixed(1)}%`);
    console.log(`  - Pools Created: ${results.poolStats.totalPools}`);
    console.log(`  - Bots per Pool (avg): ${(results.poolStats.totalBots / results.poolStats.totalPools).toFixed(1)}`);
  }

  if (results.dockerStats.length > 0) {
    console.log(`\nResource Usage:`);
    const totalMemory = results.dockerStats.reduce((sum, s) => {
      const match = s.memory.match(/(\d+\.?\d*)(MiB|GiB)/);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2];
        return sum + (unit === 'GiB' ? value * 1024 : value);
      }
      return sum;
    }, 0);
    console.log(`  - Total Memory: ${totalMemory.toFixed(1)} MiB`);
    if (results.provisioned.length > 0) {
      console.log(`  - Memory per Bot: ${(totalMemory / results.provisioned.length).toFixed(1)} MiB`);
    }
  }

  // Save results to file
  const resultsFile = path.join(__dirname, `../test-results-direct-${Date.now()}.json`);
  await fs.writeJSON(resultsFile, results, { spaces: 2 });
  console.log(`\n📊 Full results saved to: ${resultsFile}`);

  console.log('\n' + '='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');

  // Cleanup
  console.log('\nShutting down pool system...');
  // No shutdown function needed for direct test
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  console.error(err.stack);
  process.exit(1);
});

