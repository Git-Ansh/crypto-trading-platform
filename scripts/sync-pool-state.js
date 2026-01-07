#!/usr/bin/env node

/**
 * Sync Pool State Script
 * Synchronizes pool state file with actual running bots
 */

const path = require('path');
const fs = require('fs-extra');
const { execSync } = require('child_process');

const POOL_STATE_FILE = path.join(__dirname, '../data/bot-instances/.container-pool-state.json');

async function syncPoolState() {
  console.log('=== POOL STATE SYNC ===\n');
  
  // Load current state
  if (!await fs.pathExists(POOL_STATE_FILE)) {
    console.error('❌ Pool state file not found');
    process.exit(1);
  }

  const state = await fs.readJSON(POOL_STATE_FILE);
  const backup = { ...state };
  
  console.log(`Pools in state: ${Object.keys(state.pools).length}`);
  console.log(`Bots in state: ${Object.keys(state.botMapping).length}\n`);

  const results = {
    poolsChecked: 0,
    botsRemoved: [],
    poolsUpdated: []
  };

  // Check each pool
  for (const [poolId, pool] of Object.entries(state.pools)) {
    results.poolsChecked++;
    console.log(`\nChecking pool: ${poolId}`);
    console.log(`  Container: ${pool.containerName}`);
    console.log(`  Bots in state: ${pool.bots.join(', ')}`);

    try {
      // Check if container exists
      const containerExists = execSync(
        `docker ps -q -f name=${pool.containerName}`,
        { encoding: 'utf-8' }
      ).trim();

      if (!containerExists) {
        console.log(`  ⚠️  Container not running`);
        pool.status = 'stopped';
        results.poolsUpdated.push(poolId);
        continue;
      }

      // Get supervisor status
      const supervisorStatus = execSync(
        `docker exec ${pool.containerName} supervisorctl status`,
        { encoding: 'utf-8' }
      );

      // Parse running bots
      const runningBots = new Set();
      const lines = supervisorStatus.split('\n');
      for (const line of lines) {
        const match = line.match(/^bot-([^\s]+)\s+RUNNING/);
        if (match) {
          runningBots.add(match[1]);
        }
      }

      console.log(`  Actually running: ${Array.from(runningBots).join(', ') || 'none'}`);

      // Find stale bots
      const staleBots = pool.bots.filter(botId => !runningBots.has(botId));
      
      if (staleBots.length > 0) {
        console.log(`  🔧 Removing stale bots: ${staleBots.join(', ')}`);
        
        for (const botId of staleBots) {
          // Remove from pool
          pool.bots = pool.bots.filter(id => id !== botId);
          
          // Remove from bot mapping
          delete state.botMapping[botId];
          
          results.botsRemoved.push({ botId, poolId });
        }
        
        results.poolsUpdated.push(poolId);
      } else {
        console.log(`  ✓ Pool state is accurate`);
      }

    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
    }
  }

  // Save updated state
  if (results.botsRemoved.length > 0) {
    // Backup original
    await fs.writeJSON(
      POOL_STATE_FILE + '.backup',
      backup,
      { spaces: 2 }
    );
    
    // Save updated state
    await fs.writeJSON(POOL_STATE_FILE, state, { spaces: 2 });
    
    console.log(`\n✅ Sync complete:`);
    console.log(`   - Pools checked: ${results.poolsChecked}`);
    console.log(`   - Bots removed: ${results.botsRemoved.length}`);
    console.log(`   - Pools updated: ${results.poolsUpdated.length}`);
    console.log(`\nBackup saved to: ${POOL_STATE_FILE}.backup`);
    
    if (results.botsRemoved.length > 0) {
      console.log(`\nRemoved bots:`);
      for (const { botId, poolId } of results.botsRemoved) {
        console.log(`   - ${botId} from ${poolId}`);
      }
    }
  } else {
    console.log(`\n✅ No changes needed - pool state is accurate`);
  }
}

syncPoolState().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

