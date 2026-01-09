/**
 * Container Pool Management System
 * 
 * Implements multi-tenant container pooling to reduce resource usage.
 * Each user gets their own pool containers, with 3 bots per pool.
 * Pool naming: {userId}-pool-{N} (e.g., Js1Gaz4sMPPiDNgFbmAgDFLe4je2-pool-1)
 * 
 * Architecture:
 * - Pool Container: A Docker container running a supervisor process
 *   that can manage multiple FreqTrade instances
 * - Each bot gets its own FreqTrade process, SQLite database, and port
 * - Bots are isolated by process, share only container resources
 * - Each user has isolated pools under data/bot-instances/{userId}/
 * 
 * Structure:
 * data/bot-instances/
 *   {userId}/
 *     {userId}-pool-1/
 *       supervisor/
 *       bots/
 *         bot-1/
 *         bot-2/
 *         bot-3/
 *       logs/
 */

const fs = require('fs-extra');
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration - 3 bots per user pool
const MAX_BOTS_PER_CONTAINER = parseInt(process.env.MAX_BOTS_PER_CONTAINER) || 3;
const POOL_CONTAINER_PREFIX = process.env.POOL_CONTAINER_PREFIX || 'freqtrade-pool';
const POOL_BASE_PORT = parseInt(process.env.POOL_BASE_PORT) || 9000;
// Pool mode uses custom supervisord-enabled image
const POOL_IMAGE = process.env.POOL_IMAGE || 'freqtrade-pool:latest';
// Bot instances stored under monorepo data directory
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '../../../data/bot-instances');
const SHARED_DATA_DIR = process.env.SHARED_DATA_DIR || path.join(__dirname, '../../../data/shared-market-data');
const STRATEGIES_DIR = process.env.MAIN_STRATEGIES_SOURCE_DIR || path.join(__dirname, '../../../data/strategies');
const POOL_HOST_MODE = (process.env.POOL_HOST_MODE || 'host').toLowerCase(); // host | container | auto
const POOL_HOST_OVERRIDE = process.env.POOL_HOST_OVERRIDE;

// Decide how to reach pool containers (host vs container network)
function isRunningInDocker() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('kubepods');
  } catch (_err) {
    return false;
  }
}

function resolvePoolHost(containerName) {
  if (POOL_HOST_OVERRIDE && POOL_HOST_OVERRIDE.trim()) {
    return POOL_HOST_OVERRIDE.trim();
  }
  if (POOL_HOST_MODE === 'container') {
    return containerName;
  }
  if (POOL_HOST_MODE === 'auto') {
    return isRunningInDocker() ? containerName : 'localhost';
  }
  // Default: host can reach mapped ports on localhost
  return 'localhost';
}

// In-memory state (will be persisted to disk)
let containerPool = new Map(); // poolId -> PoolContainer
let botContainerMapping = new Map(); // instanceId -> { poolId, processId, port }
let poolStateFile = null;

/**
 * Pool Container structure
 * @typedef {Object} PoolContainer
 * @property {string} id - Pool container ID (e.g., 'pool-1')
 * @property {string} containerName - Docker container name
 * @property {number} basePort - Starting port for this container
 * @property {number} capacity - Max bots this container can handle
 * @property {string[]} bots - List of bot instanceIds in this container
 * @property {string} status - 'running' | 'stopped' | 'failed'
 * @property {Date} createdAt - When the container was created
 * @property {Object} metrics - Resource usage metrics
 */

/**
 * Bot Slot structure
 * @typedef {Object} BotSlot
 * @property {string} poolId - Pool container ID
 * @property {number} slotIndex - Position within the pool (0-9)
 * @property {number} port - Assigned port for this bot's FreqTrade API
 * @property {string} status - 'running' | 'stopped'
 * @property {string} instanceId - Bot instance ID
 * @property {string} userId - Owner user ID
 */

