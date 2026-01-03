/**
 * Bot-to-Container Mapper
 * 
 * Manages the mapping between bot instances and their container assignments.
 * Supports both legacy mode (1 container per bot) and pool mode (multiple bots per container).
 * 
 * Features:
 * - Automatic migration path from legacy to pool mode
 * - Load balancing for new bot assignments
 * - Container discovery for API routing
 * - Graceful fallback for legacy bots
 */

const fs = require('fs-extra');
const path = require('path');
const { getPoolManager } = require('./container-pool');

// Configuration
const POOL_MODE_ENABLED = process.env.POOL_MODE_ENABLED !== 'false'; // Default: enabled
const LEGACY_CONTAINER_PREFIX = 'freqtrade-';
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || '/root/Crypto-Pilot-Freqtrade/freqtrade-instances';

/**
 * Bot connection info structure
 * @typedef {Object} BotConnection
 * @property {string} host - Container hostname or IP
 * @property {number} port - FreqTrade API port
 * @property {string} url - Full URL to FreqTrade API
 * @property {boolean} isPooled - Whether bot is in a pool container
 * @property {string} containerName - Docker container name
 * @property {string|null} poolId - Pool ID if pooled, null otherwise
 */

class BotContainerMapper {
  constructor(options = {}) {
    this.poolModeEnabled = options.poolModeEnabled ?? POOL_MODE_ENABLED;
    this.legacyPrefix = options.legacyPrefix || LEGACY_CONTAINER_PREFIX;
    this.botBaseDir = options.botBaseDir || BOT_BASE_DIR;
    this.poolManager = options.poolManager || getPoolManager();
    
    // Cache for legacy bot configs
    this.legacyConfigCache = new Map();
    this.legacyCacheExpiry = 60 * 1000; // 1 minute
  }

  /**
   * Get the container connection info for a bot
   * Works for both pooled and legacy bots
   * 
   * @param {string} instanceId - Bot instance ID
   * @returns {Promise<BotConnection>}
   */
  async getBotConnection(instanceId) {
    // Check if bot is in pool mode
    if (this.poolManager.isBotInPool(instanceId)) {
      const poolInfo = this.poolManager.getBotConnectionInfo(instanceId);
      
      // Get credentials from bot's config.json (pooled bots still have their own config)
      let username, password;
      try {
        const instanceDir = await this._resolveInstanceDir(instanceId);
        if (instanceDir) {
          const configPath = path.join(instanceDir, 'config.json');
          if (await fs.pathExists(configPath)) {
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            username = config.api_server?.username;
            password = config.api_server?.password;
          }
        }
      } catch (err) {
        console.warn(`[BotMapper] Failed to read credentials for pooled bot ${instanceId}: ${err.message}`);
      }
      
      return {
        host: poolInfo.host,
        port: poolInfo.port,
        url: poolInfo.url,
        isPooled: true,
        containerName: poolInfo.containerName,
        poolId: poolInfo.poolId,
        username: username || process.env.DEFAULT_BOT_API_USERNAME,
        password: password || process.env.DEFAULT_BOT_API_PASSWORD
      };
    }
    
    // Fallback to legacy mode
    return this._getLegacyBotConnection(instanceId);
  }

  /**
   * Get legacy bot connection info by reading its config.json
   * @private
   */
  async _getLegacyBotConnection(instanceId) {
    // Check cache first
    const cached = this.legacyConfigCache.get(instanceId);
    if (cached && cached.expiry > Date.now()) {
      return cached.connection;
    }
    
    // Find instance directory
    const instanceDir = await this._resolveInstanceDir(instanceId);
    if (!instanceDir) {
      throw new Error(`Instance directory not found for ${instanceId}`);
    }
    
    // Read config.json
    const configPath = path.join(instanceDir, 'config.json');
    if (!await fs.pathExists(configPath)) {
      throw new Error(`config.json not found for ${instanceId}`);
    }
    
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const port = config.api_server?.listen_port;
    
    if (!port) {
      throw new Error(`listen_port missing in config for ${instanceId}`);
    }
    
    // In production, use container name; in dev, use localhost
    const isProduction = process.env.NODE_ENV === 'production';
    const containerName = `${this.legacyPrefix}${instanceId}`;
    const host = isProduction ? containerName : 'localhost';
    
    // Legacy containers expose their API on the same port inside and outside
    // But for production, we connect to container name on internal port 8080
    const targetPort = isProduction ? 8080 : port;
    
    const connection = {
      host,
      port: targetPort,
      externalPort: port, // Port exposed on host
      url: `http://${host}:${targetPort}`,
      isPooled: false,
      containerName,
      poolId: null,
      username: config.api_server?.username,
      password: config.api_server?.password
    };
    
    // Cache the connection
    this.legacyConfigCache.set(instanceId, {
      connection,
      expiry: Date.now() + this.legacyCacheExpiry
    });
    
    return connection;
  }

