const fs = require('fs-extra');
const path = require('path');
const UniversalRiskManager = require('./universal-risk-manager');
const { UniversalFeatures } = require('./universal-features');

/**
 * FreqTrade API Interceptor - Strategy-Independent Risk Management
 * 
 * This module provides middleware to intercept FreqTrade API calls and apply
 * universal risk management settings regardless of the trading strategy.
 * 
 * It intercepts:
 * - Trade entry signals to apply position sizing and check trading permissions
 * - Balance queries to apply DCA management  
 * - Portfolio updates to trigger rebalancing
 * - All requests to check trading schedule, daily loss limits, and emergency stops
 */

class FreqTradeAPIInterceptor {
  constructor() {
    this.riskManagers = new Map(); // Cache risk managers by instanceId
    this.featureManagers = new Map(); // Cache universal features by instanceId
  }

  /**
   * Get or create a risk manager for a bot instance
   * Reloads settings on each call to ensure fresh configuration
   */
  async getRiskManager(instanceId, userId, instanceDir = null) {
    const key = `${userId}-${instanceId}`;
    
    if (!this.riskManagers.has(key)) {
      const riskManager = new UniversalRiskManager(instanceId, userId, instanceDir);
      await riskManager.loadSettings();
      this.riskManagers.set(key, riskManager);
    } else {
      // Reload settings to pick up any changes made via API
      const riskManager = this.riskManagers.get(key);
      await riskManager.loadSettings();
    }
    
    return this.riskManagers.get(key);
  }

  /**
   * Get or create a feature manager for a bot instance
   */
  async getFeatureManager(instanceId, userId, instanceDir = null) {
    const key = `${userId}-${instanceId}`;
    
    if (!this.featureManagers.has(key)) {
      const features = new UniversalFeatures(instanceId, userId, instanceDir);
      await features.loadFeatures();
      this.featureManagers.set(key, features);
    } else {
      const features = this.featureManagers.get(key);
      await features.loadFeatures();
    }
    
    return this.featureManagers.get(key);
  }

  /**
   * Clear cached risk manager (call after settings updates)
   */
  clearCache(instanceId, userId) {
    const key = `${userId}-${instanceId}`;
    this.riskManagers.delete(key);
    this.featureManagers.delete(key);
    console.log(`[${instanceId}] Risk manager and feature cache cleared for real-time updates`);
  }

  /**
   * Middleware to intercept and modify FreqTrade API requests
   */
  async interceptAPIRequest(req, res, next, instanceId, userId) {
    try {
      const riskManager = await this.getRiskManager(instanceId, userId);
      const features = await this.getFeatureManager(instanceId, userId);
      
      if (!riskManager.settings.enabled) {
        return next(); // Pass through if universal risk management is disabled
      }

      // First, check if trading is allowed (schedule, daily loss, emergency)
      const tradingStatus = await this.checkTradingPermissions(instanceId, userId, features);
      if (!tradingStatus.allowed) {
        // Block new entries but allow exits
        const apiPath = req.path;
        if (apiPath.includes('/api/v1/forcebuy') || apiPath.includes('/api/v1/forceenter')) {
          console.log(`[${instanceId}] ⛔ Trade entry blocked: ${tradingStatus.reason}`);
          return res.status(403).json({
            success: false,
            message: `Trading paused: ${tradingStatus.reason}`,
            details: tradingStatus.details
          });
        }
      }

      // Intercept different API endpoints
      const apiPath = req.path;
      
      if ((apiPath.includes('/api/v1/trade') || apiPath.includes('/api/v1/forcebuy') || apiPath.includes('/api/v1/forceenter')) && req.method === 'POST') {
        // Intercepting trade entry - apply position sizing and position limits
        const allowed = await this.interceptTradeEntry(req, riskManager, features);
        if (!allowed.success) {
          return res.status(403).json(allowed);
        }
        
      } else if (apiPath.includes('/api/v1/balance') && req.method === 'GET') {
        // Intercepting balance query - trigger background risk management
        setImmediate(() => this.triggerBackgroundRiskManagement(instanceId, userId, riskManager));
        
      } else if (apiPath.includes('/api/v1/profit') && req.method === 'GET') {
        // Intercepting profit query - trigger rebalancing check
        setImmediate(() => this.triggerRebalancingCheck(instanceId, userId, riskManager));
      }
      
      next();
      
    } catch (error) {
      console.error(`[${instanceId}] API Interceptor error:`, error.message);
      next(); // Continue even if interceptor fails
    }
  }

  /**
   * Check all trading permission features
   */
  async checkTradingPermissions(instanceId, userId, features) {
    try {
      // Get current portfolio status for daily loss check
      const accountBalance = await this.getAccountBalance(instanceId);
      const dailyPnL = await this.getDailyPnL(instanceId);
      
      const status = await features.isTradingAllowed({
        currentPnL: dailyPnL,
        portfolioValue: accountBalance
      });
      
      return status;
    } catch (error) {
      console.error(`[${instanceId}] Error checking trading permissions:`, error.message);
      return { allowed: true }; // Allow trading on error (fail-open)
    }
  }

