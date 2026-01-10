/**
 * Universal FreqTrade Wrapper - Strategy-Independent Risk Management
 * 
 * This service runs alongside FreqTrade bots and intercepts their behavior
 * to apply universal risk management, DCA, and rebalancing regardless of strategy.
 * 
 * It works by:
 * 1. Monitoring FreqTrade databases for trade changes
 * 2. Intercepting trade execution through FreqTrade API
 * 3. Applying position sizing overrides before trades execute
 * 4. Managing DCA and rebalancing through additional API calls
 */

const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const UniversalRiskManager = require('./universal-risk-manager');

class UniversalFreqTradeWrapper {
  constructor(instanceId, userId, freqtradeApiUrl, dbPath, instanceDir = null) {
    this.instanceId = instanceId;
    this.userId = userId;
    this.freqtradeApiUrl = freqtradeApiUrl;
    this.dbPath = dbPath;
    this.instanceDir = instanceDir;
    this.riskManager = null;
    
    // Monitoring state
    this.isRunning = false;
    this.monitorInterval = null;
    this.lastTradeId = 0;
    
    console.log(`[${instanceId}] Universal FreqTrade Wrapper initialized`);
  }

  /**
   * Initialize the risk manager and start monitoring
   */
  async start() {
    try {
      // Initialize risk manager with instanceDir to avoid legacy path creation
      this.riskManager = new UniversalRiskManager(this.instanceId, this.userId, this.instanceDir);
      await this.riskManager.loadSettings();
      
      if (!this.riskManager.settings.enabled) {
        console.log(`[${this.instanceId}] Universal risk management disabled - wrapper inactive`);
        return;
      }
      
      console.log(`[${this.instanceId}] 🎯 Universal risk management enabled: ${this.riskManager.settings.riskLevel}% risk level`);
      
      // Get last trade ID to start monitoring from
      await this.initializeLastTradeId();
      
      // Start monitoring FreqTrade database and API
      this.isRunning = true;
      this.startDatabaseMonitoring();
      this.startPeriodicRebalancing();
      
      console.log(`[${this.instanceId}] ✅ Universal wrapper started successfully`);
      
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to start universal wrapper:`, error.message);
    }
  }

  /**
   * Stop monitoring and clean up
   */
  async stop() {
    this.isRunning = false;
    
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    
    if (this.rebalanceInterval) {
      clearInterval(this.rebalanceInterval);
      this.rebalanceInterval = null;
    }
    
    console.log(`[${this.instanceId}] Universal wrapper stopped`);
  }

  /**
   * Get the last trade ID from database to start monitoring
   */
  async initializeLastTradeId() {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          console.log(`[${this.instanceId}] Database not yet available, starting from 0`);
          this.lastTradeId = 0;
          return resolve();
        }
        
        db.get("SELECT MAX(id) as maxId FROM trades", (err, row) => {
          if (err) {
            console.log(`[${this.instanceId}] Could not read trades, starting from 0`);
            this.lastTradeId = 0;
          } else {
            this.lastTradeId = row?.maxId || 0;
            console.log(`[${this.instanceId}] Starting trade monitoring from ID: ${this.lastTradeId}`);
          }
          
          db.close();
          resolve();
        });
      });
    });
  }

  /**
   * Monitor FreqTrade database for new trades and apply risk management
   */
  startDatabaseMonitoring() {
    this.monitorInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        await this.checkForNewTrades();
        await this.checkForDCAOpportunities();
        
      } catch (error) {
        console.error(`[${this.instanceId}] Database monitoring error:`, error.message);
      }
      
    }, 5000); // Check every 5 seconds
  }

  /**
   * Check for new trades that need position size adjustment
   */
  async checkForNewTrades() {
    return new Promise((resolve) => {
      const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
          return resolve(); // Database not available yet
        }
        
        db.all(
          "SELECT * FROM trades WHERE id > ? AND is_open = 1 ORDER BY id ASC", 
          [this.lastTradeId], 
          async (err, rows) => {
            if (err) {
              db.close();
              return resolve();
            }
            
            for (const trade of rows) {
              await this.handleNewTrade(trade);
              this.lastTradeId = Math.max(this.lastTradeId, trade.id);
            }
            
            db.close();
            resolve();
          }
        );
      });
    });
  }

  /**
   * Handle a new trade and apply position size adjustment if needed
   */
  async handleNewTrade(trade) {
    try {
      console.log(`[${this.instanceId}] 📊 New trade detected: ${trade.pair} - $${trade.stake_amount}`);
      
      // Get current account balance and positions
      const accountBalance = await this.getAccountBalance();
      const currentPositions = await this.getCurrentPositions();
      
      // Calculate what the optimal position size should be
      const optimalSize = await this.riskManager.calculateOptimalPositionSize(
        trade.pair, 
        accountBalance, 
        currentPositions
      );
      
      if (optimalSize && Math.abs(optimalSize - parseFloat(trade.stake_amount)) > 1) {
        console.log(`[${this.instanceId}] 🎯 Position size mismatch detected:`);
        console.log(`  Current: $${trade.stake_amount}`);
        console.log(`  Optimal: $${optimalSize.toFixed(2)}`);
        
        // If the position is significantly different, we need to adjust
        await this.adjustTradeSize(trade, optimalSize);
      }
      
    } catch (error) {
      console.error(`[${this.instanceId}] Error handling new trade:`, error.message);
    }
  }

  /**
   * Adjust trade size by closing current position and opening new one with correct size
   */
  async adjustTradeSize(trade, targetSize) {
    try {
      console.log(`[${this.instanceId}] 🔄 Adjusting position size for ${trade.pair}`);
      
      // Force sell the current position
      await this.freqtradeApiCall('POST', `/api/v1/forceexit`, {
        tradeid: trade.id,
        ordertype: 'market'
      });
      
      // Wait a moment for the exit to process
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Place a new buy order with the correct size
      const currentPrice = await this.getCurrentPrice(trade.pair);
      if (currentPrice) {
        const amount = targetSize / currentPrice;
        
        await this.freqtradeApiCall('POST', `/api/v1/forceentry`, {
          pair: trade.pair,
          side: 'long', // Assuming long positions
          amount: amount,
          ordertype: 'market'
        });
        
        console.log(`[${this.instanceId}] ✅ Position adjusted: ${trade.pair} -> $${targetSize.toFixed(2)}`);
      }
      
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to adjust trade size:`, error.message);
    }
  }

  /**
   * Check for DCA opportunities on existing positions
   */
  async checkForDCAOpportunities() {
    try {
      const openTrades = await this.getOpenTrades();
      
      for (const trade of openTrades) {
        const currentPrice = await this.getCurrentPrice(trade.pair);
        if (currentPrice) {
          await this.riskManager.checkAndPlaceDCAOrders(trade.pair, currentPrice, [trade]);
        }
      }
      
    } catch (error) {
      console.error(`[${this.instanceId}] DCA check error:`, error.message);
    }
  }

  /**
   * Start periodic portfolio rebalancing
   */
  startPeriodicRebalancing() {
    this.rebalanceInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        const accountBalance = await this.getAccountBalance();
        const currentPositions = await this.getCurrentPositions();
        
        await this.riskManager.checkAndRebalance(currentPositions, accountBalance);
        
      } catch (error) {
        console.error(`[${this.instanceId}] Rebalancing error:`, error.message);
      }
      
    }, 300000); // Rebalance check every 5 minutes
  }

  /**
   * Make API call to FreqTrade
   */
  async freqtradeApiCall(method, endpoint, data = null) {
    try {
      const config = {
        method,
        url: `${this.freqtradeApiUrl}${endpoint}`,
        headers: {
          'Content-Type': 'application/json'
        }
      };
      
      if (data) {
        config.data = data;
      }
      
      const response = await axios(config);
      return response.data;
      
    } catch (error) {
      console.error(`[${this.instanceId}] FreqTrade API call failed:`, error.message);
      throw error;
    }
  }

  /**
   * Get account balance from FreqTrade
   */
  async getAccountBalance() {
    try {
      const response = await this.freqtradeApiCall('GET', '/api/v1/balance');
      
      // Calculate total balance from response
      let totalBalance = 0;
      if (response && response.currencies) {
        for (const currency of response.currencies) {
          if (currency.currency === 'USD' || currency.currency === 'USDT') {
            totalBalance += parseFloat(currency.total || 0);
          }
        }
      }
      
      return totalBalance || 10000; // Fallback value
      
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to get account balance:`, error.message);
      return 10000; // Fallback value
    }
  }

  /**
   * Get current positions from FreqTrade
   */
  async getCurrentPositions() {
    try {
      const response = await this.freqtradeApiCall('GET', '/api/v1/status');
      return response || [];
      
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to get current positions:`, error.message);
      return [];
    }
  }

  /**
   * Get open trades from FreqTrade
   */
  async getOpenTrades() {
    try {
      const response = await this.freqtradeApiCall('GET', '/api/v1/status');
      return response || [];
      
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to get open trades:`, error.message);
      return [];
    }
  }

  /**
   * Get current price for a trading pair
   */
  async getCurrentPrice(pair) {
    try {
      const response = await this.freqtradeApiCall('GET', `/api/v1/ticker`);
      
      if (response && response[pair]) {
        return parseFloat(response[pair].last);
      }
      
      return null;
      
    } catch (error) {
      console.error(`[${this.instanceId}] Failed to get current price for ${pair}:`, error.message);
      return null;
    }
  }

  /**
   * Reload settings (call after settings updates)
   */
  async reloadSettings() {
    if (this.riskManager) {
      await this.riskManager.loadSettings();
      console.log(`[${this.instanceId}] Settings reloaded - Risk Level: ${this.riskManager.settings.riskLevel}%`);
    }
  }
}

module.exports = UniversalFreqTradeWrapper;