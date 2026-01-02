/**
 * Container Pool Management System
 * 
 * Implements multi-tenant container pooling to reduce resource usage.
 * Instead of one container per bot (~500MB each), this system manages
 * pool containers that each handle multiple bots (~600MB for 10 bots).
 * 
 * Architecture:
 * - Pool Container: A Docker container running a supervisor process
 *   that can manage multiple FreqTrade instances
 * - Each bot gets its own FreqTrade process, SQLite database, and port
 * - Bots are isolated by process, share only container resources
 * 
 * Savings: 50 bots = 5 containers × 600MB = 3GB (vs 25GB with 1:1)
 */

const fs = require('fs-extra');
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration
const MAX_BOTS_PER_CONTAINER = parseInt(process.env.MAX_BOTS_PER_CONTAINER) || 10;
const POOL_CONTAINER_PREFIX = 'freqtrade-pool';
const POOL_BASE_PORT = parseInt(process.env.POOL_BASE_PORT) || 9000;
const FREQTRADE_IMAGE = process.env.FREQTRADE_IMAGE || 'freqtradeorg/freqtrade:stable';
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || '/root/Crypto-Pilot-Freqtrade/freqtrade-instances';
const SHARED_DATA_DIR = process.env.SHARED_DATA_DIR || '/root/Crypto-Pilot-Freqtrade/freqtrade_shared_data';

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
    this.freqtradeImage = options.freqtradeImage || FREQTRADE_IMAGE;
    this.botBaseDir = options.botBaseDir || BOT_BASE_DIR;
    this.sharedDataDir = options.sharedDataDir || SHARED_DATA_DIR;
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
   * Find a pool container with available capacity
   * @returns {PoolContainer|null}
   */
  findAvailablePool() {
    for (const [id, pool] of this.pools) {
      if (pool.status === 'running' && pool.bots.length < pool.capacity) {
        return pool;
      }
    }
    return null;
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
   * Create a new pool container
   * @returns {Promise<PoolContainer>}
   */
  async createPoolContainer() {
    const poolId = `pool-${this.nextPoolId++}`;
    const containerName = `${this.poolPrefix}-${poolId}`;
    const basePort = this.basePort + (this.nextPoolId - 1) * this.maxBotsPerContainer;
    
    console.log(`[ContainerPool] Creating new pool container: ${containerName}`);
    
    // Create pool directory structure
    const poolDir = path.join(this.botBaseDir, '.pools', poolId);
    await fs.ensureDir(poolDir);
    await fs.ensureDir(path.join(poolDir, 'supervisor'));
    await fs.ensureDir(path.join(poolDir, 'logs'));
    
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
      
      console.log(`[ContainerPool] ✓ Pool container ${containerName} created and started`);
      return pool;
      
    } catch (err) {
      console.error(`[ContainerPool] Failed to create pool container: ${err.message}`);
      throw err;
    }
  }

  /**
   * Allocate a slot in a pool for a new bot
   * @param {string} instanceId - Bot instance ID
   * @param {string} userId - User ID
   * @param {Object} botConfig - Bot configuration
   * @returns {Promise<BotSlot>}
   */
  async allocateBotSlot(instanceId, userId, botConfig) {
    console.log(`[ContainerPool] Allocating slot for bot ${instanceId}`);
    
    // Check if bot already has a slot
    if (this.botMapping.has(instanceId)) {
      console.log(`[ContainerPool] Bot ${instanceId} already has a slot`);
      return this.botMapping.get(instanceId);
    }
    
    // Find or create a pool with capacity
    let pool = this.findAvailablePool();
    if (!pool) {
      console.log(`[ContainerPool] No available pool, creating new one`);
      pool = await this.createPoolContainer();
    }
    
    // Get next available port
    const port = this.getNextPortForPool(pool);
    const slotIndex = pool.bots.length;
    
    // Create bot slot
    const slot = {
      poolId: pool.id,
      containerName: pool.containerName,
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
    
    // In pool mode, we connect to the pool container on the bot's assigned port
    return {
      host: slot.containerName,
      port: slot.port,
      url: `http://${slot.containerName}:${slot.port}`,
      poolId: slot.poolId,
      slotIndex: slot.slotIndex
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
    return `[supervisord]
nodaemon=true
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisord.pid
childlogdir=/var/log/supervisor

[unix_http_server]
file=/var/run/supervisor.sock
chmod=0700

[rpcinterface:supervisor]
supervisor.rpc_interface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///var/run/supervisor.sock

[include]
files = /etc/supervisor/conf.d/bot-*.conf
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
    image: ${this.freqtradeImage}
    container_name: ${containerName}
    restart: unless-stopped
    entrypoint: ["/bin/bash", "-c"]
    command:
      - |
        # Install supervisor
        apt-get update && apt-get install -y supervisor
        mkdir -p /var/log/supervisor /etc/supervisor/conf.d
        cp /pool/supervisor/supervisord.conf /etc/supervisor/supervisord.conf
        # Copy any existing bot configs
        cp /pool/supervisor/bot-*.conf /etc/supervisor/conf.d/ 2>/dev/null || true
        # Start supervisord
        exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
    volumes:
      # Pool-level config and supervisor files
      - ${poolDir}/supervisor:/pool/supervisor:ro
      - ${poolDir}/bots:/pool/bots:rw
      - ${poolDir}/logs:/var/log/supervisor:rw
      # Shared market data
      - ${this.sharedDataDir}:/freqtrade/shared_data:ro
    ports:
${portMappings.join('\n')}
    environment:
      - POOL_ID=${poolId}
    healthcheck:
      test: ["CMD", "supervisorctl", "status"]
      interval: 30s
      timeout: 10s
      retries: 3
`;
  }

  _generateBotProgramConfig(instanceId, slot, config) {
    const botDir = `/pool/bots/${instanceId}`;
    const configPath = `${botDir}/config.json`;
    const logPath = `/var/log/supervisor/bot-${instanceId}.log`;
    
    return `[program:bot-${instanceId}]
command=freqtrade trade --config ${configPath} --db-url sqlite:///${botDir}/tradesv3.sqlite --logfile ${botDir}/freqtrade.log
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
      const proc = spawn('docker-compose', args, { cwd: workDir });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', data => { stdout += data; });
      proc.stderr.on('data', data => { stderr += data; });
      
      proc.on('close', code => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`docker-compose ${args.join(' ')} failed (code ${code}): ${stderr}`));
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
