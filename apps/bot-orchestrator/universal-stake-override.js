const fs = require('fs-extra');
const path = require('path');
const UniversalRiskManager = require('./universal-risk-manager');

/**
 * Universal Stake Override System
 * 
 * This system overrides FreqTrade's stake amounts by:
 * 1. Monitoring the config.json file for each bot
 * 2. Dynamically adjusting stake_amount based on universal risk settings
 * 3. Works with ANY strategy by operating at the configuration level
 * 
 * This approach is strategy-independent because it modifies the bot's
 * fundamental configuration rather than trying to intercept strategy logic.
 */

class UniversalStakeOverride {
  constructor() {
    this.riskManagers = new Map();
    this.configWatchers = new Map();
    this.originalConfigs = new Map(); // Store original configs for restoration
  }

  /**
   * Initialize stake override for a bot instance
   */
  async initializeForBot(instanceId, userId, botDir) {
    const key = `${userId}-${instanceId}`;
    
    try {
      // Create risk manager
      const riskManager = new UniversalRiskManager(instanceId, userId);
      await riskManager.loadSettings();
      this.riskManagers.set(key, riskManager);
      
      if (!riskManager.settings.enabled) {
        console.log(`[${instanceId}] Universal risk management disabled, skipping stake override`);
        return;
      }

      // Find and process config file
      const configPath = path.join(botDir, 'config.json');
      if (await fs.pathExists(configPath)) {
        await this.setupStakeOverride(instanceId, userId, configPath, riskManager);
        console.log(`[${instanceId}] ✅ Universal stake override initialized`);
      } else {
        console.warn(`[${instanceId}] Config file not found at ${configPath}`);
      }
      
    } catch (error) {
      console.error(`[${instanceId}] Failed to initialize stake override:`, error.message);
    }
  }

  /**
   * Initialize stake override for all existing bots of a user
   */
  async initializeAllUserBots(userId, botBaseDir) {
    try {
      const userDir = path.join(botBaseDir, userId);
      
      if (!(await fs.pathExists(userDir))) {
        console.log(`[Universal] No bots found for user ${userId}`);
        return;
      }

      const botDirs = await fs.readdir(userDir);
      console.log(`[Universal] Found ${botDirs.length} potential bot instances for user ${userId}`);

      for (const botDir of botDirs) {
        const fullBotPath = path.join(userDir, botDir);
        const stats = await fs.stat(fullBotPath);
        
        if (stats.isDirectory()) {
          console.log(`[Universal] Initializing universal stake override for ${userId}/${botDir}`);
          await this.initializeForBot(botDir, userId, fullBotPath);
        }
      }
      
      console.log(`[Universal] ✅ Universal stake override initialized for all user ${userId} bots`);
    } catch (error) {
      console.error(`[Universal] Failed to initialize all user bots:`, error.message);
    }
  }

  /**
   * Setup stake amount override for a specific bot
   */
  async setupStakeOverride(instanceId, userId, configPath, riskManager) {
    try {
      // Read current config
      const config = await fs.readJson(configPath);
      const key = `${userId}-${instanceId}`;
      
      // Store original config if not already stored
      if (!this.originalConfigs.has(key)) {
        this.originalConfigs.set(key, JSON.parse(JSON.stringify(config)));
      }

      // Calculate dynamic stake amount based on risk settings
      const dynamicStake = await this.calculateDynamicStakeAmount(riskManager);
      
      // Override stake configuration
      if (dynamicStake > 0) {
        config.stake_amount = dynamicStake;
        config.stake_currency = 'USDT'; // Ensure we're using USDT
        
        // Set unlimited stakes to allow risk management to control position sizing
        config.max_open_trades = riskManager.settings.maxOpenTrades || 10;
        
        // Ensure we can trade any amount with modern timeout settings
        if (config.unfilledtimeout) {
          config.unfilledtimeout.unit = 'minutes';
          config.unfilledtimeout.entry = 10;
          config.unfilledtimeout.exit = 30;
          // Remove deprecated fields to avoid conflicts
          delete config.unfilledtimeout.buy;
          delete config.unfilledtimeout.sell;
        }

        // Write updated config
        await fs.writeJson(configPath, config, { spaces: 2 });
        
        console.log(`[${instanceId}] 🎯 Stake amount overridden: $${dynamicStake.toFixed(2)} (${riskManager.settings.riskPercentage}% risk)`);
      }

      // Set up periodic updates
      this.setupPeriodicUpdates(instanceId, userId, configPath, riskManager);
      
    } catch (error) {
      console.error(`[${instanceId}] Failed to setup stake override:`, error.message);
    }
  }

  /**
   * Calculate dynamic stake amount based on universal risk settings
   */
  async calculateDynamicStakeAmount(riskManager) {
    try {
      // Get current account balance (mock for now, would be real API call)
      const accountBalance = await this.getAccountBalance(riskManager.instanceId);
      
      // Use the universal risk settings directly
      const riskPercentage = riskManager.settings.riskPercentage || riskManager.settings.riskLevel || 50;
      const maxOpenTrades = riskManager.settings.maxOpenTrades || 10;
      
      // Calculate risk per trade based on total risk percentage
      // With 95% total risk across 10 trades, each trade should risk ~9.5% of balance
      const riskPerTrade = riskPercentage / 100 / maxOpenTrades;
      
      // Calculate position size based on account balance and risk per trade
      const positionSize = accountBalance * riskPerTrade;
      
      console.log(`[${riskManager.instanceId}] 📊 Risk calculation: ${riskPercentage}% total risk, ${maxOpenTrades} max trades, ${(riskPerTrade * 100).toFixed(1)}% per trade = $${positionSize.toFixed(2)}`);
      
      return positionSize || 100; // Fallback to $100 if calculation fails
      
    } catch (error) {
      console.error(`[${riskManager.instanceId}] Dynamic stake calculation failed:`, error.message);
      return 100; // Safe fallback
    }
  }