class ContainerPoolManager {
  constructor(options = {}) {
    this.maxBotsPerContainer = options.maxBotsPerContainer || MAX_BOTS_PER_CONTAINER;
    this.poolPrefix = options.poolPrefix || POOL_CONTAINER_PREFIX;
    this.basePort = options.basePort || POOL_BASE_PORT;
    this.poolImage = options.poolImage || POOL_IMAGE;
    this.botBaseDir = options.botBaseDir || BOT_BASE_DIR;
    this.sharedDataDir = options.sharedDataDir || SHARED_DATA_DIR;
    this.strategiesDir = options.strategiesDir || STRATEGIES_DIR;
    this.stateFile = options.stateFile || path.join(this.botBaseDir, '.container-pool-state.json');
    
    // State
    this.pools = new Map(); // poolId -> PoolContainer
    this.botMapping = new Map(); // instanceId -> BotSlot
    this.nextPoolId = 1;
    
    // Initialize
    this._loadState();
  }
  /**
   * Load persisted state from disk
   */
  async _loadState() {
    try {
      if (await fs.pathExists(this.stateFile)) {
        const data = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
        
        // Restore pools
        if (data.pools) {
          for (const [id, pool] of Object.entries(data.pools)) {
            this.pools.set(id, pool);
          }
        }
        
        // Restore bot mappings
        if (data.botMapping) {
          for (const [instanceId, slot] of Object.entries(data.botMapping)) {
            this.botMapping.set(instanceId, slot);
          }
        }
        
        this.nextPoolId = data.nextPoolId || 1;
        
        console.log(`[ContainerPool] Loaded state: ${this.pools.size} pools, ${this.botMapping.size} bots`);
      }
    } catch (err) {
      console.warn(`[ContainerPool] Failed to load state: ${err.message}`);
    }
  }

