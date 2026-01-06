/**
 * Multi-Tenant Container Pool Integration
 * 
 * This module provides the main integration point for the container pool system.
 * It exports functions that can be called from the main bot-orchestrator to:
 * - Provision bots in pool mode
 * - Route API requests to the correct container
 * - Manage bot lifecycle (start, stop, delete)
 * - Monitor pool health
 * 
 * Usage in index.js:
 *   const { poolProvisioner, initPoolSystem } = require('./lib/pool-integration');
 *   await initPoolSystem();
 *   // Then use poolProvisioner.provisionBot(...) instead of legacy provisioning
 */

const fs = require('fs-extra');
const path = require('path');
const { getPoolManager } = require('./container-pool');
const { getMapper } = require('./bot-container-mapper');
const { getHealthMonitor } = require('./pool-health-monitor');

// Configuration
const POOL_MODE_ENABLED = process.env.POOL_MODE_ENABLED !== 'false';
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '../../../data/bot-instances');
const MAIN_STRATEGIES_SOURCE_DIR = process.env.MAIN_STRATEGIES_SOURCE_DIR || '/root/crypto-trading-platform/data/strategies';

// Global instances
let poolManager = null;
let botMapper = null;
let healthMonitor = null;
let initialized = false;

/**
 * Initialize the pool system
 * Call this once at startup
 */
async function initPoolSystem(options = {}) {
  if (initialized) {
    console.log('[PoolIntegration] Already initialized');
    return;
  }
  
  console.log('[PoolIntegration] Initializing pool system...');
  console.log(`[PoolIntegration] Pool mode: ${POOL_MODE_ENABLED ? 'ENABLED' : 'DISABLED (legacy mode)'}`);
  
  // Initialize components
  poolManager = getPoolManager({
    botBaseDir: BOT_BASE_DIR,
    ...options.poolManager
  });
  
  botMapper = getMapper({
    poolModeEnabled: POOL_MODE_ENABLED,
    botBaseDir: BOT_BASE_DIR,
    poolManager,
    ...options.mapper
  });
  
  healthMonitor = getHealthMonitor({
    poolManager,
    ...options.healthMonitor
  });
  
  // Load persisted state
  await poolManager._loadState();
  
  // Start health monitoring
  if (options.enableHealthMonitor !== false) {
    healthMonitor.start();
  }
  
  initialized = true;
  console.log('[PoolIntegration] ✓ Pool system initialized');
  
  return {
    poolManager,
    botMapper,
    healthMonitor
  };
}

/**
 * Shutdown the pool system gracefully
 */
async function shutdownPoolSystem() {
  console.log('[PoolIntegration] Shutting down pool system...');
  
  if (healthMonitor) {
    healthMonitor.stop();
  }
  
  if (poolManager) {
    await poolManager._saveState();
  }
  
  initialized = false;
  console.log('[PoolIntegration] ✓ Pool system shutdown complete');
}

/**
 * Pool-aware bot provisioner
 * Provides the same interface as legacy provisioning but uses container pools
 */
