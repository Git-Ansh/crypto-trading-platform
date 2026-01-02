// Universal Risk Management Middleware
// This middleware intercepts FreqTrade API calls and applies risk management, DCA, and auto-rebalancing
// to ANY strategy without modifying the strategy code itself.
//
// All bot-specific settings are stored in the bot's config.json file
// located at: freqtrade-instances/{userId}/{instanceId}/config.json
// Universal settings are stored under the "universalSettings" key within config.json

const fs = require('fs-extra');
const path = require('path');

class UniversalRiskManager {
  constructor(instanceId, userId) {
    this.instanceId = instanceId;
    this.userId = userId;
    
    // Bot instances directory
    this.instanceDir = path.join(__dirname, '..', 'freqtrade-instances', this.userId, instanceId);
    
    // SINGLE config file - the bot's existing config.json
    this.configPath = path.join(this.instanceDir, 'config.json');
    
    // User data paths for runtime data (positions, DCA orders, etc.)
    const userDataDir = path.join(this.instanceDir, 'user_data');
    this.positionsPath = path.join(userDataDir, 'positions.json');
    this.dcaOrdersPath = path.join(userDataDir, 'dca-orders.json');
    this.rebalanceLogPath = path.join(userDataDir, 'rebalance-log.json');
    
    // Default universal settings - stored under "universalSettings" key in config.json
    this.defaultSettings = {
      enabled: true,
      riskLevel: 50,              // 0-100 scale
      autoRebalance: true,
      dcaEnabled: true,
      riskConfig: null,           // Will be computed on load/update
      createdAt: null,
      updatedAt: null
    };
    
    this.settings = null;
    this.botConfig = null;  // Full bot config.json contents
  }

  /**
   * Compute risk configuration based on the risk level slider (0-100)
   */
  computeRiskConfig(riskLevel) {
    const level = riskLevel / 100; // Convert to 0-1 scale
    
    return {
      maxDrawdown: 0.05 + (level * 0.20),          // 5% to 25%
      maxTotalRisk: 0.10 + (level * 0.25),         // 10% to 35%
      riskPerTrade: 0.01 + (level * 0.02),         // 1% to 3%
      positionSizing: {
        baseStakePercent: 0.05 + (level * 0.10),   // 5% to 15%
        maxStakePercent: 0.10 + (level * 0.25),    // 10% to 35%
        volatilityAdjustment: true
      },
      stopLoss: {
        enabled: true,
        baseStopLoss: -0.04 - (level * 0.08),      // -4% to -12%
        trailingStop: true,
        dynamicAdjustment: true
      },
      dca: {
        enabled: this.settings?.dcaEnabled ?? true,
        maxOrders: Math.floor(2 + (level * 3)),    // 2 to 5 orders
        triggerPercent: -0.03 - (level * 0.09),    // -3% to -12%
        sizeMultiplier: 1.2 + (level * 0.8)        // 1.2x to 2.0x
      },
      rebalancing: {
        enabled: this.settings?.autoRebalance ?? true,
        threshold: 0.20 - (level * 0.05),          // 20% to 15%
        frequency: 24,
        targetAllocations: {
          btc: 0.40,
          eth: 0.25,
          alt: 0.20,
          stable: 0.10,
          other: 0.05
        }
      }
    };
  }

  /**
   * Load settings from the bot's config.json file
   */
  async loadSettings() {
    try {
      if (await fs.pathExists(this.configPath)) {
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.botConfig = JSON.parse(configData);
        
        // Extract universalSettings from config, or use defaults
        if (this.botConfig.universalSettings) {
          this.settings = { ...this.defaultSettings, ...this.botConfig.universalSettings };
        } else {
          // Initialize with defaults if universalSettings doesn't exist
          this.settings = { ...this.defaultSettings };
          this.settings.createdAt = new Date().toISOString();
          this.settings.updatedAt = new Date().toISOString();
        }
        
        // Ensure riskConfig is up to date with current riskLevel
        this.settings.riskConfig = this.computeRiskConfig(this.settings.riskLevel);
      } else {
        // No config.json exists - use defaults (shouldn't happen for existing bots)
        this.settings = { ...this.defaultSettings };
        this.settings.riskConfig = this.computeRiskConfig(this.settings.riskLevel);
        this.botConfig = {};
      }
    } catch (error) {
      console.warn(`[${this.instanceId}] Failed to load settings from config.json, using defaults:`, error.message);
      this.settings = { ...this.defaultSettings };
      this.settings.riskConfig = this.computeRiskConfig(this.settings.riskLevel);
      this.botConfig = {};
    }
  }