  /**
   * Persist state to disk
   */
  async _saveState() {
    try {
      const data = {
        pools: Object.fromEntries(this.pools),
        botMapping: Object.fromEntries(this.botMapping),
        nextPoolId: this.nextPoolId,
        updatedAt: new Date().toISOString()
      };
      
      await fs.ensureDir(path.dirname(this.stateFile));
      await fs.writeFile(this.stateFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[ContainerPool] Failed to save state: ${err.message}`);
    }
  }

  /**
   * Find a pool container with available capacity for a specific user
   * @param {string} userId - User ID to find pool for
   * @returns {PoolContainer|null}
   */
  findAvailablePool(userId) {
    if (!userId) {
      throw new Error('userId is required for pool allocation');
    }
    
    for (const [id, pool] of this.pools) {
      // Only match pools belonging to this user
      if (pool.userId === userId && pool.status === 'running' && pool.bots.length < pool.capacity) {
        return pool;
      }
    }
    return null;
  }
  
  /**
   * Get all pools for a specific user
   * @param {string} userId - User ID
   * @returns {PoolContainer[]}
   */
  getUserPools(userId) {
    const userPools = [];
    for (const [id, pool] of this.pools) {
      if (pool.userId === userId) {
        userPools.push(pool);
      }
    }
    return userPools;
  }
  
  /**
   * Get the next pool number for a user
   * @param {string} userId - User ID
   * @returns {number}
   */
  _getNextPoolNumberForUser(userId) {
    const userPools = this.getUserPools(userId);
    if (userPools.length === 0) return 1;
    
    // Find the highest pool number
    const poolNumbers = userPools.map(p => {
      const match = p.id.match(/-pool-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });
    return Math.max(...poolNumbers) + 1;
  }

  /**
   * Get the next available port within a pool
   */
  getNextPortForPool(pool) {
    const usedPorts = new Set();
    for (const instanceId of pool.bots) {
      const slot = this.botMapping.get(instanceId);
      if (slot) usedPorts.add(slot.port);
    }
    
    // Find first available port in pool's range
    for (let i = 0; i < pool.capacity; i++) {
      const port = pool.basePort + i;
      if (!usedPorts.has(port)) return port;
    }
    
    throw new Error('No available ports in pool');
  }
  
  /**
   * Get the next available base port for a new pool
   * Ensures no port conflicts with existing pools
   * @returns {number}
   */
  _getNextAvailableBasePort() {
    if (this.pools.size === 0) return this.basePort;
    
    // Find the highest used port across all pools
    let maxPort = this.basePort;
    for (const [id, pool] of this.pools) {
      const poolMaxPort = pool.basePort + pool.capacity;
      if (poolMaxPort > maxPort) maxPort = poolMaxPort;
    }
    return maxPort;
  }

  /**
   * Create a new pool container for a specific user
   * Pool naming: {userId}-pool-N (e.g., Js1Gaz4sMPPiDNgFbmAgDFLe4je2-pool-1)
   * @param {string} userId - User ID who owns this pool
   * @returns {Promise<PoolContainer>}
   */
  async createPoolContainer(userId) {
    if (!userId) {
      throw new Error('userId is required to create a pool container');
    }
    
    const poolNumber = this._getNextPoolNumberForUser(userId);
    const poolId = `${userId}-pool-${poolNumber}`;
    const containerName = `${this.poolPrefix}-${userId}-pool-${poolNumber}`;
    const basePort = this._getNextAvailableBasePort();
    
    console.log(`[ContainerPool] Creating new user pool: ${poolId} (container: ${containerName})`);
    
    // Create user directory if it doesn't exist
    const userDir = path.join(this.botBaseDir, userId);
    await fs.ensureDir(userDir);
    
    // Create pool directory structure under user directory
    // Structure: data/bot-instances/{userId}/{userId}-pool-N/
    const poolDir = path.join(userDir, `${userId}-pool-${poolNumber}`);
    await fs.ensureDir(poolDir);
    await fs.ensureDir(path.join(poolDir, 'supervisor'));
    await fs.ensureDir(path.join(poolDir, 'logs'));
    await fs.ensureDir(path.join(poolDir, 'bots'));
    
    // Create individual bot directories within the pool
    for (let i = 1; i <= this.maxBotsPerContainer; i++) {
      await fs.ensureDir(path.join(poolDir, 'bots', `bot-${i}`));
    }
    
    // Set ownership to UID 1000 (ftuser in container) for writable directories
    await execPromise(`chown -R 1000:1000 "${path.join(poolDir, 'logs')}"`);
    await execPromise(`chown -R 1000:1000 "${path.join(poolDir, 'bots')}"`);
    await execPromise(`chown -R 1000:1000 "${path.join(poolDir, 'supervisor')}"`);
    
    // Create supervisord configuration
    const supervisorConfig = this._generateSupervisorConfig(poolId);
    await fs.writeFile(path.join(poolDir, 'supervisor', 'supervisord.conf'), supervisorConfig);
    
    // Create docker-compose.yml for pool container
    const composeContent = this._generatePoolComposeFile(poolId, containerName, basePort, poolDir);
    await fs.writeFile(path.join(poolDir, 'docker-compose.yml'), composeContent);
    
    // Start the container
    try {
      await this._runDockerCompose(poolDir, ['up', '-d']);
      
      const pool = {
        id: poolId,
        userId,  // Track which user owns this pool
        containerName,
        basePort,
        capacity: this.maxBotsPerContainer,
        bots: [],
        status: 'running',
        createdAt: new Date().toISOString(),
        poolDir,
        metrics: {
          memoryUsageMB: 0,
          cpuPercent: 0,
          lastUpdated: null
        }
      };
      
      this.pools.set(poolId, pool);
      await this._saveState();
      
      console.log(`[ContainerPool] ✓ User pool ${poolId} created and started for user ${userId}`);
      return pool;
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to create pool container: ${err.message}`);
      throw err;
    }
  }

