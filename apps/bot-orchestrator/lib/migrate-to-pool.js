#!/usr/bin/env node

/**
 * Migration Script: Legacy Bots to Container Pool
 * 
 * This script migrates existing bots from one-container-per-bot mode
 * to the multi-tenant container pool architecture.
 * 
 * Features:
 * - Dry-run mode to preview changes
 * - Graceful migration with minimal downtime
 * - Rollback capability
 * - Progress tracking and logging
 * 
 * Usage:
 *   node migrate-to-pool.js --dry-run          # Preview migration
 *   node migrate-to-pool.js --execute          # Run migration
 *   node migrate-to-pool.js --rollback=bot-id  # Rollback specific bot
 *   node migrate-to-pool.js --status           # Check migration status
 */

const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '../../../data/bot-instances');
const MIGRATION_LOG_FILE = path.join(BOT_BASE_DIR, '.migration-log.json');
const LEGACY_CONTAINER_PREFIX = 'freqtrade-';

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const execute = args.includes('--execute');
const status = args.includes('--status');
const rollbackArg = args.find(a => a.startsWith('--rollback='));
const rollbackBotId = rollbackArg ? rollbackArg.split('=')[1] : null;
const verbose = args.includes('--verbose') || args.includes('-v');

// Migration state
let migrationLog = {
  startedAt: null,
  completedAt: null,
  status: 'pending',
  migratedBots: [],
  failedBots: [],
  skippedBots: [],
  rollbackHistory: []
};

/**
 * Main entry point
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Container Pool Migration Tool');
  console.log('='.repeat(60));
  
  // Load existing migration log
  await loadMigrationLog();
  
  if (status) {
    await showMigrationStatus();
    return;
  }
  
  if (rollbackBotId) {
    await rollbackBot(rollbackBotId);
    return;
  }
  
  if (!dryRun && !execute) {
    console.log('\nUsage:');
    console.log('  node migrate-to-pool.js --dry-run    Preview migration');
    console.log('  node migrate-to-pool.js --execute    Execute migration');
    console.log('  node migrate-to-pool.js --status     Check migration status');
    console.log('  node migrate-to-pool.js --rollback=<bot-id>  Rollback a bot');
    console.log('\nOptions:');
    console.log('  --verbose, -v    Show detailed output');
    return;
  }
  
  // Discover legacy bots
  const legacyBots = await discoverLegacyBots();
  
  console.log(`\nDiscovered ${legacyBots.length} legacy bots:\n`);
  
  if (legacyBots.length === 0) {
    console.log('No legacy bots found to migrate.');
    return;
  }
  
  // Display bots
  for (const bot of legacyBots) {
    const statusIcon = bot.running ? '🟢' : '⚪';
    console.log(`  ${statusIcon} ${bot.instanceId}`);
    console.log(`     User: ${bot.userId}`);
    console.log(`     Container: ${bot.containerName}`);
    console.log(`     Port: ${bot.port}`);
    if (verbose) {
      console.log(`     Strategy: ${bot.strategy}`);
      console.log(`     Config: ${bot.configPath}`);
    }
    console.log('');
  }
  
  if (dryRun) {
    console.log('\n[DRY RUN] No changes will be made.\n');
    await simulateMigration(legacyBots);
    return;
  }
  
  // Execute migration
  console.log('\n⚠️  EXECUTING MIGRATION ⚠️\n');
  console.log('This will:');
  console.log('  1. Stop each legacy container');
  console.log('  2. Add bot to container pool');
  console.log('  3. Start bot in pool container');
  console.log('  4. Remove legacy container\n');
  
  // Confirmation prompt (in interactive mode)
  if (process.stdin.isTTY) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      rl.question('Continue? (yes/no): ', resolve);
    });
    rl.close();
    
    if (answer.toLowerCase() !== 'yes') {
      console.log('Migration cancelled.');
      return;
    }
  }
  
  await executeMigration(legacyBots);
}

/**
 * Load migration log from disk
 */
