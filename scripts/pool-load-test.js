#!/usr/bin/env node

/**
 * Pool Load Testing Script
 * Tests pool system with 30+ bots across multiple users
 */

const axios = require('axios');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs-extra');

const BOT_MANAGER_URL = 'http://localhost:5000';
const NUM_TEST_USERS = 3;
const BOTS_PER_USER = 12; // Total: 36 bots
const TOTAL_BOTS = NUM_TEST_USERS * BOTS_PER_USER;

// Initialize Firebase Admin
const serviceAccount = require('../apps/bot-orchestrator/serviceAccountKey.json');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const testUsers = [
  { uid: 'test-user-1', email: 'testuser1@example.com', name: 'Test User 1' },
  { uid: 'test-user-2', email: 'testuser2@example.com', name: 'Test User 2' },
  { uid: 'test-user-3', email: 'testuser3@example.com', name: 'Test User 3' }
];

async function getAuthToken(userId) {
  const token = await admin.auth().createCustomToken(userId);
  return token;
}

async function provisionBot(userId, botNumber) {
  const token = await getAuthToken(userId);
  const instanceId = `${userId}-bot-${botNumber}`;
  
  try {
    const response = await axios.post(
      `${BOT_MANAGER_URL}/api/provision-enhanced`,
      {
        instanceId,
        strategy: 'EmaRsiStrategy',
        config: {
          dry_run: true,
          stake_amount: 100,
          max_open_trades: 3
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );
    
    return { success: true, instanceId, data: response.data };
  } catch (err) {
    return { 
      success: false, 
      instanceId, 
      error: err.response?.data?.message || err.message 
    };
  }
}

async function getPoolStats() {
  try {
    const token = await getAuthToken(testUsers[0].uid);
    const response = await axios.get(
      `${BOT_MANAGER_URL}/api/pool/status`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (err) {
    console.error('Error getting pool stats:', err.message);
    return null;
  }
}

async function runHealthCheck() {
  try {
    const token = await getAuthToken(testUsers[0].uid);
    const response = await axios.post(
      `${BOT_MANAGER_URL}/api/pool/health-check`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );
    return response.data;
  } catch (err) {
    console.error('Health check error:', err.response?.data || err.message);
    return null;
  }
}

async function getDockerStats() {
  const { execSync } = require('child_process');
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
  console.log('POOL LOAD TEST - 30+ BOTS ACROSS MULTIPLE USERS');
  console.log('='.repeat(80));
  console.log(`\nTest Configuration:`);
  console.log(`  - Users: ${NUM_TEST_USERS}`);
  console.log(`  - Bots per user: ${BOTS_PER_USER}`);
  console.log(`  - Total bots: ${TOTAL_BOTS}`);
  console.log(`  - Bot Manager URL: ${BOT_MANAGER_URL}\n`);

  const results = {
    startTime: new Date(),
    provisioned: [],
    failed: [],
    poolStats: {},
    healthCheck: null,
    dockerStats: []
  };

  // Phase 1: Provision bots
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 1: PROVISIONING BOTS');
  console.log('='.repeat(80) + '\n');

  for (let userIdx = 0; userIdx < NUM_TEST_USERS; userIdx++) {
    const user = testUsers[userIdx];
    console.log(`\nProvisioning bots for ${user.name} (${user.uid})...`);
    
    for (let botNum = 1; botNum <= BOTS_PER_USER; botNum++) {
      process.stdout.write(`  Bot ${botNum}/${BOTS_PER_USER}... `);
      
      const result = await provisionBot(user.uid, botNum);
      
      if (result.success) {
        console.log('✓');
        results.provisioned.push(result);
      } else {
        console.log(`✗ (${result.error})`);
        results.failed.push(result);
      }
      
      // Small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 500));
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
  results.poolStats = await getPoolStats();

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
  results.healthCheck = await runHealthCheck();

  if (results.healthCheck) {
    console.log(`\nHealth Check Results:`);
    console.log(`  - Duration: ${results.healthCheck.durationMs}ms`);
    console.log(`  - Pools Checked: ${results.healthCheck.pools?.length || 0}`);
    console.log(`  - Bots Checked: ${results.healthCheck.bots?.length || 0}`);
    console.log(`  - Issues Found: ${results.healthCheck.issues?.length || 0}`);
    console.log(`  - Recovery Actions: ${results.healthCheck.recoveryActions?.length || 0}`);

    if (results.healthCheck.issues && results.healthCheck.issues.length > 0) {
      console.log(`\nIssues:`);
      for (const issue of results.healthCheck.issues) {
        console.log(`  - ${issue.type}: ${issue.id} - ${issue.message}`);
      }
    }
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

  if (results.poolStats) {
    console.log(`\nPool Efficiency:`);
    const avgUtilization = results.poolStats.pools?.reduce((sum, p) => sum + p.utilizationPercent, 0) / (results.poolStats.pools?.length || 1);
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
    console.log(`  - Memory per Bot: ${(totalMemory / results.provisioned.length).toFixed(1)} MiB`);
  }

  // Save results to file
  const resultsFile = path.join(__dirname, `../test-results-${Date.now()}.json`);
  await fs.writeJSON(resultsFile, results, { spaces: 2 });
  console.log(`\n📊 Full results saved to: ${resultsFile}`);

  console.log('\n' + '='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80) + '\n');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});