  /**
   * Allocate a slot in a pool for a new bot
   * Finds an existing user pool with capacity, or creates a new user-specific pool
   * @param {string} instanceId - Bot instance ID
   * @param {string} userId - User ID (required - each user has their own pools)
   * @param {Object} botConfig - Bot configuration
   * @returns {Promise<BotSlot>}
   */
  async allocateBotSlot(instanceId, userId, botConfig) {
    if (!userId) {
      throw new Error('userId is required for bot slot allocation');
    }
    
    console.log(`[ContainerPool] Allocating slot for bot ${instanceId} (user: ${userId})`);
    
    // Check if bot already has a slot
    if (this.botMapping.has(instanceId)) {
      console.log(`[ContainerPool] Bot ${instanceId} already has a slot`);
      return this.botMapping.get(instanceId);
    }
    
    // Find or create a pool with capacity FOR THIS USER
    let pool = this.findAvailablePool(userId);
    if (!pool) {
      console.log(`[ContainerPool] No available pool for user ${userId}, creating new one`);
      pool = await this.createPoolContainer(userId);
    }
    
    // Get next available port
    const port = this.getNextPortForPool(pool);
    const slotIndex = pool.bots.length;
    
    // Create bot slot
    const slot = {
      poolId: pool.id,
      containerName: pool.containerName,
      host: resolvePoolHost(pool.containerName),
      slotIndex,
      port,
      status: 'pending',
      instanceId,
      userId,
      createdAt: new Date().toISOString()
    };
    
    // Add bot to pool
    pool.bots.push(instanceId);
    this.botMapping.set(instanceId, slot);
    await this._saveState();
    
    console.log(`[ContainerPool] ✓ Allocated slot ${slotIndex} in ${pool.id} for ${instanceId} on port ${port}`);
    
    return slot;
  }

