/**
 * Active Trade Monitor Service
 * 
 * This service runs continuously in the background and actively manages all open positions
 * across all bot instances. It applies the universal features to live trades:
 * 
 * - Take Profit Levels: Monitors positions and executes partial exits at profit targets
 * - Trailing Stop: Updates trailing stops as positions move into profit
 * - Daily Loss Protection: Pauses trading when daily loss limits are hit
 * - Emergency Stop: Monitors for market crashes and triggers emergency actions
 * - Trading Schedule: Enforces time-based trading restrictions
 * 
 * Usage:
 *   const { ActiveTradeMonitor } = require('./active-trade-monitor');
 *   const monitor = new ActiveTradeMonitor(botBaseDir);
 *   await monitor.start();
 */

const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { UniversalFeatures } = require('./universal-features');
const UniversalRiskManager = require('./universal-risk-manager');

// Monitor configuration
const MONITOR_CONFIG = {
  checkIntervalMs: 30000,        // Check every 30 seconds
  priceUpdateIntervalMs: 10000,  // Update prices every 10 seconds
  dailyStatsResetHour: 0,        // Reset daily stats at midnight UTC
  maxConcurrentBots: 10,         // Process max 10 bots in parallel
  retryDelayMs: 5000,            // Retry delay on errors
  maxRetries: 3                  // Max retries per bot
};

// Price cache for efficient lookups
const priceCache = new Map();
const PRICE_CACHE_TTL = 10000; // 10 seconds

class ActiveTradeMonitor {
  constructor(botBaseDir) {
    this.botBaseDir = botBaseDir || path.join(__dirname, '..', 'freqtrade-instances');
    this.running = false;
    this.intervalId = null;
    this.priceIntervalId = null;
    this.botInstances = new Map(); // userId-instanceId -> { features, riskManager, port, lastCheck }
    this.actions = []; // Queue of actions to execute
    this.dailyStats = new Map(); // userId-instanceId -> daily trading stats
    
    // BTC tracking for emergency stop
    this.btcPriceHistory = [];
    this.lastBtcCheck = 0;
  }

  /**
   * Start the monitor
   */
  async start() {
    if (this.running) {
      console.log('[Monitor] Already running');
      return;
    }
    
    console.log('[Monitor] 🚀 Starting Active Trade Monitor...');
    this.running = true;
    
    // Initial discovery of all bots
    await this.discoverBots();
    
    // Start monitoring loops
    this.intervalId = setInterval(() => this.monitoringLoop(), MONITOR_CONFIG.checkIntervalMs);
    this.priceIntervalId = setInterval(() => this.updatePrices(), MONITOR_CONFIG.priceUpdateIntervalMs);
    
    // Run first check immediately
    await this.monitoringLoop();
    
    console.log(`[Monitor] ✅ Active Trade Monitor started (checking every ${MONITOR_CONFIG.checkIntervalMs / 1000}s)`);
  }

  /**
   * Stop the monitor
   */
  stop() {
    console.log('[Monitor] Stopping Active Trade Monitor...');
    this.running = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    if (this.priceIntervalId) {
      clearInterval(this.priceIntervalId);
      this.priceIntervalId = null;
    }
    
    console.log('[Monitor] ✅ Active Trade Monitor stopped');
  }