  /**
   * Save settings to the bot's config.json file (under universalSettings key)
   */
  async saveSettings() {
    try {
      // Reload current config to avoid overwriting other changes
      if (await fs.pathExists(this.configPath)) {
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.botConfig = JSON.parse(configData);
      }
      
      // Update the universalSettings section
      this.settings.updatedAt = new Date().toISOString();
      this.botConfig.universalSettings = this.settings;
      
      await fs.writeFile(this.configPath, JSON.stringify(this.botConfig, null, 2), 'utf8');
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to save settings to config.json:`, error.message);
      throw error;
    }
  }

  /**
   * Update settings with new values and recompute risk config
   */
  async updateSettings(newSettings) {
    // First load current settings to ensure we have latest
    await this.loadSettings();
    
    // Merge new settings
    this.settings = { ...this.settings, ...newSettings };
    
    // Recompute risk config based on updated riskLevel
    this.settings.riskConfig = this.computeRiskConfig(this.settings.riskLevel);
    // Update DCA and rebalancing enabled flags in riskConfig
    this.settings.riskConfig.dca.enabled = this.settings.dcaEnabled;
    this.settings.riskConfig.rebalancing.enabled = this.settings.autoRebalance;
    
    await this.saveSettings();
  }

  /**
   * Get the current risk configuration (computed from riskLevel)
   */
  getRiskConfig() {
    if (!this.settings?.riskConfig) {
      return this.computeRiskConfig(this.settings?.riskLevel ?? 50);
    }
    return this.settings.riskConfig;
  }

  /**
   * Get the full bot config (including FreqTrade settings)
   */
  getBotConfig() {
    return this.botConfig;
  }

  /**
   * Intercept and modify stake amount based on risk settings
   */
  async calculateStakeAmount(originalAmount, pair, currentPrice, accountBalance) {
    if (!this.settings?.enabled) return originalAmount;

    try {
      const riskConfig = this.getRiskConfig();
      const baseStake = accountBalance * riskConfig.positionSizing.baseStakePercent;
      const maxStake = accountBalance * riskConfig.positionSizing.maxStakePercent;
      
      // Apply volatility adjustment if enabled
      let adjustedStake = baseStake;
      if (riskConfig.positionSizing.volatilityAdjustment) {
        const volatility = await this.calculateVolatility(pair);
        adjustedStake = baseStake * (1 / (1 + volatility));
      }
      
      // Ensure we don't exceed maximum stake
      const finalStake = Math.min(adjustedStake, maxStake);
      
      return finalStake;
    } catch (error) {
      console.warn(`[${this.instanceId}] Position sizing failed, using original amount:`, error.message);
      return originalAmount;
    }
  }

  /**
   * DCA Order Management
   */
  async checkAndPlaceDCAOrders(pair, currentPrice, openTrades) {
    if (!this.settings?.enabled || !this.settings?.dcaEnabled) return;

    try {
      const riskConfig = this.getRiskConfig();
      if (!riskConfig.dca.enabled) return;

      // Load existing DCA orders
      let dcaOrders = {};
      if (await fs.pathExists(this.dcaOrdersPath)) {
        const dcaData = await fs.readFile(this.dcaOrdersPath, 'utf8');
        dcaOrders = JSON.parse(dcaData);
      }

      // Check each open trade for DCA opportunities
      for (const trade of openTrades) {
        if (trade.pair === pair && trade.is_open) {
          const entryPrice = trade.open_rate;
          const priceDropPercent = (currentPrice - entryPrice) / entryPrice;
          
          const dcaKey = `${pair}_${trade.trade_id}`;
          const existingDCAOrders = dcaOrders[dcaKey] || [];
          
          // Check if we should place a DCA order
          if (priceDropPercent <= riskConfig.dca.triggerPercent && 
              existingDCAOrders.length < riskConfig.dca.maxOrders) {
            
            const dcaSize = trade.stake_amount * riskConfig.dca.sizeMultiplier;
            
            // Create DCA order record
            const dcaOrder = {
              pair: pair,
              originalTradeId: trade.trade_id,
              size: dcaSize,
              price: currentPrice,
              timestamp: Date.now(),
              level: existingDCAOrders.length + 1,
              status: 'planned'
            };
            
            existingDCAOrders.push(dcaOrder);
            dcaOrders[dcaKey] = existingDCAOrders;
          }
        }
      }

      // Save updated DCA orders
      await fs.ensureDir(path.dirname(this.dcaOrdersPath));
      await fs.writeFile(this.dcaOrdersPath, JSON.stringify(dcaOrders, null, 2), 'utf8');
      
    } catch (error) {
      console.error(`[${this.instanceId}] DCA management failed:`, error.message);
    }
  }

  /**
   * Auto-Rebalancing Logic
   */
  async checkAndRebalance(currentPositions, accountBalance) {
    if (!this.settings?.enabled || !this.settings?.autoRebalance) return;

    try {
      const riskConfig = this.getRiskConfig();
      if (!riskConfig.rebalancing.enabled) return;

      // Calculate current allocations
      const currentAllocations = this.calculateCurrentAllocations(currentPositions, accountBalance);
      const targetAllocations = riskConfig.rebalancing.targetAllocations;
      
      // Check if rebalancing is needed
      const needsRebalancing = this.checkRebalancingThreshold(currentAllocations, targetAllocations, riskConfig.rebalancing.threshold);
      
      if (needsRebalancing) {
        // Calculate rebalancing actions
        const rebalanceActions = this.calculateRebalanceActions(currentAllocations, targetAllocations, accountBalance);
        
        // Save rebalancing record
        const rebalanceRecord = {
          timestamp: Date.now(),
          currentAllocations: currentAllocations,
          targetAllocations: targetAllocations,
          actions: rebalanceActions,
          accountBalance: accountBalance
        };
        
        let rebalanceHistory = [];
        if (await fs.pathExists(this.rebalanceLogPath)) {
          const historyData = await fs.readFile(this.rebalanceLogPath, 'utf8');
          rebalanceHistory = JSON.parse(historyData);
        }
        
        rebalanceHistory.push(rebalanceRecord);
        
        // Keep only last 50 rebalance records
        if (rebalanceHistory.length > 50) {
          rebalanceHistory = rebalanceHistory.slice(-50);
        }
        
        await fs.ensureDir(path.dirname(this.rebalanceLogPath));
        await fs.writeFile(this.rebalanceLogPath, JSON.stringify(rebalanceHistory, null, 2), 'utf8');
      }
      
    } catch (error) {
      console.error(`[${this.instanceId}] Auto-rebalancing failed:`, error.message);
    }
  }

  /**
   * Calculate optimal position size
   */
  async calculateOptimalPositionSize(pair, accountBalance, currentPositions) {
    try {
      const riskConfig = this.getRiskConfig();
      const riskPerTrade = riskConfig.riskPerTrade;
      const maxPositions = riskConfig.positionSizing?.maxPositions || 10;
      
      // Check if we're at max positions
      if (currentPositions.length >= maxPositions) {
        return 0;
      }
      
      // Calculate position size based on risk per trade
      const riskAmount = accountBalance * riskPerTrade;
      
      // Apply pair-specific risk multipliers if configured
      const pairConfig = riskConfig.positionSizing?.pairMultipliers?.[pair];
      const multiplier = pairConfig || 1.0;
      
      return riskAmount * multiplier;
      
    } catch (error) {
      console.error(`[${this.instanceId}] Position sizing failed:`, error.message);
      return null;
    }
  }

  calculateCurrentAllocations(positions, totalBalance) {
    const allocations = { btc: 0, eth: 0, alt: 0, stable: 0, other: 0 };
    
    for (const [pair, position] of Object.entries(positions)) {
      const value = position.value || 0;
      const percentage = value / totalBalance;
      
      if (pair.includes('BTC')) allocations.btc += percentage;
      else if (pair.includes('ETH')) allocations.eth += percentage;
      else if (pair.includes('USD') || pair.includes('USDT')) allocations.stable += percentage;
      else if (['ADA', 'SOL', 'DOT', 'AVAX', 'MATIC'].some(alt => pair.includes(alt))) allocations.alt += percentage;
      else allocations.other += percentage;
    }
    
    return allocations;
  }

  checkRebalancingThreshold(current, target, threshold) {
    for (const [category, targetPercent] of Object.entries(target)) {
      const currentPercent = current[category] || 0;
      const drift = Math.abs(currentPercent - targetPercent);
      if (drift > threshold) {
        return true;
      }
    }
    return false;
  }

  calculateRebalanceActions(current, target, totalBalance) {
    const actions = [];
    
    for (const [category, targetPercent] of Object.entries(target)) {
      const currentPercent = current[category] || 0;
      const difference = targetPercent - currentPercent;
      const dollarAmount = difference * totalBalance;
      
      if (Math.abs(dollarAmount) > 50) {
        actions.push({
          category: category,
          action: dollarAmount > 0 ? 'BUY' : 'SELL',
          amount: Math.abs(dollarAmount),
          pair: this.getCategoryPair(category)
        });
      }
    }
    
    return actions;
  }

  getCategoryPair(category) {
    const categoryPairs = {
      btc: 'BTC/USD',
      eth: 'ETH/USD',
      alt: 'SOL/USD',
      stable: 'USD',
      other: 'ADA/USD'
    };
    return categoryPairs[category] || 'BTC/USD';
  }

  async calculateVolatility(pair) {
    try {
      return Math.random() * 0.1; // 0-10% volatility (placeholder)
    } catch (error) {
      return 0.05; // Default 5% volatility
    }
  }
}

module.exports = UniversalRiskManager;