async function loadMigrationLog() {
  try {
    if (await fs.pathExists(MIGRATION_LOG_FILE)) {
      migrationLog = JSON.parse(await fs.readFile(MIGRATION_LOG_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('Could not load migration log:', err.message);
  }
}

/**
 * Save migration log to disk
 */
async function saveMigrationLog() {
  try {
    await fs.writeFile(MIGRATION_LOG_FILE, JSON.stringify(migrationLog, null, 2));
  } catch (err) {
    console.error('Failed to save migration log:', err.message);
  }
}

/**
 * Discover all legacy bots (one container per bot)
 */
async function discoverLegacyBots() {
  const bots = [];
  
  if (!await fs.pathExists(BOT_BASE_DIR)) {
    return bots;
  }
  
  // Get all running containers matching legacy pattern
  let runningContainers = new Set();
  try {
    const { stdout } = await execPromise(
      `docker ps --format "{{.Names}}" | grep "^${LEGACY_CONTAINER_PREFIX}" || true`
    );
    runningContainers = new Set(stdout.trim().split('\n').filter(Boolean));
  } catch (err) {
    console.warn('Could not list running containers:', err.message);
  }
  
  // Scan bot directories
  const users = await fs.readdir(BOT_BASE_DIR);
  
  for (const userId of users) {
    // Skip special directories
    if (userId.startsWith('.') || userId === 'pools') continue;
    
    const userDir = path.join(BOT_BASE_DIR, userId);
    const stat = await fs.stat(userDir);
    if (!stat.isDirectory()) continue;
    
    const instances = await fs.readdir(userDir);
    
    for (const instanceId of instances) {
      const instanceDir = path.join(userDir, instanceId);
      const configPath = path.join(instanceDir, 'config.json');
      
      if (!await fs.pathExists(configPath)) continue;
      
      try {
        const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        const containerName = `${LEGACY_CONTAINER_PREFIX}${instanceId}`;
        
        bots.push({
          instanceId,
          userId,
          containerName,
          configPath,
          instanceDir,
          port: config.api_server?.listen_port,
          strategy: config.strategy,
          running: runningContainers.has(containerName),
          config
        });
      } catch (err) {
        if (verbose) {
          console.warn(`Skipping ${instanceId}: ${err.message}`);
        }
      }
    }
  }
  
  // Filter out already-migrated bots
  const migratedIds = new Set(migrationLog.migratedBots.map(b => b.instanceId));
  return bots.filter(b => !migratedIds.has(b.instanceId));
}

/**
 * Simulate migration without making changes
 */
async function simulateMigration(bots) {
  console.log('Migration simulation:\n');
  
  // Initialize pool integration (but don't actually create containers)
  const { getPoolManager } = require('./container-pool');
  const poolManager = getPoolManager();
  
  let poolCount = 0;
  let botCount = 0;
  const MAX_BOTS_PER_POOL = 10;
  
  for (const bot of bots) {
    botCount++;
    if (botCount % MAX_BOTS_PER_POOL === 1) {
      poolCount++;
      console.log(`\n📦 Pool ${poolCount} (capacity: ${MAX_BOTS_PER_POOL} bots):`);
    }
    
    console.log(`  → ${bot.instanceId} (port ${bot.port})`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Summary:');
  console.log(`  Bots to migrate: ${bots.length}`);
  console.log(`  Pools needed: ${poolCount}`);
  console.log(`  Estimated memory savings: ${Math.round(bots.length * 500 - poolCount * 600)}MB`);
  console.log('='.repeat(60));
  
  console.log('\nTo execute migration, run:');
  console.log('  node migrate-to-pool.js --execute\n');
}

/**
 * Execute the migration
 */
async function executeMigration(bots) {
  // Initialize pool system
  const { initPoolSystem, poolProvisioner } = require('./pool-integration');
  await initPoolSystem();
  
  migrationLog.startedAt = new Date().toISOString();
  migrationLog.status = 'in-progress';
  await saveMigrationLog();
  
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    console.log(`\n[${i + 1}/${bots.length}] Migrating ${bot.instanceId}...`);
    
    try {
      // Step 1: Backup current state
      console.log('  ↳ Backing up current state...');
      const backupDir = path.join(bot.instanceDir, '.migration-backup');
      await fs.ensureDir(backupDir);
      await fs.copy(bot.configPath, path.join(backupDir, 'config.json'));
      
      // Step 2: Stop legacy container if running
      if (bot.running) {
        console.log('  ↳ Stopping legacy container...');
        try {
          await execPromise(`docker stop ${bot.containerName}`);
        } catch (err) {
          console.warn(`    Warning: ${err.message}`);
        }
      }
      
      // Step 3: Allocate slot in pool
      console.log('  ↳ Allocating pool slot...');
      const { getPoolManager } = require('./container-pool');
      const poolManager = getPoolManager();
      const slot = await poolManager.allocateBotSlot(bot.instanceId, bot.userId, bot.config);
      
      // Step 4: Start bot in pool
      console.log(`  ↳ Starting in pool ${slot.poolId} on port ${slot.port}...`);
      
      // Update config with pool-specific settings
      const poolConfig = { ...bot.config };
      poolConfig.api_server.listen_port = slot.port;
      poolConfig.db_url = `sqlite:////pool/bots/${bot.instanceId}/tradesv3.sqlite`;
      poolConfig.logfile = `/pool/bots/${bot.instanceId}/freqtrade.log`;
      
      await poolManager.startBotInPool(bot.instanceId, poolConfig);
      
      // Step 5: Verify bot is running
      console.log('  ↳ Verifying bot health...');
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for startup
      
      const fetch = require('node-fetch');
      const pingUrl = `http://${slot.containerName}:${slot.port}/api/v1/ping`;
      const pingResp = await fetch(pingUrl, { timeout: 10000 }).catch(() => null);
      
      if (!pingResp?.ok) {
        throw new Error('Bot failed health check after migration');
      }
      
      // Step 6: Remove legacy container
      console.log('  ↳ Removing legacy container...');
      try {
        await execPromise(`docker rm -f ${bot.containerName}`);
      } catch (err) {
        // Container may already be removed
      }
      
      // Record success
      migrationLog.migratedBots.push({
        instanceId: bot.instanceId,
        userId: bot.userId,
        migratedAt: new Date().toISOString(),
        poolId: slot.poolId,
        newPort: slot.port,
        oldPort: bot.port
      });
      await saveMigrationLog();
      
      console.log(`  ✓ Successfully migrated to pool ${slot.poolId}`);
      successCount++;
      
    } catch (err) {
      console.error(`  ✗ Migration failed: ${err.message}`);
      
      // Attempt to restore legacy container
      console.log('  ↳ Attempting rollback...');
      try {
        await execPromise(`docker start ${bot.containerName}`);
        console.log('  ↳ Restored legacy container');
      } catch (rollbackErr) {
        console.error(`  ↳ Rollback failed: ${rollbackErr.message}`);
      }
      
      migrationLog.failedBots.push({
        instanceId: bot.instanceId,
        userId: bot.userId,
        failedAt: new Date().toISOString(),
        error: err.message
      });
      await saveMigrationLog();
      
      failCount++;
    }
  }
  
  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('Migration Complete');
  console.log('='.repeat(60));
  console.log(`  Successful: ${successCount}`);
  console.log(`  Failed: ${failCount}`);
  console.log(`  Total: ${bots.length}`);
  
  migrationLog.completedAt = new Date().toISOString();
  migrationLog.status = failCount === 0 ? 'completed' : 'completed-with-errors';
  await saveMigrationLog();
  
  if (failCount > 0) {
    console.log('\nFailed bots can be retried by running migration again.');
    console.log('Or rollback specific bots with: node migrate-to-pool.js --rollback=<bot-id>');
  }
}

/**
 * Rollback a specific bot to legacy mode
 */
async function rollbackBot(instanceId) {
  console.log(`\nRolling back ${instanceId}...\n`);
  
  // Find in migration log
  const migrated = migrationLog.migratedBots.find(b => b.instanceId === instanceId);
  
  if (!migrated) {
    console.error(`Bot ${instanceId} not found in migration log.`);
    return;
  }
  
  try {
    // Initialize pool system
    const { initPoolSystem, poolProvisioner } = require('./pool-integration');
    await initPoolSystem();
    const { getPoolManager } = require('./container-pool');
    const poolManager = getPoolManager();
    
    // Step 1: Stop bot in pool
    console.log('  ↳ Stopping bot in pool...');
    await poolManager.stopBotInPool(instanceId);
    
    // Step 2: Remove from pool
    console.log('  ↳ Removing from pool...');
    await poolManager.removeBotFromPool(instanceId);
    
    // Step 3: Restore legacy container
    console.log('  ↳ Restoring legacy container...');
    const instanceDir = path.join(BOT_BASE_DIR, migrated.userId, instanceId);
    const composePath = path.join(instanceDir, 'docker-compose.yml');
    
    if (await fs.pathExists(composePath)) {
      await execPromise(`docker-compose -f ${composePath} up -d`);
    } else {
      // Create legacy container manually
      const config = JSON.parse(await fs.readFile(path.join(instanceDir, 'config.json'), 'utf8'));
      config.api_server.listen_port = migrated.oldPort;
      await fs.writeFile(path.join(instanceDir, 'config.json'), JSON.stringify(config, null, 2));
      
      // Would need to recreate docker-compose or use docker run
      console.log('  ⚠️  Legacy docker-compose.yml not found. Manual container creation needed.');
    }
    
    // Update migration log
    migrationLog.migratedBots = migrationLog.migratedBots.filter(b => b.instanceId !== instanceId);
    migrationLog.rollbackHistory.push({
      instanceId,
      rolledBackAt: new Date().toISOString()
    });
    await saveMigrationLog();
    
    console.log(`\n✓ Successfully rolled back ${instanceId}`);
    
  } catch (err) {
    console.error(`\n✗ Rollback failed: ${err.message}`);
  }
}

/**
 * Show migration status
 */
async function showMigrationStatus() {
  console.log('\nMigration Status:');
  console.log('='.repeat(40));
  console.log(`Status: ${migrationLog.status}`);
  console.log(`Started: ${migrationLog.startedAt || 'Not started'}`);
  console.log(`Completed: ${migrationLog.completedAt || 'In progress'}`);
  console.log(`Migrated: ${migrationLog.migratedBots.length}`);
  console.log(`Failed: ${migrationLog.failedBots.length}`);
  console.log(`Rollbacks: ${migrationLog.rollbackHistory.length}`);
  
  if (verbose && migrationLog.migratedBots.length > 0) {
    console.log('\nMigrated bots:');
    for (const bot of migrationLog.migratedBots) {
      console.log(`  ✓ ${bot.instanceId} → Pool ${bot.poolId} (port ${bot.newPort})`);
    }
  }
  
  if (verbose && migrationLog.failedBots.length > 0) {
    console.log('\nFailed bots:');
    for (const bot of migrationLog.failedBots) {
      console.log(`  ✗ ${bot.instanceId}: ${bot.error}`);
    }
  }
  
  console.log('');
}

// Run main
main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