  /**
   * Intercept trade entry and apply position sizing and limits
   */
  async interceptTradeEntry(req, riskManager, features) {
    try {
      const instanceId = riskManager.instanceId;
      
      if (req.body && req.body.pair) {
        // Get current account balance and positions
        const accountBalance = await this.getAccountBalance(instanceId);
        const currentPositions = await this.getCurrentPositions(instanceId);
        const proposedSize = req.body.amount || req.body.stake_amount || 100;
        
        // Check position limits
        const limitsCheck = await features.checkPositionLimits(
          req.body.pair,
          currentPositions,
          accountBalance,
          proposedSize
        );
        
        if (!limitsCheck.allowed) {
          console.log(`[${instanceId}] ⛔ Position limit violated: ${limitsCheck.reason}`);
          return {
            success: false,
            message: `Position limit: ${limitsCheck.reason}`,
            details: limitsCheck
          };
        }
        
        // Calculate optimal position size with volatility adjustment
        let optimalSize = await riskManager.calculateOptimalPositionSize(
          req.body.pair, 
          accountBalance, 
          currentPositions
        );
        
        // Apply volatility adjustment if enabled
        if (features.features?.volatilityAdjustment?.enabled) {
          const volatility = await this.getVolatility(instanceId, req.body.pair);
          const avgVolatility = 0.02; // 2% as baseline (would be calculated from historical data)
          optimalSize = features.adjustStakeForVolatility(optimalSize, req.body.pair, volatility, avgVolatility);
        }
        
        if (optimalSize !== null && optimalSize > 0) {
          // Override the position size in the request
          req.body.stake_amount = optimalSize;
          if (req.body.amount) req.body.amount = optimalSize;
          console.log(`[${instanceId}] 🎯 Position size override: ${req.body.pair} -> $${optimalSize.toFixed(2)}`);
        }
        
        // Apply smart order execution settings
        if (features.features?.orderExecution?.enabled) {
          const marketPrice = await this.getCurrentPrice(instanceId, req.body.pair);
          if (marketPrice) {
            const orderParams = features.generateOrderParams('buy', marketPrice, optimalSize);
            if (orderParams.type === 'limit' && orderParams.price) {
              req.body.price = orderParams.price;
              req.body.ordertype = 'limit';
              console.log(`[${instanceId}] 📊 Smart order: limit at ${orderParams.price.toFixed(4)}`);
            }
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      console.error(`[${riskManager?.instanceId}] Trade entry interception failed:`, error.message);
      return { success: true }; // Allow on error
    }
  }

  /**
   * Trigger background DCA management
   */
  async triggerBackgroundRiskManagement(instanceId, userId, riskManager) {
    try {
      const openTrades = await this.getOpenTrades(instanceId);
      
      for (const trade of openTrades) {
        if (trade.is_open) {
          const currentPrice = await this.getCurrentPrice(instanceId, trade.pair);
          if (currentPrice) {
            await riskManager.checkAndPlaceDCAOrders(trade.pair, currentPrice, [trade]);
          }
        }
      }
      
    } catch (error) {
      console.error(`[${instanceId}] Background risk management failed:`, error.message);
    }
  }

  /**
   * Trigger portfolio rebalancing check
   */
  async triggerRebalancingCheck(instanceId, userId, riskManager) {
    try {
      const accountBalance = await this.getAccountBalance(instanceId);
      const currentPositions = await this.getCurrentPositions(instanceId);
      
      await riskManager.checkAndRebalance(currentPositions, accountBalance);
      
    } catch (error) {
      console.error(`[${instanceId}] Rebalancing check failed:`, error.message);
    }
  }

  // Helper methods to interact with FreqTrade API
  async getAccountBalance(instanceId) {
    try {
      // This would make an actual API call to FreqTrade
      // For now, return a mock value
      return 10000; 
    } catch (error) {
      console.error(`[${instanceId}] Failed to get account balance:`, error.message);
      return 0;
    }
  }

  async getCurrentPositions(instanceId) {
    try {
      // This would make an actual API call to FreqTrade to get open trades
      // For now, return empty array
      return [];
    } catch (error) {
      console.error(`[${instanceId}] Failed to get current positions:`, error.message);
      return [];
    }
  }

  async getOpenTrades(instanceId) {
    try {
      // This would make an actual API call to FreqTrade
      // For now, return empty array
      return [];
    } catch (error) {
      console.error(`[${instanceId}] Failed to get open trades:`, error.message);
      return [];
    }
  }

  async getCurrentPrice(instanceId, pair) {
    try {
      // This would make an actual API call to FreqTrade
      // For now, return mock price
      return 50000;
    } catch (error) {
      console.error(`[${instanceId}] Failed to get current price for ${pair}:`, error.message);
      return null;
    }
  }

  async getDailyPnL(instanceId) {
    try {
      // This would make an actual API call to FreqTrade /api/v1/profit
      return 0;
    } catch (error) {
      console.error(`[${instanceId}] Failed to get daily PnL:`, error.message);
      return 0;
    }
  }

  async getVolatility(instanceId, pair) {
    try {
      // This would calculate ATR or other volatility metric
      // For now, return mock volatility
      return 0.02 + (Math.random() * 0.02); // 2-4%
    } catch (error) {
      console.error(`[${instanceId}] Failed to get volatility for ${pair}:`, error.message);
      return 0.03; // Default 3%
    }
  }

  /**
   * Express middleware factory
   */
  createExpressMiddleware() {
    return (req, res, next) => {
      // Extract instanceId and userId from the request
      // This would need to be implemented based on your routing structure
      const instanceId = req.params.instanceId || req.headers['x-instance-id'];
      const userId = req.user?.id; // From authentication middleware
      
      if (instanceId && userId) {
        return this.interceptAPIRequest(req, res, next, instanceId, userId);
      }
      
      next();
    };
  }
}

// Create singleton instance
const apiInterceptor = new FreqTradeAPIInterceptor();

module.exports = {
  FreqTradeAPIInterceptor,
  apiInterceptor
};