  /**
   * Resolve instance directory for a bot
   * @private
   */
  async _resolveInstanceDir(instanceId) {
    // Direct path if userId is part of instanceId (e.g., user-bot-1)
    const directPath = path.join(this.botBaseDir, instanceId);
    if (await fs.pathExists(directPath)) {
      return directPath;
    }
    
    // Search through user directories
    if (!await fs.pathExists(this.botBaseDir)) {
      return null;
    }
    
    const users = await fs.readdir(this.botBaseDir);
    for (const userId of users) {
      const userDir = path.join(this.botBaseDir, userId);
      if (!(await fs.stat(userDir)).isDirectory()) continue;
      
      // Check for legacy structure: {botBaseDir}/{userId}/{instanceId}
      const legacyInstancePath = path.join(userDir, instanceId);
      if (await fs.pathExists(legacyInstancePath)) {
        return legacyInstancePath;
      }
      
      // Check for pool structure: {botBaseDir}/{userId}/{poolId}/bots/{instanceId}
      const poolDirs = await fs.readdir(userDir);
      for (const poolDir of poolDirs) {
        const poolPath = path.join(userDir, poolDir);
        if (!(await fs.stat(poolPath)).isDirectory()) continue;
        
        // Check if this is a pool directory with a bots subdirectory
        const botsDir = path.join(poolPath, 'bots');
        if (await fs.pathExists(botsDir)) {
          const poolInstancePath = path.join(botsDir, instanceId);
          if (await fs.pathExists(poolInstancePath)) {
            return poolInstancePath;
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Assign a new bot to a container
   * Uses pool mode if enabled, otherwise creates legacy container
   * 
   * @param {string} instanceId - Bot instance ID
   * @param {string} userId - User ID
   * @param {Object} botConfig - FreqTrade configuration
   * @returns {Promise<BotConnection>}
   */
  async assignBotToContainer(instanceId, userId, botConfig) {
    if (this.poolModeEnabled) {
      console.log(`[BotMapper] Assigning bot ${instanceId} to pool`);
      
      // Allocate slot in pool
      const slot = await this.poolManager.allocateBotSlot(instanceId, userId, botConfig);
      const host = slot.host || slot.containerName;
      
      return {
        host,
        port: slot.port,
        url: `http://${host}:${slot.port}`,
        isPooled: true,
        containerName: slot.containerName,
        poolId: slot.poolId
      };
    }
    
    // Legacy mode - return info for a dedicated container
    console.log(`[BotMapper] Pool mode disabled, using legacy mode for ${instanceId}`);
    const containerName = `${this.legacyPrefix}${instanceId}`;
    const port = botConfig.api_server?.listen_port || 8080;
    
    return {
      host: containerName,
      port,
      url: `http://${containerName}:${port}`,
      isPooled: false,
      containerName,
      poolId: null
    };
  }

  /**
   * Start a bot in its assigned container
   * @param {string} instanceId - Bot instance ID
   * @param {Object} config - FreqTrade configuration
   */
  async startBot(instanceId, config) {
    if (this.poolManager.isBotInPool(instanceId)) {
      await this.poolManager.startBotInPool(instanceId, config);
    } else {
      // Legacy mode: container start is handled by provisioning process
      console.log(`[BotMapper] Legacy bot ${instanceId} - start handled by docker-compose`);
    }
  }

  /**
   * Stop a bot in its container
   * @param {string} instanceId - Bot instance ID
   */
  async stopBot(instanceId) {
    if (this.poolManager.isBotInPool(instanceId)) {
      await this.poolManager.stopBotInPool(instanceId);
    } else {
      // Legacy mode: stop via docker
      console.log(`[BotMapper] Stopping legacy bot ${instanceId}`);
      const { exec } = require('child_process');
      const containerName = `${this.legacyPrefix}${instanceId}`;
      return new Promise((resolve, reject) => {
        exec(`docker stop ${containerName}`, (err, stdout, stderr) => {
          if (err) {
            console.error(`[BotMapper] Failed to stop ${containerName}: ${err.message}`);
            reject(err);
          } else {
            console.log(`[BotMapper] ✓ Stopped ${containerName}`);
            resolve();
          }
        });
      });
    }
  }

  /**
   * Remove a bot from its container
   * @param {string} instanceId - Bot instance ID
   */
  async removeBot(instanceId) {
    if (this.poolManager.isBotInPool(instanceId)) {
      await this.poolManager.removeBotFromPool(instanceId);
    } else {
      // Legacy mode: remove container
      console.log(`[BotMapper] Removing legacy bot ${instanceId}`);
      const { exec } = require('child_process');
      const containerName = `${this.legacyPrefix}${instanceId}`;
      return new Promise((resolve) => {
        exec(`docker rm -f ${containerName}`, (err) => {
          if (err) {
            console.warn(`[BotMapper] Container ${containerName} may already be removed`);
          } else {
            console.log(`[BotMapper] ✓ Removed ${containerName}`);
          }
          resolve();
        });
      });
    }
    
    // Clear cache
    this.legacyConfigCache.delete(instanceId);
  }

  /**
   * Check if a bot is running
   * @param {string} instanceId - Bot instance ID
   * @returns {Promise<boolean>}
   */
  async isBotRunning(instanceId) {
    try {
      const connection = await this.getBotConnection(instanceId);
      
      // Try to ping the bot API
      const fetch = require('node-fetch');
      const response = await fetch(`${connection.url}/api/v1/ping`, {
        timeout: 5000
      });
      
      return response.ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * Get all bots for a user
   * @param {string} userId - User ID
   * @returns {Promise<Array>}
   */
  async getUserBots(userId) {
    const bots = [];
    
    // Check pool-managed bots
    const poolStats = this.poolManager.getPoolStats();
    for (const pool of poolStats.pools) {
      for (const instanceId of pool.bots) {
        const slot = this.poolManager.botMapping?.get(instanceId);
        if (slot?.userId === userId) {
          bots.push({
            instanceId,
            mode: 'pooled',
            poolId: pool.id,
            containerName: pool.containerName,
            port: slot.port,
            status: slot.status
          });
        }
      }
    }
    
    // Check legacy bots (from filesystem)
    const userDir = path.join(this.botBaseDir, userId);
    if (await fs.pathExists(userDir)) {
      const instances = await fs.readdir(userDir);
      for (const instanceId of instances) {
        // Skip if already found as pooled
        if (bots.some(b => b.instanceId === instanceId)) continue;
        
        const configPath = path.join(userDir, instanceId, 'config.json');
        if (await fs.pathExists(configPath)) {
          bots.push({
            instanceId,
            mode: 'legacy',
            poolId: null,
            containerName: `${this.legacyPrefix}${instanceId}`,
            port: null, // Would need to read config
            status: 'unknown'
          });
        }
      }
    }
    
    return bots;
  }

  /**
   * Get system-wide statistics
   */
  getStats() {
    const poolStats = this.poolManager.getPoolStats();
    
    return {
      poolModeEnabled: this.poolModeEnabled,
      ...poolStats,
      legacyCacheSize: this.legacyConfigCache.size
    };
  }

  /**
   * Clear cached connection info
   */
  clearCache(instanceId = null) {
    if (instanceId) {
      this.legacyConfigCache.delete(instanceId);
    } else {
      this.legacyConfigCache.clear();
    }
  }
}

// Singleton instance
let mapper = null;

function getMapper(options) {
  if (!mapper) {
    mapper = new BotContainerMapper(options);
  }
  return mapper;
}

module.exports = {
  BotContainerMapper,
  getMapper,
  POOL_MODE_ENABLED,
  LEGACY_CONTAINER_PREFIX
};