  /**
   * Start a bot within its assigned pool container
   * @param {string} instanceId - Bot instance ID
   * @param {Object} config - FreqTrade configuration
   */
  async startBotInPool(instanceId, config) {
    const slot = this.botMapping.get(instanceId);
    if (!slot) {
      throw new Error(`No slot allocated for bot ${instanceId}`);
    }
    
    const pool = this.pools.get(slot.poolId);
    if (!pool) {
      throw new Error(`Pool ${slot.poolId} not found`);
    }
    
    console.log(`[ContainerPool] Starting bot ${instanceId} in pool ${pool.id}`);
    
    // Generate bot-specific supervisor program config
    const programConfig = this._generateBotProgramConfig(instanceId, slot, config);
    const programConfigPath = path.join(pool.poolDir, 'supervisor', `bot-${instanceId}.conf`);
    await fs.writeFile(programConfigPath, programConfig);
    
    // Copy bot config into pool directory
    const botConfigDir = path.join(pool.poolDir, 'bots', instanceId);
    await fs.ensureDir(botConfigDir);
    await fs.writeFile(path.join(botConfigDir, 'config.json'), JSON.stringify(config, null, 2));
    
    // Set ownership to ftuser (UID 1000) so bot can write logs and db
    await execPromise(`chown -R 1000:1000 "${botConfigDir}"`);
    
    // Notify supervisord to reload and start the new program
    try {
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'reread'
      ]);
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'update'
      ]);
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'start', `bot-${instanceId}`
      ]);
      
      slot.status = 'running';
      await this._saveState();
      
      console.log(`[ContainerPool] ✓ Bot ${instanceId} started in pool ${pool.id}`);
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to start bot ${instanceId}: ${err.message}`);
      slot.status = 'failed';
      await this._saveState();
      throw err;
    }
  }

  /**
   * Stop a bot within its pool container
   * @param {string} instanceId - Bot instance ID
   */
  async stopBotInPool(instanceId) {
    const slot = this.botMapping.get(instanceId);
    if (!slot) {
      console.warn(`[ContainerPool] No slot found for bot ${instanceId}`);
      return;
    }
    
    const pool = this.pools.get(slot.poolId);
    if (!pool) {
      console.warn(`[ContainerPool] Pool ${slot.poolId} not found`);
      return;
    }
    
    console.log(`[ContainerPool] Stopping bot ${instanceId} in pool ${pool.id}`);
    
    try {
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'stop', `bot-${instanceId}`
      ]);
      
      slot.status = 'stopped';
      await this._saveState();
      
      console.log(`[ContainerPool] ✓ Bot ${instanceId} stopped`);
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to stop bot ${instanceId}: ${err.message}`);
    }
  }

  /**
   * Restart a bot within its pool container
   * Used when strategy file is edited and bot needs to reload
   * @param {string} instanceId - Bot instance ID
   */
  async restartBotInPool(instanceId) {
    const slot = this.botMapping.get(instanceId);
    if (!slot) {
      console.warn(`[ContainerPool] No slot found for bot ${instanceId}`);
      return { success: false, error: 'Bot not found in pool' };
    }
    
    const pool = this.pools.get(slot.poolId);
    if (!pool) {
      console.warn(`[ContainerPool] Pool ${slot.poolId} not found`);
      return { success: false, error: 'Pool not found' };
    }
    
    console.log(`[ContainerPool] Restarting bot ${instanceId} in pool ${pool.id}`);
    
    try {
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'restart', `bot-${instanceId}`
      ]);
      
      slot.status = 'running';
      await this._saveState();
      
      console.log(`[ContainerPool] ✓ Bot ${instanceId} restarted`);
      return { success: true, instanceId };
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to restart bot ${instanceId}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Update bot strategy and restart
   * Used when a strategy is removed and bot needs to fallback to default
   * @param {string} instanceId - Bot instance ID
   * @param {string} newStrategy - New strategy name
   */
  async updateBotStrategyInPool(instanceId, newStrategy) {
    const slot = this.botMapping.get(instanceId);
    if (!slot) {
      console.warn(`[ContainerPool] No slot found for bot ${instanceId}`);
      return { success: false, error: 'Bot not found in pool' };
    }
    
    const pool = this.pools.get(slot.poolId);
    if (!pool) {
      console.warn(`[ContainerPool] Pool ${slot.poolId} not found`);
      return { success: false, error: 'Pool not found' };
    }
    
    console.log(`[ContainerPool] Updating bot ${instanceId} strategy to ${newStrategy}`);
    
    try {
      // Update bot config file
      const botConfigDir = path.join(pool.poolDir, 'bots', instanceId);
      const configPath = path.join(botConfigDir, 'config.json');
      
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        const oldStrategy = config.strategy;
        config.strategy = newStrategy;
        await fs.writeJson(configPath, config, { spaces: 2 });
        console.log(`[ContainerPool] Updated config: ${oldStrategy} → ${newStrategy}`);
      }
      
      // Update supervisor config
      const supervisorConfPath = path.join(pool.poolDir, 'supervisor', `bot-${instanceId}.conf`);
      if (await fs.pathExists(supervisorConfPath)) {
        let supervisorConf = await fs.readFile(supervisorConfPath, 'utf8');
        // Replace strategy in command line
        supervisorConf = supervisorConf.replace(
          /--strategy\s+\S+/,
          `--strategy ${newStrategy}`
        );
        await fs.writeFile(supervisorConfPath, supervisorConf, 'utf8');
        console.log(`[ContainerPool] Updated supervisor config for ${instanceId}`);
      }
      
      // Reload supervisor config and restart bot
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'reread'
      ]);
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'update'
      ]);
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'restart', `bot-${instanceId}`
      ]);
      
      slot.status = 'running';
      await this._saveState();
      
      console.log(`[ContainerPool] ✓ Bot ${instanceId} updated to strategy ${newStrategy} and restarted`);
      return { success: true, instanceId, newStrategy };
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to update bot ${instanceId} strategy: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Remove a bot from its pool container
   * @param {string} instanceId - Bot instance ID
   */
  async removeBotFromPool(instanceId) {
    const slot = this.botMapping.get(instanceId);
    if (!slot) {
      console.warn(`[ContainerPool] No slot found for bot ${instanceId}`);
      return;
    }
    
    const pool = this.pools.get(slot.poolId);
    if (!pool) {
      console.warn(`[ContainerPool] Pool ${slot.poolId} not found`);
      return;
    }
    
    console.log(`[ContainerPool] Removing bot ${instanceId} from pool ${pool.id}`);
    
    try {
      // Stop the bot first
      await this.stopBotInPool(instanceId);
      
      // Remove supervisor program config
      await this._execInContainer(pool.containerName, [
        'supervisorctl', 'remove', `bot-${instanceId}`
      ]);
      
      // Remove from pool's bot list
      pool.bots = pool.bots.filter(id => id !== instanceId);
      
      // Remove mapping
      this.botMapping.delete(instanceId);
      
      // Clean up bot config directory in pool
      const botConfigDir = path.join(pool.poolDir, 'bots', instanceId);
      await fs.remove(botConfigDir);
      
      // Remove supervisor config file
      const programConfigPath = path.join(pool.poolDir, 'supervisor', `bot-${instanceId}.conf`);
      await fs.remove(programConfigPath);
      
      await this._saveState();
      
      console.log(`[ContainerPool] ✓ Bot ${instanceId} removed from pool ${pool.id}`);
      
      // Check if pool is now empty
      if (pool.bots.length === 0) {
        console.log(`[ContainerPool] Pool ${pool.id} is empty, marking for potential cleanup`);
        // Don't auto-remove, let cleanup job handle it
      }
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to remove bot ${instanceId}: ${err.message}`);
    }
  }

  /**
   * Get bot's connection info for API proxying
   * @param {string} instanceId - Bot instance ID
   * @returns {Object} Connection details
   */
  getBotConnectionInfo(instanceId) {
    const slot = this.botMapping.get(instanceId);
    if (!slot) {
      return null;
    }
    
    const host = slot.host || resolvePoolHost(slot.containerName);
    // In pool mode, we connect to the pool container on the bot's assigned port
    return {
      host,
      port: slot.port,
      url: `http://${host}:${slot.port}`,
      poolId: slot.poolId,
      slotIndex: slot.slotIndex,
      containerName: slot.containerName
    };
  }

  /**
   * Check if a bot is in pool mode
   * @param {string} instanceId - Bot instance ID
   * @returns {boolean}
   */
  isBotInPool(instanceId) {
    return this.botMapping.has(instanceId);
  }

  /**
   * Get pool statistics
   */
  getPoolStats() {
    const stats = {
      totalPools: this.pools.size,
      totalBots: this.botMapping.size,
      pools: []
    };
    
    for (const [id, pool] of this.pools) {
      stats.pools.push({
        id: pool.id,
        userId: pool.userId,
        containerName: pool.containerName,
        status: pool.status,
        botsCount: pool.bots.length,
        capacity: pool.capacity,
        utilizationPercent: Math.round((pool.bots.length / pool.capacity) * 100),
        bots: pool.bots
      });
    }
    
    return stats;
  }
  
  /**
   * Get pool statistics for a specific user
   * @param {string} userId - User ID
   * @returns {Object}
   */
  getUserPoolStats(userId) {
    const userPools = this.getUserPools(userId);
    const userBots = [];
    
    for (const pool of userPools) {
      for (const instanceId of pool.bots) {
        const slot = this.botMapping.get(instanceId);
        if (slot) {
          userBots.push({
            instanceId,
            poolId: pool.id,
            slotIndex: slot.slotIndex,
            port: slot.port,
            status: slot.status
          });
        }
      }
    }
    
    return {
      userId,
      totalPools: userPools.length,
      totalBots: userBots.length,
      maxBotsPerPool: this.maxBotsPerContainer,
      pools: userPools.map(pool => ({
        id: pool.id,
        containerName: pool.containerName,
        status: pool.status,
        botsCount: pool.bots.length,
        capacity: pool.capacity,
        utilizationPercent: Math.round((pool.bots.length / pool.capacity) * 100),
        bots: pool.bots,
        metrics: pool.metrics
      })),
      bots: userBots
    };
  }

  /**
   * Clean up empty pool containers
   */
  async cleanupEmptyPools() {
    const toRemove = [];

    for (const [id, pool] of this.pools) {
      if (pool.bots.length === 0 && pool.status === 'running') {
        toRemove.push(id);
      }
    }

    for (const poolId of toRemove) {
      const pool = this.pools.get(poolId);
      console.log(`[ContainerPool] Cleaning up empty pool ${poolId}`);

      try {
        await this._runDockerCompose(pool.poolDir, ['down', '-v']);
        await fs.remove(pool.poolDir);
        this.pools.delete(poolId);

        console.log(`[ContainerPool] ✓ Pool ${poolId} removed`);
      } catch (err) {
        console.error(`[ContainerPool] Failed to remove pool ${poolId}: ${err.message}`);
      }
    }

    await this._saveState();
    return toRemove.length;
  }

  /**
   * Sync pool state with actual running bots
   * Fixes discrepancies between pool state file and reality
   */
  async syncPoolState() {
    console.log('[ContainerPool] Starting pool state sync...');
    const results = {
      poolsChecked: 0,
      botsRemoved: [],
      botsAdded: [],
      poolsUpdated: [],
      errors: []
    };

    for (const [poolId, pool] of this.pools) {
      results.poolsChecked++;

      try {
        // Check if container actually exists
        const { stdout: containerExists } = await execPromise(
          `docker ps -q -f name=${pool.containerName}`
        ).catch(() => ({ stdout: '' }));

        if (!containerExists.trim()) {
          console.log(`[ContainerPool] Pool ${poolId} container not found, marking as stopped`);
          pool.status = 'stopped';
          results.poolsUpdated.push(poolId);
          continue;
        }

        // Get actual running bots from supervisor
        const { stdout: supervisorStatus } = await execPromise(
          `docker exec ${pool.containerName} supervisorctl status`
        ).catch(() => ({ stdout: '' }));

        const runningBots = new Set();
        const lines = supervisorStatus.split('\n');
        for (const line of lines) {
          const match = line.match(/^bot-([^\s]+)\s+RUNNING/);
          if (match) {
            runningBots.add(match[1]);
          }
        }

        // Find bots in state but not actually running
        const staleBots = pool.bots.filter(botId => !runningBots.has(botId));

        for (const botId of staleBots) {
          console.log(`[ContainerPool] Removing stale bot ${botId} from pool ${poolId}`);
          pool.bots = pool.bots.filter(id => id !== botId);
          this.botMapping.delete(botId);
          results.botsRemoved.push({ botId, poolId, reason: 'not_running' });
        }

        // Find running bots not in state (shouldn't happen, but handle it)
        for (const botId of runningBots) {
          if (!pool.bots.includes(botId)) {
            console.log(`[ContainerPool] Found orphaned bot ${botId} in pool ${poolId}`);
            // Don't add it back - this indicates a deeper issue
            results.errors.push({
              type: 'orphaned_bot',
              botId,
              poolId,
              message: 'Bot running in supervisor but not in pool state'
            });
          }
        }

        if (staleBots.length > 0) {
          results.poolsUpdated.push(poolId);
        }

      } catch (err) {
        console.error(`[ContainerPool] Error syncing pool ${poolId}:`, err.message);
        results.errors.push({
          type: 'sync_error',
          poolId,
          message: err.message
        });
      }
    }

    await this._saveState();

    console.log(`[ContainerPool] Sync complete: ${results.botsRemoved.length} bots removed, ${results.poolsUpdated.length} pools updated`);

    return results;
  }

  /**
   * Update pool container metrics
   */
  async updatePoolMetrics() {
    for (const [id, pool] of this.pools) {
      if (pool.status !== 'running') continue;
      
      try {
        const { stdout } = await execPromise(
          `docker stats ${pool.containerName} --no-stream --format "{{.MemUsage}},{{.CPUPerc}}"`
        );
        
        const parts = stdout.trim().split(',');
        const memMatch = parts[0]?.match(/(\d+(\.\d+)?)(MiB|GiB)/);
        const cpuMatch = parts[1]?.match(/(\d+(\.\d+)?)%/);
        
        if (memMatch) {
          let memMB = parseFloat(memMatch[1]);
          if (memMatch[3] === 'GiB') memMB *= 1024;
          pool.metrics.memoryUsageMB = Math.round(memMB);
        }
        
        if (cpuMatch) {
          pool.metrics.cpuPercent = parseFloat(cpuMatch[1]);
        }
        
        pool.metrics.lastUpdated = new Date().toISOString();
        
      } catch (err) {
        console.warn(`[ContainerPool] Failed to update metrics for ${pool.containerName}: ${err.message}`);
      }
    }
    
    await this._saveState();
  }

  // ==================== Private Helper Methods ====================

  _generateSupervisorConfig(poolId) {
    // Note: The base supervisord is pre-configured in the freqtrade-pool image
    // This generates the per-pool include config that references bot configs
    return `; Supervisor config for pool ${poolId}
; Bot configs are in /etc/supervisor/conf.d/bot-*.conf

[supervisord]
nodaemon=true
logfile=/pool/logs/supervisord.log
pidfile=/tmp/supervisord.pid
childlogdir=/pool/logs

[unix_http_server]
file=/tmp/supervisor.sock
chmod=0700

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///tmp/supervisor.sock

[include]
files = /pool/supervisor/bot-*.conf
`;
  }

  _generatePoolComposeFile(poolId, containerName, basePort, poolDir) {
    // Port range for this pool
    const portRangeEnd = basePort + this.maxBotsPerContainer - 1;
    const portMappings = [];
    for (let p = basePort; p <= portRangeEnd; p++) {
      portMappings.push(`      - "${p}:${p}"`);
    }
    
    return `version: '3.8'
services:
  freqtrade-pool:
    image: ${this.poolImage}
    container_name: ${containerName}
    restart: unless-stopped
    volumes:
      # Pool-level config and supervisor files (rw for dynamic bot configs)
      - ${poolDir}/supervisor:/pool/supervisor:rw
      - ${poolDir}/bots:/pool/bots:rw
      - ${poolDir}/logs:/pool/logs:rw
      # Shared strategies (read-only, same for all bots)
      - ${this.strategiesDir}:/pool/strategies:ro
      # Shared market data
      - ${this.sharedDataDir}:/freqtrade/shared_data:ro
    ports:
${portMappings.join('\n')}
    environment:
      - POOL_ID=${poolId}
    healthcheck:
      test: ["CMD", "/usr/local/bin/healthcheck.sh"]
      interval: 30s
      timeout: 10s
      retries: 3
`;
  }

  _generateBotProgramConfig(instanceId, slot, config) {
    const botDir = `/pool/bots/${instanceId}`;
    const configPath = `${botDir}/config.json`;
    const logPath = `/pool/logs/bot-${instanceId}.log`;

    // Fallback strategy resolution: prefer requested, otherwise safe default EmaRsiStrategy
    const requestedStrategy = config.strategy || 'EmaRsiStrategy';
    const strategyPaths = [
      path.join(this.strategiesDir, `${requestedStrategy}.py`),
      path.join(this.strategiesDir, 'Admin Strategies', `${requestedStrategy}.py`)
    ];
    const strategyExists = strategyPaths.some(p => fs.existsSync(p));
    const resolvedStrategy = strategyExists ? requestedStrategy : 'EmaRsiStrategy';
    if (!strategyExists && requestedStrategy !== 'EmaRsiStrategy') {
      console.warn(`[${instanceId}] Requested strategy '${requestedStrategy}' not found; falling back to EmaRsiStrategy`);
    }
    
    return `[program:bot-${instanceId}]
command=freqtrade trade --config ${configPath} --strategy-path /pool/strategies --strategy ${resolvedStrategy} --db-url sqlite:///${botDir}/tradesv3.sqlite --logfile ${botDir}/freqtrade.log
directory=/freqtrade
user=ftuser
autostart=true
autorestart=true
startretries=3
startsecs=10
redirect_stderr=true
stdout_logfile=${logPath}
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
environment=FREQTRADE_USER_DATA_DIR="/pool/bots/${instanceId}"
`;
  }

  async _runDockerCompose(workDir, args) {
    return new Promise((resolve, reject) => {
      // Use 'docker compose' (plugin) instead of 'docker-compose' (Python)
      const proc = spawn('docker', ['compose', ...args], { cwd: workDir });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', data => { stdout += data; });
      proc.stderr.on('data', data => { stderr += data; });
      
      proc.on('close', code => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`docker compose ${args.join(' ')} failed (code ${code}): ${stderr}`));
        }
      });
      
      proc.on('error', reject);
    });
  }

  async _execInContainer(containerName, command) {
    const cmdStr = `docker exec ${containerName} ${command.join(' ')}`;
    return execPromise(cmdStr);
  }
}

// Singleton instance
let poolManager = null;

function getPoolManager(options) {
  if (!poolManager) {
    poolManager = new ContainerPoolManager(options);
  }
  return poolManager;
}

module.exports = {
  ContainerPoolManager,
  getPoolManager,
  MAX_BOTS_PER_CONTAINER,
  POOL_CONTAINER_PREFIX,
  POOL_BASE_PORT
};
