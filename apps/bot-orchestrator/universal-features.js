/**
 * Universal Features - Enhanced Bot Trading Features
 * 
 * This module provides advanced trading features that work with ANY FreqTrade strategy:
 * - Multiple Take Profit Levels (ladder exits)
 * - Advanced Trailing Stop Loss
 * - Max Daily Loss Circuit Breaker
 * - Trading Schedule (time-based trading)
 * - Position Limits Per Asset
 * - Volatility-Based Position Sizing
 * - Emergency Stop (market crash detection)
 * - Smart Order Execution
 * - Profit Compounding
 * 
 * All features are stored in the bot's config.json under "universalFeatures" key
 */

const fs = require('fs-extra');
const path = require('path');

// Default feature configurations
const DEFAULT_FEATURES = {
  // Take Profit Levels - Scale out of winners
  takeProfitLevels: {
    enabled: true,
    mode: 'ladder', // 'ladder' = multiple exits, 'single' = one exit
    levels: [
      { percentage: 2, exitPercent: 25 },   // Take 25% at +2%
      { percentage: 5, exitPercent: 50 },   // Take 50% at +5%
      { percentage: 10, exitPercent: 100 }  // Full exit at +10%
    ]
  },

  // Advanced Trailing Stop
  trailingStop: {
    enabled: true,
    activationPercent: 3,      // Start trailing after +3% profit
    callbackRate: 1.5,         // Trail by 1.5%
    stepSize: 0.5,             // Move stop every 0.5% gain
    lockInProfit: true         // Never let profit turn to loss after activation
  },

  // Max Daily Loss Circuit Breaker
  dailyLossProtection: {
    enabled: true,
    maxDailyLossPercent: 5,    // Stop trading if -5% in 24h
    pauseUntil: 'nextDay',     // 'nextDay' | 'manual' | number (hours)
    closePositions: false,     // Keep positions but stop new entries
    notifyUser: true           // Send notification
  },

  // Trading Schedule
  tradingSchedule: {
    enabled: false,            // Disabled by default
    timezone: 'UTC',
    activeHours: {
      start: '00:00',          // 24h format
      end: '23:59'
    },
    activeDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    holidayMode: false         // Pause all trading
  },

  // Position Limits
  positionLimits: {
    enabled: true,
    maxPercentPerAsset: 30,        // No more than 30% in one asset
    maxPositionsPerAsset: 3,       // Max 3 positions in same asset
    minTimeBetweenSameAsset: 3600, // 1 hour cooldown (seconds)
    maxCorrelatedPositions: 2      // Max 2 highly correlated assets
  },

  // Volatility-Based Position Sizing
  volatilityAdjustment: {
    enabled: true,
    method: 'ATR',                 // 'ATR' | 'stdDev' | 'bollingerWidth'
    lookbackPeriod: 14,            // Periods for calculation
    scaleFactor: 1.0,              // Multiplier for adjustment
    minSizeMultiplier: 0.5,        // Minimum 50% of base size
    maxSizeMultiplier: 1.5         // Maximum 150% of base size
  },

  // Emergency Stop (Market Crash Detection)
  emergencyStop: {
    enabled: true,
    triggers: {
      btcDropPercent: 15,          // If BTC drops 15% in 1hr
      btcDropTimeframe: 60,        // Minutes to check
      portfolioDropPercent: 20     // If portfolio drops 20% in 24h
    },
    actions: {
      closeAllPositions: false,    // Just pause, don't close
      pauseDurationHours: 4,       // Resume after 4 hours
      notifyUser: true
    }
  },

  // Smart Order Execution
  orderExecution: {
    enabled: true,
    useLimit: true,                // Prefer limit orders vs market
    limitOffsetPercent: 0.1,       // Place limit 0.1% better than market
    postOnly: true,                // Maker orders only (lower fees)
    timeInForce: 'GTC',            // Good til canceled
    icebergOrders: {
      enabled: false,
      visiblePercent: 20           // Show only 20% of order
    }
  },

  // Profit Compounding
  compounding: {
    enabled: false,
    reinvestPercent: 80,           // Reinvest 80% of profits
    withdrawalThreshold: 1000,     // Withdraw when >$1000 profit accumulated
    compoundFrequency: 'daily'     // 'trade' | 'daily' | 'weekly'
  },

  // Feature metadata
  _meta: {
    version: '2.0.0',
    createdAt: null,
    updatedAt: null
  }
};