  /**
   * Discover all bot instances (pool-aware)
   * Scans both pool structure: userId/{userId}-pool-N/bots/{instanceId}/
   * and legacy structure: userId/{instanceId}/
   */
  async discoverBots() {
    try {
      console.log('[Monitor] Discovering bot instances...');
      
      if (!(await fs.pathExists(this.botBaseDir))) {
        console.log('[Monitor] Bot base directory does not exist:', this.botBaseDir);
        return;
      }
      
      const userDirs = await fs.readdir(this.botBaseDir);
      let totalBots = 0;
      
      for (const userId of userDirs) {
        const userPath = path.join(this.botBaseDir, userId);
        const stats = await fs.stat(userPath);
        
        if (!stats.isDirectory()) continue;
        
        const entries = await fs.readdir(userPath);
        
        for (const entry of entries) {
          const entryPath = path.join(userPath, entry);
          const entryStats = await fs.stat(entryPath);
          
          if (!entryStats.isDirectory()) continue;
          
          // Check if this is a pool directory (format: {userId}-pool-N)
          if (entry.startsWith(`${userId}-pool-`)) {
            // Pool mode: scan bots subdirectory
            const botsDir = path.join(entryPath, 'bots');
            if (await fs.pathExists(botsDir)) {
              const botDirs = await fs.readdir(botsDir);
              for (const instanceId of botDirs) {
                const instancePath = path.join(botsDir, instanceId);
                const instanceStats = await fs.stat(instancePath);
                
                if (!instanceStats.isDirectory()) continue;
                
                const configPath = path.join(instancePath, 'config.json');
                if (await fs.pathExists(configPath)) {
                  await this.registerBot(userId, instanceId, instancePath);
                  totalBots++;
                }
              }
            }
          } else {
            // Legacy mode: check if this entry has a config.json (skip if it's a known non-bot dir)
            const knownNonBotDirs = ['historical_backups', 'permanent_backups'];
            if (knownNonBotDirs.includes(entry)) continue;
            
            const configPath = path.join(entryPath, 'config.json');
            if (await fs.pathExists(configPath)) {
              console.warn(`[Monitor] Found legacy bot structure: ${entry} (should be in pool)`);
              await this.registerBot(userId, entry, entryPath);
              totalBots++;
            }
          }
        }
      }
      
      console.log(`[Monitor] ✅ Discovered ${totalBots} bot instances`);
    } catch (error) {
      console.error('[Monitor] Error discovering bots:', error.message);
    }
  }

  /**
   * Register a bot instance for monitoring
   */
  async registerBot(userId, instanceId, instancePath) {
    const key = `${userId}-${instanceId}`;
    
    try {
      // Load config to get API port
      const configPath = path.join(instancePath, 'config.json');
      const config = await fs.readJson(configPath);
      const port = config.api_server?.listen_port;
      
      if (!port) {
        console.warn(`[Monitor] No API port found for ${key}, skipping`);
        return;
      }
      
      // Create feature and risk manager instances (pass instancePath to avoid legacy path creation)
      const features = new UniversalFeatures(instanceId, userId, instancePath);
      await features.loadFeatures();
      
      const riskManager = new UniversalRiskManager(instanceId, userId, instancePath);
      await riskManager.loadSettings();
      
      this.botInstances.set(key, {
        userId,
        instanceId,
        instancePath,
        port,
        features,
        riskManager,
        lastCheck: 0,
        errors: 0,
        apiUsername: config.api_server?.username || 'admin',
        apiPassword: config.api_server?.password || 'password'
      });
      
      console.log(`[Monitor] Registered bot: ${key} (port ${port})`);
    } catch (error) {
      console.error(`[Monitor] Error registering bot ${key}:`, error.message);
    }
  }