  /**
   * Setup periodic updates to refresh stake amounts
   */
  setupPeriodicUpdates(instanceId, userId, configPath, riskManager) {
    const key = `${userId}-${instanceId}`;
    
    // Clear existing interval if any
    if (this.configWatchers.has(key)) {
      clearInterval(this.configWatchers.get(key));
    }

    // Set up periodic updates every 5 minutes
    const updateInterval = setInterval(async () => {
      try {
        await riskManager.loadSettings(); // Refresh settings
        
        if (riskManager.settings.enabled) {
          const newStakeAmount = await this.calculateDynamicStakeAmount(riskManager);
          await this.updateStakeAmount(configPath, newStakeAmount);
          console.log(`[${instanceId}] 🔄 Stake amount updated: $${newStakeAmount.toFixed(2)}`);
        }
        
      } catch (error) {
        console.error(`[${instanceId}] Periodic stake update failed:`, error.message);
      }
    }, 5 * 60 * 1000); // 5 minutes
    
    this.configWatchers.set(key, updateInterval);
  }

  /**
   * Update just the stake amount in config file
   */
  async updateStakeAmount(configPath, newStakeAmount) {
    try {
      const config = await fs.readJson(configPath);
      config.stake_amount = newStakeAmount;
      await fs.writeJson(configPath, config, { spaces: 2 });
    } catch (error) {
      console.error(`Failed to update stake amount:`, error.message);
    }
  }

  /**
   * Get current account balance (placeholder - would be real API call)
   */
  async getAccountBalance(instanceId) {
    try {
      // This would make a real API call to FreqTrade
      // For now, return mock balance
      return 10000;
    } catch (error) {
      console.error(`[${instanceId}] Failed to get account balance:`, error.message);
      return 10000; // Safe fallback
    }
  }

  /**
   * Restore original configuration for a bot
   */
  async restoreOriginalConfig(instanceId, userId, configPath) {
    const key = `${userId}-${instanceId}`;
    
    try {
      if (this.originalConfigs.has(key)) {
        const originalConfig = this.originalConfigs.get(key);
        await fs.writeJson(configPath, originalConfig, { spaces: 2 });
        console.log(`[${instanceId}] ✅ Original configuration restored`);
      }
    } catch (error) {
      console.error(`[${instanceId}] Failed to restore original config:`, error.message);
    }
  }

  /**
   * Stop monitoring a bot instance
   */
  stopMonitoring(instanceId, userId) {
    const key = `${userId}-${instanceId}`;
    
    // Clear interval
    if (this.configWatchers.has(key)) {
      clearInterval(this.configWatchers.get(key));
      this.configWatchers.delete(key);
    }
    
    // Remove from cache
    this.riskManagers.delete(key);
    
    console.log(`[${instanceId}] ✅ Universal stake override stopped`);
  }

  /**
   * Get status of all monitored bots
   */
  getStatus() {
    const status = {
      monitoredBots: this.riskManagers.size,
      activeWatchers: this.configWatchers.size,
      bots: []
    };

    for (const [key, riskManager] of this.riskManagers.entries()) {
      status.bots.push({
        key,
        instanceId: riskManager.instanceId,
        enabled: riskManager.settings.enabled,
        riskPercentage: riskManager.settings.riskPercentage,
        hasWatcher: this.configWatchers.has(key)
      });
    }

    return status;
  }

  /**
   * Apply DCA (Dollar Cost Averaging) by temporarily increasing stake amount
   */
  async applyDCAStakeIncrease(instanceId, userId, configPath, multiplier = 1.5) {
    try {
      const config = await fs.readJson(configPath);
      const currentStake = config.stake_amount || 100;
      const dcaStake = currentStake * multiplier;
      
      config.stake_amount = dcaStake;
      await fs.writeJson(configPath, config, { spaces: 2 });
      
      console.log(`[${instanceId}] 📈 DCA stake increase applied: $${currentStake.toFixed(2)} -> $${dcaStake.toFixed(2)}`);
      
      // Revert after 1 minute to prevent permanent changes
      setTimeout(async () => {
        try {
          const revertConfig = await fs.readJson(configPath);
          revertConfig.stake_amount = currentStake;
          await fs.writeJson(configPath, revertConfig, { spaces: 2 });
          console.log(`[${instanceId}] 🔄 DCA stake reverted to normal: $${currentStake.toFixed(2)}`);
        } catch (error) {
          console.error(`[${instanceId}] Failed to revert DCA stake:`, error.message);
        }
      }, 60000); // 1 minute
      
    } catch (error) {
      console.error(`[${instanceId}] Failed to apply DCA stake increase:`, error.message);
    }
  }
}

// Create singleton instance
const universalStakeOverride = new UniversalStakeOverride();

module.exports = {
  UniversalStakeOverride,
  universalStakeOverride
};