const poolProvisioner = {
  /**
   * Check if pool mode is enabled
   */
  isPoolModeEnabled() {
    return POOL_MODE_ENABLED && initialized;
  },

  /**
   * Provision a new bot using the pool system
   * 
   * @param {Object} params - Provisioning parameters
   * @param {string} params.instanceId - Bot instance ID
   * @param {string} params.userId - User ID
   * @param {number} params.port - API port (will be overridden in pool mode)
   * @param {string} params.strategy - Strategy name
   * @param {Object} params.config - Full FreqTrade config
   * @returns {Promise<Object>} Provisioning result
   */
  async provisionBot(params) {
    const {
      instanceId,
      userId,
      port,
      strategy,
      tradingPairs,
      initialBalance,
      exchangeConfig,
      apiUsername,
      apiPassword,
      enhanced = false,
      riskTemplate,
      customRiskConfig,
      // Additional config options from frontend
      stake_amount,
      max_open_trades,
      timeframe,
      exchange,
      stake_currency
    } = params;
    
    console.log(`[PoolProvisioner] Provisioning bot ${instanceId} for user ${userId}`);
    
    if (!initialized) {
      throw new Error('Pool system not initialized. Call initPoolSystem() first.');
    }
    
    // Create bot directory structure in pool
    // Structure: data/bot-instances/{userId}/{userId}-pool-N/bots/{instanceId}/
    // The pool directory is created by container-pool.js when allocating slots
    const userDir = path.join(BOT_BASE_DIR, userId);
    await fs.ensureDir(userDir);
    
    console.log(`[PoolProvisioner] User directory ensured: ${userDir}`);
    
    // Assign bot to container (this will create pool if needed)
    const assignment = await botMapper.assignBotToContainer(instanceId, userId, { port });
    
    // In pool mode, ALL bot data is stored in pool's bots directory
    // No reference directories needed - everything is in the pool
    console.log(`[PoolProvisioner] Bot assigned to pool ${assignment.poolId} at slot ${assignment.slotIndex}`);
    
    // Build config with user-specified values or defaults
    const finalTradingPairs = tradingPairs?.length > 0 ? tradingPairs : ["BTC/USD", "ETH/USD", "ADA/USD", "SOL/USD"];
    const finalInitialBalance = Number(initialBalance);
    if (!Number.isFinite(finalInitialBalance) || finalInitialBalance <= 0) {
      throw new Error('Invalid initial balance for provisioning');
    }
    const finalStakeAmount = Number(stake_amount) || 100;
    const finalMaxOpenTrades = Number(max_open_trades) || 3;
    const finalTimeframe = timeframe || '15m';
    const finalExchange = exchange || 'kraken';
    const finalStakeCurrency = stake_currency || 'USD';
    
    // Determine strategy (use provided or default)
    let defaultStrategy = strategy || 'EmaRsiStrategy';
    // Strategies are mounted in the pool container from shared location, no need to check files here
    
    // Build final config with assigned port
    const configJson = {
      userId,
      max_open_trades: finalMaxOpenTrades,
      stake_currency: finalStakeCurrency,
      stake_amount: finalStakeAmount,
      tradable_balance_ratio: 1,
      dry_run: true,
      dry_run_wallet: {
        "USD": finalInitialBalance
      },
      cancel_open_orders_on_exit: false,
      trading_mode: "spot",
      margin_mode: "isolated",
      strategy: defaultStrategy,
      db_url: assignment.isPooled
        ? `sqlite:////pool/bots/${instanceId}/tradesv3.sqlite`
        : "sqlite:///user_data/tradesv3.sqlite",
      logfile: assignment.isPooled
        ? `/pool/bots/${instanceId}/freqtrade.log`
        : "/freqtrade/user_data/logs/freqtrade.log",
      timeframe: finalTimeframe,
      unfilledtimeout: { entry: 10, exit: 10, exit_timeout_count: 0, unit: "minutes" },
      entry_pricing: { price_side: "same", use_order_book: true, order_book_top: 1 },
      exit_pricing: { price_side: "same", use_order_book: true, order_book_top: 1 },
      exchange: exchangeConfig || {
        name: finalExchange,
        key: "",
        secret: "",
        ccxt_config: {},
        ccxt_async_config: {},
        pair_whitelist: finalTradingPairs,
        pair_blacklist: [],
        sandbox: false
      },
      pairlists: [{ method: "StaticPairList" }],
      telegram: { enabled: false, token: "", chat_id: "" },
      api_server: {
        enabled: true,
        listen_ip_address: "0.0.0.0",
        listen_port: assignment.port,
        verbosity: "info",
        enable_openapi: true,
        jwt_secret_key: `aVeryStr0ngStaticPrefix!_${instanceId}_KeepSecret`,
        CORS_origins: [],
        username: apiUsername || `admin_${instanceId.slice(0, 8)}`,
        password: apiPassword || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
      },
      bot_name: `${userId}-bot`,
      initial_state: "running",
      force_entry_enable: false,
      internals: {
        process_throttle_secs: enhanced ? 45 : 60,
        heartbeat_interval: 300,
        sd_notify: false
      }
    };
    
    // Config is written directly to pool by startBotInPool, no need for reference copy
    console.log(`[PoolProvisioner] Config prepared for ${instanceId}`);
    
    if (assignment.isPooled) {
      // Start bot in pool container
      await poolManager.startBotInPool(instanceId, configJson);
      
      console.log(`[PoolProvisioner] ✓ Bot ${instanceId} provisioned in pool ${assignment.poolId} on port ${assignment.port}`);
    } else {
      // Legacy mode: create docker-compose and start
      console.log(`[PoolProvisioner] Bot ${instanceId} using legacy mode (pool disabled)`);
      // Return info for legacy provisioning to continue
    }
    
    return {
      success: true,
      instanceId,
      userId,
      isPooled: assignment.isPooled,
      poolId: assignment.poolId,
      containerName: assignment.containerName,
      port: assignment.port,
      url: assignment.url,
      config: configJson
    };
  },

  /**
   * Start an existing bot
   */
  async startBot(instanceId) {
    if (!initialized) {
      throw new Error('Pool system not initialized');
    }
    
    // In pool mode, the bot is managed by supervisor
    // We just need to trigger the start via botMapper
    await botMapper.startBot(instanceId);
    
    return { success: true, instanceId };
  },

  /**
   * Stop a bot
   */
  async stopBot(instanceId) {
    if (!initialized) {
      throw new Error('Pool system not initialized');
    }
    
    await botMapper.stopBot(instanceId);
    return { success: true, instanceId };
  },

  /**
   * Delete a bot
   */
  async deleteBot(instanceId, userId) {
    if (!initialized) {
      throw new Error('Pool system not initialized');
    }
    
    console.log(`[PoolProvisioner] Deleting bot ${instanceId}`);
    
    // Remove from container
    await botMapper.removeBot(instanceId);
    
    // Remove instance directory (optional, keep for data retention)
    // const instanceDir = path.join(BOT_BASE_DIR, userId, instanceId);
    // await fs.remove(instanceDir);
    
    return { success: true, instanceId };
  },

  /**
   * Get connection info for API proxying
   */
  async getBotConnection(instanceId) {
    if (!initialized) {
      throw new Error('Pool system not initialized');
    }
    
    return botMapper.getBotConnection(instanceId);
  },

  /**
   * Get pool statistics
   */
  getPoolStats() {
    if (!initialized) {
      return { error: 'Pool system not initialized' };
    }
    
    return {
      poolMode: POOL_MODE_ENABLED,
      ...poolManager.getPoolStats(),
      health: healthMonitor.getHealthSummary()
    };
  },
  
  /**
   * Get pool statistics for a specific user
   * @param {string} userId - User ID
   */
  getUserPoolStats(userId) {
    if (!initialized) {
      return { error: 'Pool system not initialized' };
    }
    
    if (!userId) {
      throw new Error('userId is required');
    }
    
    return poolManager.getUserPoolStats(userId);
  },

  /**
   * Force a health check
   */
  async runHealthCheck() {
    if (!healthMonitor) {
      throw new Error('Pool system not initialized');
    }
    
    return healthMonitor.runHealthCheck();
  },

  /**
   * Clean up empty pool containers
   */
  async cleanupEmptyPools() {
    if (!poolManager) {
      throw new Error('Pool system not initialized');
    }

    return poolManager.cleanupEmptyPools();
  },

  /**
   * Sync pool state with actual running bots
   * Fixes discrepancies between pool state file and reality
   */
  async syncPoolState() {
    if (!poolManager) {
      throw new Error('Pool system not initialized');
    }

    return poolManager.syncPoolState();
  }
};

/**
 * Pool-aware API proxy helper
 * Replaces getBotUrlByInstanceId in legacy code
 */
async function getPoolAwareBotUrl(instanceId) {
  if (!initialized) {
    throw new Error('Pool system not initialized');
  }
  
  const connection = await botMapper.getBotConnection(instanceId);
  
  return {
    url: connection.url,
    host: connection.host,
    port: connection.port,
    isPooled: connection.isPooled,
    username: connection.username,
    password: connection.password
  };
}

/**
 * Check if an instance is in pool mode
 */
function isInstancePooled(instanceId) {
  if (!poolManager) return false;
  return poolManager.isBotInPool(instanceId);
}

/**
 * Get the global instances
 */
function getPoolComponents() {
  return {
    poolManager,
    botMapper,
    healthMonitor,
    initialized
  };
}

module.exports = {
  initPoolSystem,
  shutdownPoolSystem,
  poolProvisioner,
  getPoolAwareBotUrl,
  isInstancePooled,
  getPoolComponents,
  POOL_MODE_ENABLED
};