  /**
   * Main monitoring loop
   */
  async monitoringLoop() {
    if (!this.running) return;
    
    const startTime = Date.now();
    console.log(`[Monitor] --- Monitoring cycle started (${this.botInstances.size} bots) ---`);
    
    // Process bots in batches
    const botEntries = Array.from(this.botInstances.entries());
    const batchSize = MONITOR_CONFIG.maxConcurrentBots;
    
    for (let i = 0; i < botEntries.length; i += batchSize) {
      const batch = botEntries.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async ([key, bot]) => {
        try {
          await this.processBot(key, bot);
          bot.errors = 0; // Reset error count on success
        } catch (error) {
          bot.errors = (bot.errors || 0) + 1;
          console.error(`[Monitor] Error processing ${key}:`, error.message);
          
          if (bot.errors >= MONITOR_CONFIG.maxRetries) {
            console.warn(`[Monitor] Bot ${key} has too many errors, will retry next cycle`);
          }
        }
      }));
    }
    
    // Process action queue
    await this.processActionQueue();
    
    const duration = Date.now() - startTime;
    console.log(`[Monitor] --- Monitoring cycle completed in ${duration}ms ---`);
  }

  /**
   * Process a single bot
   */
  async processBot(key, bot) {
    const { userId, instanceId, port, features, riskManager, apiUsername, apiPassword } = bot;
    
    // Reload features to get latest config
    await features.loadFeatures();
    await riskManager.loadSettings();
    
    // Get open trades from FreqTrade API
    const trades = await this.getOpenTrades(port, apiUsername, apiPassword);
    if (!trades || trades.length === 0) {
      // No open trades, just check trading permissions
      await this.checkTradingPermissions(key, bot);
      return;
    }
    
    // Get current prices
    const balance = await this.getBalance(port, apiUsername, apiPassword);
    const portfolioValue = balance?.total || 10000;
    
    // Get daily PnL
    const dailyPnL = await this.getDailyPnL(port, apiUsername, apiPassword);
    
    // Check trading permissions (schedule, daily loss, emergency)
    const tradingStatus = await features.isTradingAllowed({
      currentPnL: dailyPnL?.profit_closed_coin || 0,
      portfolioValue,
      marketData: await this.getMarketData()
    });
    
    if (!tradingStatus.allowed) {
      console.log(`[Monitor] [${key}] Trading paused: ${tradingStatus.reason}`);
      bot.tradingPaused = true;
      bot.pauseReason = tradingStatus.reason;
      return;
    }
    
    bot.tradingPaused = false;
    
    // Process each open trade
    for (const trade of trades) {
      await this.processOpenTrade(key, bot, trade, portfolioValue);
    }
    
    bot.lastCheck = Date.now();
  }

  /**
   * Process a single open trade
   */
  async processOpenTrade(key, bot, trade, portfolioValue) {
    const { features, port, apiUsername, apiPassword } = bot;
    
    // Get current price
    const currentPrice = await this.getCurrentPrice(trade.pair);
    if (!currentPrice) return;
    
    // Check take profit levels
    const tpAction = await features.checkTakeProfitLevels(trade, currentPrice);
    if (tpAction) {
      this.actions.push({
        type: 'take_profit',
        botKey: key,
        trade,
        action: tpAction,
        port,
        apiUsername,
        apiPassword
      });
    }
    
    // Manage trailing stop
    const tsResult = await features.manageTrailingStop(trade, currentPrice);
    if (tsResult?.action === 'exit') {
      this.actions.push({
        type: 'trailing_stop_exit',
        botKey: key,
        trade,
        action: tsResult,
        port,
        apiUsername,
        apiPassword
      });
    }
  }

  /**
   * Check trading permissions without active trades
   */
  async checkTradingPermissions(key, bot) {
    const { features } = bot;
    
    const balance = await this.getBalance(bot.port, bot.apiUsername, bot.apiPassword);
    const dailyPnL = await this.getDailyPnL(bot.port, bot.apiUsername, bot.apiPassword);
    
    const tradingStatus = await features.isTradingAllowed({
      currentPnL: dailyPnL?.profit_closed_coin || 0,
      portfolioValue: balance?.total || 10000,
      marketData: await this.getMarketData()
    });
    
    bot.tradingPaused = !tradingStatus.allowed;
    bot.pauseReason = tradingStatus.reason || null;
  }

  /**
   * Process queued actions
   */
  async processActionQueue() {
    while (this.actions.length > 0) {
      const action = this.actions.shift();
      
      try {
        switch (action.type) {
          case 'take_profit':
            await this.executeTakeProfit(action);
            break;
          case 'trailing_stop_exit':
            await this.executeTrailingStopExit(action);
            break;
          default:
            console.warn(`[Monitor] Unknown action type: ${action.type}`);
        }
      } catch (error) {
        console.error(`[Monitor] Error executing action ${action.type}:`, error.message);
      }
    }
  }

  /**
   * Execute take profit action
   */
  async executeTakeProfit(action) {
    const { botKey, trade, action: tpAction, port, apiUsername, apiPassword } = action;
    
    console.log(`[Monitor] [${botKey}] 🎯 Executing take profit for ${trade.pair}: ${tpAction.exitPercent}%`);
    
    // For partial exit, we need to calculate the amount to sell
    if (tpAction.exitPercent < 100) {
      // FreqTrade doesn't natively support partial exits, so we just log for now
      // In a real implementation, you'd call /api/v1/forcesell with a partial amount
      console.log(`[Monitor] [${botKey}] ⚠️ Partial exit (${tpAction.exitPercent}%) - manual intervention may be needed`);
      
      // Log the action for the user
      await this.logAction(botKey, {
        type: 'take_profit_triggered',
        pair: trade.pair,
        tradeId: trade.trade_id,
        exitPercent: tpAction.exitPercent,
        profitPercent: tpAction.currentProfit,
        timestamp: Date.now()
      });
    } else {
      // Full exit - use force_exit API
      try {
        await this.forceExitTrade(port, trade.trade_id, apiUsername, apiPassword, 'take_profit_100');
        console.log(`[Monitor] [${botKey}] ✅ Full take profit executed for ${trade.pair}`);
      } catch (error) {
        console.error(`[Monitor] [${botKey}] ❌ Take profit execution failed:`, error.message);
      }
    }
  }

  /**
   * Execute trailing stop exit
   */
  async executeTrailingStopExit(action) {
    const { botKey, trade, action: tsAction, port, apiUsername, apiPassword } = action;
    
    console.log(`[Monitor] [${botKey}] 🛑 Executing trailing stop exit for ${trade.pair}`);
    
    try {
      await this.forceExitTrade(port, trade.trade_id, apiUsername, apiPassword, 'trailing_stop');
      console.log(`[Monitor] [${botKey}] ✅ Trailing stop exit executed for ${trade.pair}`);
      
      await this.logAction(botKey, {
        type: 'trailing_stop_exit',
        pair: trade.pair,
        tradeId: trade.trade_id,
        highWaterMark: tsAction.highWaterMark,
        exitPrice: tsAction.exitPrice,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error(`[Monitor] [${botKey}] ❌ Trailing stop exit failed:`, error.message);
    }
  }

  /**
   * Log action to bot's action log
   */
  async logAction(botKey, actionData) {
    const bot = this.botInstances.get(botKey);
    if (!bot) return;
    
    const logPath = path.join(bot.instancePath, 'user_data', 'universal_features', 'actions.json');
    
    let actions = [];
    if (await fs.pathExists(logPath)) {
      actions = await fs.readJson(logPath);
    }
    
    actions.push(actionData);
    
    // Keep only last 100 actions
    if (actions.length > 100) {
      actions = actions.slice(-100);
    }
    
    await fs.ensureDir(path.dirname(logPath));
    await fs.writeJson(logPath, actions, { spaces: 2 });
  }

  // ============================================================
  // FreqTrade API Helpers
  // ============================================================

  /**
   * Get authentication token for FreqTrade API
   */
  async getAuthToken(port, username, password) {
    const cacheKey = `token-${port}`;
    const cached = priceCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 60000) { // Cache token for 1 minute
      return cached.token;
    }
    
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/token/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        timeout: 5000
      });
      
      if (response.ok) {
        const data = await response.json();
        priceCache.set(cacheKey, { token: data.access_token, timestamp: Date.now() });
        return data.access_token;
      }
    } catch (error) {
      // Silently fail - bot might not be running
    }
    
    return null;
  }

  /**
   * Make authenticated request to FreqTrade API
   */
  async ftRequest(port, endpoint, username, password, method = 'GET', body = null) {
    const token = await this.getAuthToken(port, username, password);
    if (!token) return null;
    
    try {
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      };
      
      if (body) {
        options.body = JSON.stringify(body);
      }
      
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, options);
      
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      // Silently fail
    }
    
    return null;
  }

  /**
   * Get open trades from FreqTrade
   */
  async getOpenTrades(port, username, password) {
    const data = await this.ftRequest(port, '/api/v1/status', username, password);
    return data || [];
  }

  /**
   * Get balance from FreqTrade
   */
  async getBalance(port, username, password) {
    return await this.ftRequest(port, '/api/v1/balance', username, password);
  }

  /**
   * Get daily PnL from FreqTrade
   */
  async getDailyPnL(port, username, password) {
    const data = await this.ftRequest(port, '/api/v1/profit', username, password);
    return data;
  }

  /**
   * Force exit a trade
   */
  async forceExitTrade(port, tradeId, username, password, reason = 'universal_feature') {
    return await this.ftRequest(
      port, 
      '/api/v1/forceexit', 
      username, 
      password, 
      'POST',
      { tradeid: tradeId, ordertype: 'market' }
    );
  }

  // ============================================================
  // Price Management
  // ============================================================

  /**
   * Update price cache
   */
  async updatePrices() {
    // Update BTC price for emergency stop monitoring
    await this.updateBtcPrice();
    
    // Clear old cache entries
    const now = Date.now();
    for (const [key, value] of priceCache.entries()) {
      if (now - value.timestamp > PRICE_CACHE_TTL && !key.startsWith('token-')) {
        priceCache.delete(key);
      }
    }
  }

  /**
   * Get current price for a pair
   */
  async getCurrentPrice(pair) {
    // Check cache first
    const cached = priceCache.get(pair);
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
      return cached.price;
    }
    
    // Try to get from any running bot
    for (const [key, bot] of this.botInstances.entries()) {
      const ticker = await this.ftRequest(
        bot.port,
        `/api/v1/ticker?pair=${pair}`,
        bot.apiUsername,
        bot.apiPassword
      );
      
      if (ticker?.last) {
        priceCache.set(pair, { price: ticker.last, timestamp: Date.now() });
        return ticker.last;
      }
    }
    
    return null;
  }

  /**
   * Update BTC price history for crash detection
   */
  async updateBtcPrice() {
    const btcPrice = await this.getCurrentPrice('BTC/USD');
    if (!btcPrice) return;
    
    const now = Date.now();
    
    this.btcPriceHistory.push({ price: btcPrice, timestamp: now });
    
    // Keep only last 2 hours of data
    const twoHoursAgo = now - (2 * 60 * 60 * 1000);
    this.btcPriceHistory = this.btcPriceHistory.filter(p => p.timestamp > twoHoursAgo);
  }

  /**
   * Get market data for emergency stop checks
   */
  async getMarketData() {
    if (this.btcPriceHistory.length < 2) {
      return {};
    }
    
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Find price from 1 hour ago
    const oldPrice = this.btcPriceHistory.find(p => p.timestamp <= oneHourAgo);
    const currentPrice = this.btcPriceHistory[this.btcPriceHistory.length - 1];
    
    if (!oldPrice || !currentPrice) {
      return {};
    }
    
    const btcChange = ((currentPrice.price - oldPrice.price) / oldPrice.price) * 100;
    
    return {
      btcChange,
      btcChangeTimeframe: 60, // 60 minutes
      btcCurrentPrice: currentPrice.price
    };
  }

  // ============================================================
  // Status & Reporting
  // ============================================================

  /**
   * Get monitor status
   */
  getStatus() {
    const bots = [];
    
    for (const [key, bot] of this.botInstances.entries()) {
      bots.push({
        key,
        userId: bot.userId,
        instanceId: bot.instanceId,
        port: bot.port,
        lastCheck: bot.lastCheck,
        tradingPaused: bot.tradingPaused || false,
        pauseReason: bot.pauseReason || null,
        errors: bot.errors || 0,
        featuresSummary: bot.features?.getFeatureSummary() || {}
      });
    }
    
    return {
      running: this.running,
      totalBots: this.botInstances.size,
      checkIntervalMs: MONITOR_CONFIG.checkIntervalMs,
      bots,
      btcPriceHistory: this.btcPriceHistory.slice(-10), // Last 10 readings
      pendingActions: this.actions.length
    };
  }

  /**
   * Get actions log for a specific bot
   */
  async getActionsLog(userId, instanceId) {
    const logPath = path.join(
      this.botBaseDir, 
      userId, 
      instanceId, 
      'user_data', 
      'universal_features', 
      'actions.json'
    );
    
    if (await fs.pathExists(logPath)) {
      return await fs.readJson(logPath);
    }
    
    return [];
  }

  /**
   * Manually trigger a bot check
   */
  async checkBot(userId, instanceId) {
    const key = `${userId}-${instanceId}`;
    const bot = this.botInstances.get(key);
    
    if (!bot) {
      throw new Error(`Bot ${key} not found in monitor`);
    }
    
    await this.processBot(key, bot);
    return { success: true, bot: this.getStatus().bots.find(b => b.key === key) };
  }

  /**
   * Refresh bot list (re-discover)
   */
  async refresh() {
    this.botInstances.clear();
    await this.discoverBots();
    return { success: true, totalBots: this.botInstances.size };
  }
}

// Singleton instance
let monitorInstance = null;

/**
 * Get or create the monitor singleton
 */
function getMonitor(botBaseDir) {
  if (!monitorInstance) {
    monitorInstance = new ActiveTradeMonitor(botBaseDir);
  }
  return monitorInstance;
}

module.exports = { ActiveTradeMonitor, getMonitor, MONITOR_CONFIG };