// Correlation groups for position limit checks
const CORRELATION_GROUPS = {
  'layer1': ['BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'AVAX'],
  'defi': ['AAVE', 'UNI', 'SUSHI', 'COMP', 'MKR'],
  'memes': ['DOGE', 'SHIB', 'PEPE', 'FLOKI'],
  'stables': ['USDT', 'USDC', 'DAI', 'BUSD']
};

class UniversalFeatures {
  constructor(instanceId, userId) {
    this.instanceId = instanceId;
    this.userId = userId;
    
    // Bot instance paths
    this.instanceDir = path.join(__dirname, '..', 'freqtrade-instances', this.userId, instanceId);
    this.configPath = path.join(this.instanceDir, 'config.json');
    
    // Runtime data paths
    const userDataDir = path.join(this.instanceDir, 'user_data');
    this.runtimeDataDir = path.join(userDataDir, 'universal_features');
    this.dailyStatsPath = path.join(this.runtimeDataDir, 'daily-stats.json');
    this.takeProfitLogPath = path.join(this.runtimeDataDir, 'take-profit-log.json');
    this.trailingStopDataPath = path.join(this.runtimeDataDir, 'trailing-stop-data.json');
    this.tradingPausePath = path.join(this.runtimeDataDir, 'trading-pause.json');
    this.emergencyLogPath = path.join(this.runtimeDataDir, 'emergency-log.json');
    
    this.features = null;
    this.botConfig = null;
  }

  /**
   * Load features from bot's config.json
   */
  async loadFeatures() {
    try {
      await fs.ensureDir(this.runtimeDataDir);
      
      if (await fs.pathExists(this.configPath)) {
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.botConfig = JSON.parse(configData);
        
        if (this.botConfig.universalFeatures) {
          // Deep merge with defaults to ensure all fields exist
          this.features = this.deepMerge(DEFAULT_FEATURES, this.botConfig.universalFeatures);
        } else {
          // Initialize with defaults
          this.features = JSON.parse(JSON.stringify(DEFAULT_FEATURES));
          this.features._meta.createdAt = new Date().toISOString();
          this.features._meta.updatedAt = new Date().toISOString();
        }
      } else {
        this.features = JSON.parse(JSON.stringify(DEFAULT_FEATURES));
        this.features._meta.createdAt = new Date().toISOString();
        this.botConfig = {};
      }
    } catch (error) {
      console.warn(`[${this.instanceId}] Failed to load universal features, using defaults:`, error.message);
      this.features = JSON.parse(JSON.stringify(DEFAULT_FEATURES));
      this.botConfig = {};
    }
  }

  /**
   * Save features to bot's config.json
   */
  async saveFeatures() {
    try {
      // Reload config to avoid overwriting other changes
      if (await fs.pathExists(this.configPath)) {
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.botConfig = JSON.parse(configData);
      }
      
      this.features._meta.updatedAt = new Date().toISOString();
      this.botConfig.universalFeatures = this.features;
      
      await fs.writeFile(this.configPath, JSON.stringify(this.botConfig, null, 2), 'utf8');
      console.log(`[${this.instanceId}] ✓ Universal features saved to config.json`);
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to save universal features:`, error.message);
      throw error;
    }
  }

  /**
   * Update specific features
   */
  async updateFeatures(newFeatures) {
    await this.loadFeatures();
    this.features = this.deepMerge(this.features, newFeatures);
    await this.saveFeatures();
    return this.features;
  }

  /**
   * Get all features
   */
  getFeatures() {
    return this.features;
  }

  // ============================================================
  // TAKE PROFIT LEVELS
  // ============================================================

  /**
   * Check if any take profit level is triggered for a position
   * @param {Object} position - Current position data
   * @param {number} currentPrice - Current market price
   * @returns {Object|null} - Take profit action to execute, or null
   */
  async checkTakeProfitLevels(position, currentPrice) {
    if (!this.features?.takeProfitLevels?.enabled) return null;
    
    const config = this.features.takeProfitLevels;
    const entryPrice = position.open_rate || position.entryPrice;
    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Load take profit log to track what's already been taken
    let tpLog = {};
    if (await fs.pathExists(this.takeProfitLogPath)) {
      tpLog = await fs.readJson(this.takeProfitLogPath);
    }
    
    const positionKey = `${position.pair}_${position.trade_id || position.id}`;
    const positionTpLog = tpLog[positionKey] || { takenLevels: [] };
    
    // Check each level
    for (const level of config.levels) {
      if (profitPercent >= level.percentage && !positionTpLog.takenLevels.includes(level.percentage)) {
        // Calculate exit amount
        const remainingPercent = 100 - positionTpLog.takenLevels.reduce((sum, l) => {
          const levelConfig = config.levels.find(lv => lv.percentage === l);
          return sum + (levelConfig?.exitPercent || 0);
        }, 0);
        
        const actualExitPercent = Math.min(level.exitPercent, remainingPercent);
        
        if (actualExitPercent > 0) {
          // Record this take profit
          positionTpLog.takenLevels.push(level.percentage);
          tpLog[positionKey] = positionTpLog;
          await fs.writeJson(this.takeProfitLogPath, tpLog, { spaces: 2 });
          
          console.log(`[${this.instanceId}] 🎯 Take Profit triggered: ${position.pair} at +${profitPercent.toFixed(2)}%, exiting ${actualExitPercent}%`);
          
          return {
            action: 'partial_exit',
            pair: position.pair,
            tradeId: position.trade_id || position.id,
            exitPercent: actualExitPercent,
            triggerLevel: level.percentage,
            currentProfit: profitPercent,
            timestamp: Date.now()
          };
        }
      }
    }
    
    return null;
  }

  // ============================================================
  // TRAILING STOP LOSS
  // ============================================================

  /**
   * Manage trailing stop for a position
   * @param {Object} position - Current position data
   * @param {number} currentPrice - Current market price
   * @returns {Object|null} - Stop loss action if triggered, or updated stop data
   */
  async manageTrailingStop(position, currentPrice) {
    if (!this.features?.trailingStop?.enabled) return null;
    
    const config = this.features.trailingStop;
    const entryPrice = position.open_rate || position.entryPrice;
    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Load trailing stop data
    let tsData = {};
    if (await fs.pathExists(this.trailingStopDataPath)) {
      tsData = await fs.readJson(this.trailingStopDataPath);
    }
    
    const positionKey = `${position.pair}_${position.trade_id || position.id}`;
    let positionTs = tsData[positionKey] || {
      activated: false,
      highWaterMark: entryPrice,
      currentStopPrice: null,
      activationPrice: null
    };
    
    // Check if trailing stop should be activated
    if (!positionTs.activated && profitPercent >= config.activationPercent) {
      positionTs.activated = true;
      positionTs.activationPrice = currentPrice;
      positionTs.highWaterMark = currentPrice;
      
      // Set initial stop price
      const stopPercent = config.lockInProfit ? 0.5 : -config.callbackRate;
      positionTs.currentStopPrice = entryPrice * (1 + stopPercent / 100);
      
      console.log(`[${this.instanceId}] 📈 Trailing stop activated for ${position.pair} at ${currentPrice}, stop: ${positionTs.currentStopPrice.toFixed(4)}`);
    }
    
    // If activated, update high water mark and stop price
    if (positionTs.activated) {
      if (currentPrice > positionTs.highWaterMark) {
        // New high - update stop price
        const priceIncrease = currentPrice - positionTs.highWaterMark;
        const stepThreshold = positionTs.highWaterMark * (config.stepSize / 100);
        
        if (priceIncrease >= stepThreshold) {
          positionTs.highWaterMark = currentPrice;
          positionTs.currentStopPrice = currentPrice * (1 - config.callbackRate / 100);
          
          // Ensure we never go below entry if lockInProfit is enabled
          if (config.lockInProfit) {
            positionTs.currentStopPrice = Math.max(positionTs.currentStopPrice, entryPrice * 1.005);
          }
          
          console.log(`[${this.instanceId}] 📊 Trailing stop updated for ${position.pair}: new high ${currentPrice}, stop: ${positionTs.currentStopPrice.toFixed(4)}`);
        }
      }
      
      // Check if stop is hit
      if (currentPrice <= positionTs.currentStopPrice) {
        console.log(`[${this.instanceId}] 🛑 Trailing stop HIT for ${position.pair} at ${currentPrice}`);
        
        // Clean up
        delete tsData[positionKey];
        await fs.writeJson(this.trailingStopDataPath, tsData, { spaces: 2 });
        
        return {
          action: 'exit',
          reason: 'trailing_stop',
          pair: position.pair,
          tradeId: position.trade_id || position.id,
          stopPrice: positionTs.currentStopPrice,
          exitPrice: currentPrice,
          highWaterMark: positionTs.highWaterMark,
          timestamp: Date.now()
        };
      }
    }
    
    // Save updated trailing stop data
    tsData[positionKey] = positionTs;
    await fs.writeJson(this.trailingStopDataPath, tsData, { spaces: 2 });
    
    return { action: 'hold', trailingStopData: positionTs };
  }

  // ============================================================
  // MAX DAILY LOSS PROTECTION
  // ============================================================

  /**
   * Check if daily loss limit has been reached
   * @param {number} currentPnL - Current day's profit/loss
   * @param {number} portfolioValue - Total portfolio value
   * @returns {Object} - Status and any required action
   */
  async checkDailyLossLimit(currentPnL, portfolioValue) {
    if (!this.features?.dailyLossProtection?.enabled) {
      return { tradingAllowed: true };
    }
    
    const config = this.features.dailyLossProtection;
    const lossPercent = (currentPnL / portfolioValue) * 100;
    
    // Check if already paused
    let pauseData = null;
    if (await fs.pathExists(this.tradingPausePath)) {
      pauseData = await fs.readJson(this.tradingPausePath);
      
      // Check if pause should be lifted
      if (pauseData.reason === 'daily_loss') {
        const now = Date.now();
        if (pauseData.resumeAt && now >= pauseData.resumeAt) {
          // Pause expired, resume trading
          await fs.remove(this.tradingPausePath);
          console.log(`[${this.instanceId}] ✅ Trading resumed after daily loss pause`);
          return { tradingAllowed: true, resumed: true };
        }
        
        return {
          tradingAllowed: false,
          reason: 'daily_loss_limit',
          lossPercent: pauseData.lossPercent,
          resumeAt: pauseData.resumeAt,
          resumeAtFormatted: new Date(pauseData.resumeAt).toISOString()
        };
      }
    }
    
    // Check if loss limit hit
    if (lossPercent <= -config.maxDailyLossPercent) {
      let resumeAt = null;
      
      if (config.pauseUntil === 'nextDay') {
        // Resume at midnight UTC
        const tomorrow = new Date();
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);
        resumeAt = tomorrow.getTime();
      } else if (typeof config.pauseUntil === 'number') {
        resumeAt = Date.now() + (config.pauseUntil * 60 * 60 * 1000);
      }
      // 'manual' = no resumeAt, requires manual intervention
      
      const pauseRecord = {
        reason: 'daily_loss',
        triggeredAt: Date.now(),
        lossPercent: lossPercent,
        resumeAt: resumeAt,
        closePositions: config.closePositions
      };
      
      await fs.writeJson(this.tradingPausePath, pauseRecord, { spaces: 2 });
      
      console.log(`[${this.instanceId}] 🛑 Daily loss limit hit! Loss: ${lossPercent.toFixed(2)}%, trading paused`);
      
      return {
        tradingAllowed: false,
        reason: 'daily_loss_limit',
        lossPercent: lossPercent,
        closePositions: config.closePositions,
        resumeAt: resumeAt,
        notify: config.notifyUser
      };
    }
    
    return { tradingAllowed: true, currentLossPercent: lossPercent };
  }

  /**
   * Update daily stats
   */
  async updateDailyStats(pnl, trades) {
    let stats = {};
    const today = new Date().toISOString().split('T')[0];
    
    if (await fs.pathExists(this.dailyStatsPath)) {
      stats = await fs.readJson(this.dailyStatsPath);
    }
    
    if (!stats[today]) {
      stats[today] = { pnl: 0, trades: 0, startBalance: null };
    }
    
    stats[today].pnl = pnl;
    stats[today].trades = trades;
    stats[today].lastUpdate = Date.now();
    
    // Keep only last 30 days
    const dates = Object.keys(stats).sort().slice(-30);
    const trimmedStats = {};
    dates.forEach(d => { trimmedStats[d] = stats[d]; });
    
    await fs.writeJson(this.dailyStatsPath, trimmedStats, { spaces: 2 });
    return stats[today];
  }

  // ============================================================
  // TRADING SCHEDULE
  // ============================================================

  /**
   * Check if trading is allowed based on schedule
   * @returns {Object} - Whether trading is allowed and reason
   */
  checkTradingSchedule() {
    if (!this.features?.tradingSchedule?.enabled) {
      return { allowed: true };
    }
    
    const config = this.features.tradingSchedule;
    
    // Holiday mode overrides everything
    if (config.holidayMode) {
      return { allowed: false, reason: 'holiday_mode' };
    }
    
    const now = new Date();
    
    // Check day of week
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const currentDay = days[now.getDay()];
    
    if (!config.activeDays.includes(currentDay)) {
      return { allowed: false, reason: 'inactive_day', currentDay };
    }
    
    // Check time of day (simple implementation, ignores timezone for now)
    const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"
    const { start, end } = config.activeHours;
    
    // Handle overnight schedules (e.g., 22:00 - 06:00)
    let inActiveHours;
    if (start <= end) {
      inActiveHours = currentTime >= start && currentTime <= end;
    } else {
      inActiveHours = currentTime >= start || currentTime <= end;
    }
    
    if (!inActiveHours) {
      return { allowed: false, reason: 'outside_hours', currentTime, activeHours: config.activeHours };
    }
    
    return { allowed: true };
  }

  // ============================================================
  // POSITION LIMITS
  // ============================================================

  /**
   * Check if a new position is allowed based on limits
   * @param {string} pair - Trading pair to check
   * @param {Array} currentPositions - Array of current open positions
   * @param {number} portfolioValue - Total portfolio value
   * @param {number} proposedSize - Size of proposed new position
   * @returns {Object} - Whether position is allowed
   */
  async checkPositionLimits(pair, currentPositions, portfolioValue, proposedSize) {
    if (!this.features?.positionLimits?.enabled) {
      return { allowed: true };
    }
    
    const config = this.features.positionLimits;
    const asset = pair.split('/')[0]; // Get base asset (e.g., "BTC" from "BTC/USD")
    
    // Check max percent per asset
    const currentAssetValue = currentPositions
      .filter(p => p.pair.startsWith(asset))
      .reduce((sum, p) => sum + (p.stake_amount || p.value || 0), 0);
    
    const newAssetPercent = ((currentAssetValue + proposedSize) / portfolioValue) * 100;
    
    if (newAssetPercent > config.maxPercentPerAsset) {
      return {
        allowed: false,
        reason: 'max_percent_per_asset',
        asset,
        currentPercent: (currentAssetValue / portfolioValue) * 100,
        proposedPercent: newAssetPercent,
        maxPercent: config.maxPercentPerAsset
      };
    }
    
    // Check max positions per asset
    const assetPositions = currentPositions.filter(p => p.pair.startsWith(asset));
    if (assetPositions.length >= config.maxPositionsPerAsset) {
      return {
        allowed: false,
        reason: 'max_positions_per_asset',
        asset,
        currentPositions: assetPositions.length,
        maxPositions: config.maxPositionsPerAsset
      };
    }
    
    // Check min time between same asset entries
    if (config.minTimeBetweenSameAsset > 0 && assetPositions.length > 0) {
      const lastEntry = Math.max(...assetPositions.map(p => p.open_date || p.openTime || 0));
      const timeSinceLastEntry = (Date.now() - lastEntry) / 1000;
      
      if (timeSinceLastEntry < config.minTimeBetweenSameAsset) {
        return {
          allowed: false,
          reason: 'min_time_between_entries',
          asset,
          timeSinceLastEntry,
          minTime: config.minTimeBetweenSameAsset,
          waitSeconds: config.minTimeBetweenSameAsset - timeSinceLastEntry
        };
      }
    }
    
    // Check correlation limits
    const assetGroup = this.getCorrelationGroup(asset);
    if (assetGroup && config.maxCorrelatedPositions > 0) {
      const correlatedPositions = currentPositions.filter(p => {
        const posAsset = p.pair.split('/')[0];
        return this.getCorrelationGroup(posAsset) === assetGroup;
      });
      
      if (correlatedPositions.length >= config.maxCorrelatedPositions) {
        return {
          allowed: false,
          reason: 'max_correlated_positions',
          correlationGroup: assetGroup,
          correlatedCount: correlatedPositions.length,
          maxCorrelated: config.maxCorrelatedPositions
        };
      }
    }
    
    return { allowed: true };
  }

  /**
   * Get correlation group for an asset
   */
  getCorrelationGroup(asset) {
    for (const [group, assets] of Object.entries(CORRELATION_GROUPS)) {
      if (assets.includes(asset)) return group;
    }
    return null;
  }

  // ============================================================
  // VOLATILITY-BASED POSITION SIZING
  // ============================================================

  /**
   * Calculate position size multiplier based on volatility
   * @param {number} volatility - Current volatility value (ATR, stdDev, etc.)
   * @param {number} avgVolatility - Average/baseline volatility
   * @returns {number} - Size multiplier (0.5 to 1.5 typically)
   */
  calculateVolatilityMultiplier(volatility, avgVolatility) {
    if (!this.features?.volatilityAdjustment?.enabled || !avgVolatility) {
      return 1.0;
    }
    
    const config = this.features.volatilityAdjustment;
    const ratio = avgVolatility / volatility; // Higher volatility = lower ratio = smaller size
    
    let multiplier = ratio * config.scaleFactor;
    
    // Clamp to min/max
    multiplier = Math.max(config.minSizeMultiplier, Math.min(config.maxSizeMultiplier, multiplier));
    
    return multiplier;
  }

  /**
   * Adjust stake amount based on volatility
   * @param {number} baseStake - Original stake amount
   * @param {string} pair - Trading pair
   * @param {number} currentVolatility - Current volatility
   * @param {number} avgVolatility - Average volatility
   * @returns {number} - Adjusted stake amount
   */
  adjustStakeForVolatility(baseStake, pair, currentVolatility, avgVolatility) {
    const multiplier = this.calculateVolatilityMultiplier(currentVolatility, avgVolatility);
    const adjustedStake = baseStake * multiplier;
    
    if (multiplier !== 1.0) {
      console.log(`[${this.instanceId}] 📊 Volatility adjustment for ${pair}: ${multiplier.toFixed(2)}x (${baseStake.toFixed(2)} -> ${adjustedStake.toFixed(2)})`);
    }
    
    return adjustedStake;
  }

  // ============================================================
  // EMERGENCY STOP
  // ============================================================

  /**
   * Check emergency stop conditions
   * @param {Object} marketData - Current market data including BTC price history
   * @param {number} portfolioChange24h - Portfolio change in last 24h (percent)
   * @returns {Object} - Emergency status and actions
   */
  async checkEmergencyStop(marketData, portfolioChange24h) {
    if (!this.features?.emergencyStop?.enabled) {
      return { triggered: false };
    }
    
    const config = this.features.emergencyStop;
    const triggers = config.triggers;
    
    // Check if already in emergency mode
    let emergencyData = null;
    if (await fs.pathExists(this.emergencyLogPath)) {
      emergencyData = await fs.readJson(this.emergencyLogPath);
      
      if (emergencyData.active) {
        // Check if emergency period should end
        const now = Date.now();
        if (emergencyData.resumeAt && now >= emergencyData.resumeAt) {
          emergencyData.active = false;
          emergencyData.resolvedAt = now;
          await fs.writeJson(this.emergencyLogPath, emergencyData, { spaces: 2 });
          console.log(`[${this.instanceId}] ✅ Emergency stop lifted`);
          return { triggered: false, resumed: true };
        }
        
        return {
          triggered: true,
          active: true,
          reason: emergencyData.reason,
          resumeAt: emergencyData.resumeAt
        };
      }
    }
    
    // Check BTC crash trigger
    if (marketData?.btcChange && marketData.btcChangeTimeframe) {
      const btcDrop = -marketData.btcChange; // Convert to positive for comparison
      if (btcDrop >= triggers.btcDropPercent && marketData.btcChangeTimeframe <= triggers.btcDropTimeframe) {
        return await this.triggerEmergencyStop('btc_crash', {
          btcDrop,
          timeframe: marketData.btcChangeTimeframe
        });
      }
    }
    
    // Check portfolio crash trigger
    if (portfolioChange24h <= -triggers.portfolioDropPercent) {
      return await this.triggerEmergencyStop('portfolio_crash', {
        portfolioDrop: -portfolioChange24h
      });
    }
    
    return { triggered: false };
  }

  /**
   * Trigger emergency stop
   */
  async triggerEmergencyStop(reason, details) {
    const config = this.features.emergencyStop;
    const resumeAt = Date.now() + (config.actions.pauseDurationHours * 60 * 60 * 1000);
    
    const emergencyRecord = {
      active: true,
      reason,
      details,
      triggeredAt: Date.now(),
      resumeAt,
      closePositions: config.actions.closeAllPositions
    };
    
    await fs.writeJson(this.emergencyLogPath, emergencyRecord, { spaces: 2 });
    
    console.log(`[${this.instanceId}] 🚨 EMERGENCY STOP TRIGGERED: ${reason}`, details);
    
    return {
      triggered: true,
      active: true,
      reason,
      details,
      closePositions: config.actions.closeAllPositions,
      resumeAt,
      notify: config.actions.notifyUser
    };
  }

  /**
   * Manually resume from emergency stop
   */
  async resumeFromEmergency() {
    if (await fs.pathExists(this.emergencyLogPath)) {
      const emergencyData = await fs.readJson(this.emergencyLogPath);
      emergencyData.active = false;
      emergencyData.manuallyResumed = true;
      emergencyData.resolvedAt = Date.now();
      await fs.writeJson(this.emergencyLogPath, emergencyData, { spaces: 2 });
    }
    
    if (await fs.pathExists(this.tradingPausePath)) {
      await fs.remove(this.tradingPausePath);
    }
    
    console.log(`[${this.instanceId}] ✅ Manually resumed from emergency stop`);
    return { success: true };
  }

  // ============================================================
  // SMART ORDER EXECUTION
  // ============================================================

  /**
   * Generate order parameters based on execution settings
   * @param {string} side - 'buy' or 'sell'
   * @param {number} marketPrice - Current market price
   * @param {number} amount - Order amount
   * @returns {Object} - Order parameters
   */
  generateOrderParams(side, marketPrice, amount) {
    if (!this.features?.orderExecution?.enabled) {
      return { type: 'market', price: null, amount };
    }
    
    const config = this.features.orderExecution;
    const params = {
      amount,
      timeInForce: config.timeInForce
    };
    
    if (config.useLimit) {
      params.type = 'limit';
      const offset = marketPrice * (config.limitOffsetPercent / 100);
      params.price = side === 'buy' 
        ? marketPrice - offset  // Buy slightly below market
        : marketPrice + offset; // Sell slightly above market
      
      if (config.postOnly) {
        params.postOnly = true;
      }
    } else {
      params.type = 'market';
      params.price = null;
    }
    
    if (config.icebergOrders?.enabled) {
      params.iceberg = true;
      params.visibleAmount = amount * (config.icebergOrders.visiblePercent / 100);
    }
    
    return params;
  }

  // ============================================================
  // PROFIT COMPOUNDING
  // ============================================================

  /**
   * Calculate compounding action based on profits
   * @param {number} totalProfit - Total accumulated profit
   * @param {number} currentBalance - Current portfolio balance
   * @returns {Object} - Compounding action
   */
  calculateCompoundingAction(totalProfit, currentBalance) {
    if (!this.features?.compounding?.enabled || totalProfit <= 0) {
      return { action: 'none' };
    }
    
    const config = this.features.compounding;
    
    // Check withdrawal threshold
    if (totalProfit >= config.withdrawalThreshold) {
      const withdrawAmount = totalProfit * ((100 - config.reinvestPercent) / 100);
      const reinvestAmount = totalProfit * (config.reinvestPercent / 100);
      
      return {
        action: 'compound',
        totalProfit,
        withdrawAmount,
        reinvestAmount,
        newStakeIncrease: reinvestAmount / currentBalance
      };
    }
    
    return { action: 'none', totalProfit };
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Deep merge two objects
   */
  deepMerge(target, source) {
    const result = { ...target };
    
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && key in target && target[key] instanceof Object) {
        result[key] = this.deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }

  /**
   * Check if trading is currently allowed (combines all checks)
   * @param {Object} context - Current trading context
   * @returns {Object} - Trading status
   */
  async isTradingAllowed(context = {}) {
    const { currentPnL = 0, portfolioValue = 10000, marketData = {} } = context;
    
    // Check schedule
    const scheduleCheck = this.checkTradingSchedule();
    if (!scheduleCheck.allowed) {
      return { allowed: false, reason: scheduleCheck.reason, details: scheduleCheck };
    }
    
    // Check daily loss
    const dailyLossCheck = await this.checkDailyLossLimit(currentPnL, portfolioValue);
    if (!dailyLossCheck.tradingAllowed) {
      return { allowed: false, reason: 'daily_loss_limit', details: dailyLossCheck };
    }
    
    // Check emergency stop
    const emergencyCheck = await this.checkEmergencyStop(marketData, (currentPnL / portfolioValue) * 100);
    if (emergencyCheck.triggered && emergencyCheck.active) {
      return { allowed: false, reason: 'emergency_stop', details: emergencyCheck };
    }
    
    return { allowed: true };
  }

  /**
   * Get feature summary for API response
   */
  getFeatureSummary() {
    return {
      takeProfitLevels: {
        enabled: this.features?.takeProfitLevels?.enabled || false,
        levels: this.features?.takeProfitLevels?.levels?.length || 0
      },
      trailingStop: {
        enabled: this.features?.trailingStop?.enabled || false,
        activationPercent: this.features?.trailingStop?.activationPercent || 0
      },
      dailyLossProtection: {
        enabled: this.features?.dailyLossProtection?.enabled || false,
        maxLossPercent: this.features?.dailyLossProtection?.maxDailyLossPercent || 0
      },
      tradingSchedule: {
        enabled: this.features?.tradingSchedule?.enabled || false,
        holidayMode: this.features?.tradingSchedule?.holidayMode || false
      },
      positionLimits: {
        enabled: this.features?.positionLimits?.enabled || false,
        maxPercentPerAsset: this.features?.positionLimits?.maxPercentPerAsset || 0
      },
      volatilityAdjustment: {
        enabled: this.features?.volatilityAdjustment?.enabled || false,
        method: this.features?.volatilityAdjustment?.method || 'ATR'
      },
      emergencyStop: {
        enabled: this.features?.emergencyStop?.enabled || false
      },
      orderExecution: {
        enabled: this.features?.orderExecution?.enabled || false,
        useLimit: this.features?.orderExecution?.useLimit || false
      },
      compounding: {
        enabled: this.features?.compounding?.enabled || false
      },
      version: this.features?._meta?.version || '2.0.0'
    };
  }
}

module.exports = { UniversalFeatures, DEFAULT_FEATURES, CORRELATION_GROUPS };
