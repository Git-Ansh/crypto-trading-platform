#!/usr/bin/env node
/**
 * Background Database Sync Service
 * Periodically syncs all local SQLite databases to Turso for backup
 */

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Configuration
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '..', 'freqtrade-instances');
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL) || 300; // 5 minutes default
const SYNC_SCRIPT = path.join(__dirname, '..', 'local-to-turso-sync-optimized.py');

// Global state
const activeSyncs = new Map();
let syncStats = {
    totalSyncs: 0,
    successfulSyncs: 0,
    failedSyncs: 0,
    lastSyncTime: null,
    currentlySyncing: []
};

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [SYNC SERVICE] ${message}`);
}

async function findAllBotInstances() {
    // Find all bot instances that have sync configurations
    const instances = [];

    try {
        if (!await fs.pathExists(BOT_BASE_DIR)) {
            log(`Bot base directory not found: ${BOT_BASE_DIR}`);
            return instances;
        }

        // Scan user directories
        const users = await fs.readdir(BOT_BASE_DIR);

        for (const userId of users) {
            const userDir = path.join(BOT_BASE_DIR, userId);
            const userStat = await fs.stat(userDir);

            if (!userStat.isDirectory()) continue;

            // Scan bot instances in user directory
            const botInstances = await fs.readdir(userDir);

            for (const instanceId of botInstances) {
                const instanceDir = path.join(userDir, instanceId);
                const instanceStat = await fs.stat(instanceDir);

                if (!instanceStat.isDirectory()) continue;

                // Check for sync configuration
                const syncConfigPath = path.join(instanceDir, 'sync-config.json');
                const localDbPath = path.join(instanceDir, 'user_data', 'tradesv3.sqlite');

                if (await fs.pathExists(syncConfigPath) && await fs.pathExists(localDbPath)) {
                    try {
                        const syncConfig = JSON.parse(await fs.readFile(syncConfigPath, 'utf8'));
                        if (syncConfig.enabled) {
                            instances.push({
                                userId,
                                instanceId,
                                instanceDir,
                                syncConfig,
                                localDbPath
                            });
                        }
                    } catch (configError) {
                        log(`Failed to read sync config for ${userId}/${instanceId}: ${configError.message}`);
                    }
                }
            }
        }

        log(`Found ${instances.length} bot instances with sync enabled`);
        return instances;

    } catch (error) {
        log(`Error scanning bot instances: ${error.message}`);
        return instances;
    }
}

async function syncInstance(instance) {
    // Sync a single bot instance to Turso
    const { userId, instanceId, localDbPath, syncConfig } = instance;
    const syncKey = `${userId}/${instanceId}`;

    // Check if sync is already running for this instance
    if (activeSyncs.has(syncKey)) {
        log(`Sync already running for ${syncKey}, skipping`);
        return false;
    }

    try {
        activeSyncs.set(syncKey, Date.now());
        syncStats.currentlySyncing.push(syncKey);
        log(`Starting sync for ${syncKey}...`);

        // Run the Python sync script
        const syncArgs = [
            SYNC_SCRIPT,
            '--instance-id', instanceId,
            '--user-id', userId,
            '--local-db', localDbPath,
            '--turso-org', process.env.TURSO_ORG,
            '--turso-region', process.env.TURSO_REGION || 'us-east-1',
            '--create-if-missing'
        ];

        const syncProcess = spawn('python3', syncArgs, {
            cwd: instance.instanceDir, // Set working directory to the bot instance directory
            env: {
                ...process.env,
                TURSO_API_KEY: process.env.TURSO_API_KEY,
                TURSO_CMD: process.env.TURSO_CMD || '/root/.turso/turso'
            }
        });

        // Debug log the environment
        log(`Environment check: TURSO_API_KEY=${process.env.TURSO_API_KEY ? 'SET' : 'NOT SET'}, TURSO_ORG=${process.env.TURSO_ORG || 'NOT SET'}`);

        let stdout = '';
        let stderr = '';

        syncProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        syncProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        const exitCode = await new Promise((resolve) => {
            syncProcess.on('close', resolve);
            syncProcess.on('error', (error) => {
                log(`Sync process error for ${syncKey}: ${error.message}`);
                resolve(1);
            });
        });

        if (exitCode === 0) {
            log(`✓ Sync completed successfully for ${syncKey}`);
            if (stdout) log(`Sync output: ${stdout.trim()}`);
            syncStats.successfulSyncs++;
            return true;
        } else {
            log(`✗ Sync failed for ${syncKey} (exit code: ${exitCode})`);
            if (stderr) log(`Sync error output: ${stderr.trim()}`);
            if (stdout) log(`Sync stdout: ${stdout.trim()}`);
            syncStats.failedSyncs++;
            return false;
        }

    } catch (error) {
        log(`Sync error for ${syncKey}: ${error.message}`);
        syncStats.failedSyncs++;
        return false;
    } finally {
        activeSyncs.delete(syncKey);
        syncStats.currentlySyncing = syncStats.currentlySyncing.filter(key => key !== syncKey);
        syncStats.totalSyncs++;
        syncStats.lastSyncTime = new Date().toISOString();
    }
}

async function performSyncCycle() {
    // Perform one complete sync cycle for all instances
    try {
        log("Starting sync cycle...");

        const instances = await findAllBotInstances();

        if (instances.length === 0) {
            log("No instances found for syncing");
            return;
        }

        // Sync instances sequentially to avoid overwhelming Turso
        let successCount = 0;
        for (const instance of instances) {
            const success = await syncInstance(instance);
            if (success) successCount++;

            // Small delay between syncs
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        log(`Sync cycle complete: ${successCount}/${instances.length} instances synced successfully`);

    } catch (error) {
        log(`Sync cycle error: ${error.message}`);
    }
}

async function startSyncService() {
    // Start the background sync service
    log("=".repeat(60));
    log("FREQTRADE LOCAL-TO-TURSO SYNC SERVICE STARTING");
    log("=".repeat(60));
    log(`Bot base directory: ${BOT_BASE_DIR}`);
    log(`Sync interval: ${SYNC_INTERVAL} seconds`);
    log(`Sync script: ${SYNC_SCRIPT}`);

    // Check requirements
    if (!process.env.TURSO_API_KEY) {
        log("ERROR: TURSO_API_KEY environment variable is required");
        process.exit(1);
    }

    if (!process.env.TURSO_ORG) {
        log("ERROR: TURSO_ORG environment variable is required");
        process.exit(1);
    }

    if (!await fs.pathExists(SYNC_SCRIPT)) {
        log(`ERROR: Sync script not found: ${SYNC_SCRIPT}`);
        process.exit(1);
    }

    log("✓ Environment check passed");
    log("=".repeat(60));

    // Perform initial sync
    await performSyncCycle();

    // Set up periodic sync
    const syncInterval = setInterval(async () => {
        await performSyncCycle();
    }, SYNC_INTERVAL * 1000);

    // Status reporting interval (every 30 minutes)
    const statusInterval = setInterval(() => {
        log(`SYNC STATS: Total: ${syncStats.totalSyncs}, Success: ${syncStats.successfulSyncs}, Failed: ${syncStats.failedSyncs}, Last: ${syncStats.lastSyncTime || 'Never'}`);
        log(`ACTIVE SYNCS: ${activeSyncs.size} running`);
    }, 30 * 60 * 1000);

    // Graceful shutdown
    process.on('SIGTERM', () => {
        log('SIGTERM received, shutting down sync service...');
        clearInterval(syncInterval);
        clearInterval(statusInterval);
        process.exit(0);
    });

    process.on('SIGINT', () => {
        log('SIGINT received, shutting down sync service...');
        clearInterval(syncInterval);
        clearInterval(statusInterval);
        process.exit(0);
    });

    log("🚀 Sync service started and ready!");
}

// Start the service
if (require.main === module) {
    startSyncService().catch((error) => {
        console.error('Failed to start sync service:', error);
        process.exit(1);
    });
}

module.exports = {
    findAllBotInstances,
    syncInstance,
    performSyncCycle,
    syncStats
};
