const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const http = require('http');
const https = require('https');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 15000 });

// Detect environment and set bot manager URL accordingly
// In production (Vercel), we need to use the external URL since we can't reach localhost
// In development, we use the local bot-manager instance
const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
const BOT_MANAGER_URL = process.env.BOT_MANAGER_URL || 
  (isProduction ? 'https://freqtrade.crypto-pilot.dev' : 'http://127.0.0.1:5000');

console.log(`[FreqTrade Proxy] Environment: ${isProduction ? 'production' : 'development'}`);
console.log(`[FreqTrade Proxy] Bot Manager URL: ${BOT_MANAGER_URL}`);

/**
 * Proxy endpoints to FreqTrade Bot Manager
 * These endpoints proxy requests from the frontend through the main server
 * to avoid CORS issues when calling bot-manager directly
 */

// Helper to extract token from Authorization header or query params
function getTokenFromRequest(req) {
  // First try Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  // Fallback to query param (for SSE/EventSource which can't send headers)
  if (req.query && req.query.token) {
    return req.query.token;
  }
  return null;
}

// Helper to make proxied requests to bot manager using fetch
async function proxyRequest(method, endpoint, token, data = null, queryParams = {}) {
  let timeoutId;
  try {
    const url = new URL(`${BOT_MANAGER_URL}${endpoint}`);
    
    // Add query parameters if provided
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    const agent = url.protocol === 'https:' ? httpsAgent : httpAgent;
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 15000);

    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      agent,
      signal: controller.signal,
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url.toString(), options);
    clearTimeout(timeoutId);
    const responseData = await response.json();
    
    return { 
      success: response.ok, 
      data: responseData, 
      status: response.status 
    };
  } catch (error) {
    console.error(`Proxy request failed for ${method} ${endpoint}:`, error.message);
    return {
      success: false,
      status: 500,
      error: error.message
    };
  } finally {
    // Ensure timers are cleared even if fetch throws
    if (typeof timeoutId !== 'undefined') {
      clearTimeout(timeoutId);
    }
  }
}

// GET /api/freqtrade/strategies - Get available strategies
router.get('/strategies', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/strategies', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/bots/:instanceId/strategy - Get bot strategy
router.get('/bots/:instanceId/strategy', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/bots/${instanceId}/strategy`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// PUT /api/freqtrade/bots/:instanceId/strategy - Update bot strategy
router.put('/bots/:instanceId/strategy', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('PUT', `/api/bots/${instanceId}/strategy`, token, req.body);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/health - Health check
router.get('/health', async (req, res) => {
  const token = getTokenFromRequest(req);
  
  const result = await proxyRequest('GET', '/api/health', token || '');
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/portfolio - Get portfolio data
router.get('/portfolio', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/portfolio', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/bots - Get all bots
router.get('/bots', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/bots', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/bots/:instanceId - Get specific bot
router.get('/bots/:instanceId', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/bots/${instanceId}`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/charts/portfolio - Get all chart data
router.get('/charts/portfolio', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/charts/portfolio', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/trade-monitor/status - Lightweight status used by frontend
// We don't have a dedicated trade-monitor endpoint in bot-orchestrator, so we synthesize
// status from the bots list to keep the UI happy.
router.get('/trade-monitor/status', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const botsResult = await proxyRequest('GET', '/api/bots', token);

  if (!botsResult.success) {
    return res.status(botsResult.status).json({ success: false, message: 'Failed to fetch bots' });
  }

  const bots = botsResult.data?.bots || [];
  return res.json({
    success: true,
    data: {
      running: true,
      botCount: bots.length
    }
  });
});

// GET /api/freqtrade/charts/portfolio/:interval - Get chart data for specific interval
router.get('/charts/portfolio/:interval', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { interval } = req.params;
  const result = await proxyRequest('GET', `/api/charts/portfolio/${interval}`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/portfolio/history - Get portfolio history
router.get('/portfolio/history', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/portfolio/history', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/portfolio/positions - Get portfolio positions
router.get('/portfolio/positions', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/portfolio/positions', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/bots/:instanceId/status - Get bot status
router.get('/bots/:instanceId/status', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/bots/${instanceId}/status`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/bots/:instanceId/balance - Get bot balance
router.get('/bots/:instanceId/balance', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/bots/${instanceId}/balance`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/bots/:instanceId/profit - Get bot profit
router.get('/bots/:instanceId/profit', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/bots/${instanceId}/profit`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

const User = require('../models/user');

// POST /api/freqtrade/provision - Provision a new bot with wallet allocation
router.post('/provision', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  try {
    const { 
      instanceId, 
      initialBalance, 
      strategy,
      tradingPairs,
      stake_amount,
      max_open_trades,
      timeframe,
      exchange,
      stake_currency
    } = req.body;
    const userId = req.user.id;
    
    // Validate initialBalance is provided and positive
    const allocation = Number(initialBalance);
    if (!Number.isFinite(allocation) || allocation <= 0) {
      return res.status(400).json({
        success: false,
        message: 'initialBalance is required and must be greater than 0',
      });
    }
    
    // Get user and check wallet balance
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const currentBalance = user.paperWallet?.balance || 0;
    
    // Check sufficient funds
    if (allocation > currentBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient funds. Available: $${currentBalance.toFixed(2)}, Requested: $${allocation.toFixed(2)}`,
        availableBalance: currentBalance,
        requestedAmount: allocation,
      });
    }

    // Check if bot already has allocation (use instanceId or generate one)
    const botId = instanceId || `bot_${Date.now()}`;
    if (user.botAllocations && user.botAllocations.has(botId)) {
      // Check if the bot actually exists in the orchestrator
      console.log(`[Provision] Bot ${botId} has allocation, checking if it actually exists...`);

      try {
        const botsResult = await proxyRequest('GET', '/api/bots', token);

        if (!botsResult.success) {
          console.error(`[Provision] Failed to get bot list:`, botsResult.error);
          // Can't verify - clean up the allocation anyway since we're trying to provision
          // This handles the case where the bot doesn't exist but we can't verify
          console.log(`[Provision] Cannot verify bot existence, cleaning up allocation to allow provisioning...`);

          const allocation = user.botAllocations.get(botId);
          const returnAmount = allocation.currentValue || allocation.allocatedAmount || 0;
          const pnl = (allocation.currentValue || 0) - (allocation.allocatedAmount || 0);
          const now = new Date();

          // Return funds to wallet
          const newBalance = (user.paperWallet?.balance || 0) + returnAmount;
          user.paperWallet = {
            balance: newBalance,
            currency: user.paperWallet?.currency || 'USD',
            lastUpdated: now,
          };

          // Remove allocation
          user.botAllocations.delete(botId);

          // Add transaction
          user.walletTransactions.push({
            type: 'deallocate',
            amount: returnAmount,
            botId,
            botName: allocation.botName || botId,
            description: `Auto-cleanup: returned $${returnAmount.toFixed(2)} from unverified bot (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
            balanceAfter: newBalance,
            timestamp: now,
          });

          await user.save();
          console.log(`[Provision] Cleaned up allocation (unverified), returned $${returnAmount}, new balance: $${newBalance}`);

          // Continue with provisioning
        } else {
          const runningBots = botsResult.data.map(b => b.instanceId);
          const botExists = runningBots.includes(botId);

          if (!botExists) {
            // Orphaned allocation - clean it up automatically
            console.log(`[Provision] Bot ${botId} doesn't exist, cleaning up orphaned allocation...`);

            const allocation = user.botAllocations.get(botId);
            const returnAmount = allocation.currentValue || allocation.allocatedAmount || 0;
            const pnl = (allocation.currentValue || 0) - (allocation.allocatedAmount || 0);
            const now = new Date();

            // Return funds to wallet
            const newBalance = (user.paperWallet?.balance || 0) + returnAmount;
            user.paperWallet = {
              balance: newBalance,
              currency: user.paperWallet?.currency || 'USD',
              lastUpdated: now,
            };

            // Remove allocation
            user.botAllocations.delete(botId);

            // Add transaction
            user.walletTransactions.push({
              type: 'deallocate',
              amount: returnAmount,
              botId,
              botName: allocation.botName || botId,
              description: `Auto-cleanup: returned $${returnAmount.toFixed(2)} from orphaned bot (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
              balanceAfter: newBalance,
              timestamp: now,
            });

            await user.save();
            console.log(`[Provision] Cleaned up orphaned allocation, returned $${returnAmount}, new balance: $${newBalance}`);

            // Continue with provisioning (allocation is now cleared)
          } else {
            // Bot actually exists - this is a real duplicate
            return res.status(400).json({
              success: false,
              message: 'Bot already has funds allocated and is currently running.',
            });
          }
        }
      } catch (err) {
        console.error(`[Provision] Error checking bot existence:`, err);
        // Clean up the allocation anyway - better to allow provisioning than block it
        console.log(`[Provision] Exception during verification, cleaning up allocation to allow provisioning...`);

        const allocation = user.botAllocations.get(botId);
        const returnAmount = allocation.currentValue || allocation.allocatedAmount || 0;
        const pnl = (allocation.currentValue || 0) - (allocation.allocatedAmount || 0);
        const now = new Date();

        // Return funds to wallet
        const newBalance = (user.paperWallet?.balance || 0) + returnAmount;
        user.paperWallet = {
          balance: newBalance,
          currency: user.paperWallet?.currency || 'USD',
          lastUpdated: now,
        };

        // Remove allocation
        user.botAllocations.delete(botId);

        // Add transaction
        user.walletTransactions.push({
          type: 'deallocate',
          amount: returnAmount,
          botId,
          botName: allocation.botName || botId,
          description: `Auto-cleanup: returned $${returnAmount.toFixed(2)} from unverified bot (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
          balanceAfter: newBalance,
          timestamp: now,
        });

        await user.save();
        console.log(`[Provision] Cleaned up allocation (exception), returned $${returnAmount}, new balance: $${newBalance}`);

        // Continue with provisioning
      }
    }

    // Provision the bot first - pass all config options to bot-orchestrator
    const provisionResult = await proxyRequest('POST', '/api/provision-enhanced', token, {
      instanceId: botId,
      initialBalance: allocation,
      strategy,
      tradingPairs,
      stake_amount,
      max_open_trades,
      timeframe,
      exchange,
      stake_currency,
    });
    
    if (!provisionResult.success) {
      return res.status(provisionResult.status).json(provisionResult.data || provisionResult.error);
    }

    // If provisioning successful, allocate funds from wallet
    const now = new Date();
    const newBalance = currentBalance - allocation;

    // Update wallet balance
    user.paperWallet = {
      balance: newBalance,
      currency: user.paperWallet?.currency || 'USD',
      lastUpdated: now,
    };

    // Create bot allocation with pool tracking
    if (!user.botAllocations) {
      user.botAllocations = new Map();
    }
    const botName = strategy || 'Bot';
    user.botAllocations.set(botId, {
      allocatedAmount: allocation,
      currentValue: allocation,
      reservedInTrades: 0,
      availableBalance: allocation,
      lifetimePnL: 0,
      allocatedAt: now,
      botName: `${botName} (${botId})`,
    });

    // Add transaction record
    user.walletTransactions.push({
      type: 'allocate',
      amount: allocation,
      botId,
      botName: `${botName} (${botId})`,
      description: `Allocated $${allocation.toFixed(2)} to new bot: ${botId}`,
      balanceAfter: newBalance,
      timestamp: now,
    });

    await user.save();

    // Return combined response
    res.json({
      ...provisionResult.data,
      wallet: {
        previousBalance: currentBalance,
        newBalance,
        allocated: initialBalance,
      },
    });
  } catch (error) {
    console.error('Provision with wallet error:', error);
    res.status(500).json({ success: false, message: 'Server error during provisioning' });
  }
});

// DELETE /api/freqtrade/bots/:instanceId - Delete bot and return funds to wallet
router.delete('/bots/:instanceId', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  try {
    const { instanceId } = req.params;
    const userId = req.user.id;

    console.log(`[Delete Bot] Starting deletion for ${instanceId}, user ${userId}`);

    // Get user and check if bot has allocation
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const allocation = user.botAllocations?.get(instanceId);
    console.log(`[Delete Bot] Bot allocation found:`, allocation ? 'Yes' : 'No');

    // Try to delete the bot from bot-orchestrator
    let orchestratorDeleted = false;
    let orchestratorError = null;

    try {
      const deleteResult = await proxyRequest('DELETE', `/api/bots/${instanceId}`, token);
      orchestratorDeleted = deleteResult.success;

      if (!deleteResult.success && deleteResult.status !== 404) {
        orchestratorError = deleteResult.data?.message || 'Unknown error';
        console.warn(`[Delete Bot] Orchestrator deletion failed: ${orchestratorError}`);
      } else {
        console.log(`[Delete Bot] Orchestrator deletion: ${deleteResult.success ? 'Success' : 'Bot not found (404)'}`);
      }
    } catch (err) {
      orchestratorError = err.message;
      console.error(`[Delete Bot] Orchestrator deletion error:`, err);
    }

    // ALWAYS clean up wallet allocation, even if orchestrator deletion failed
    // This ensures database stays in sync with reality
    let walletUpdate = null;
    if (allocation) {
      const now = new Date();
      const returnAmount = allocation.currentValue || allocation.allocatedAmount;
      const currentBalance = user.paperWallet?.balance || 0;
      const newBalance = currentBalance + returnAmount;
      const pnl = returnAmount - allocation.allocatedAmount;

      console.log(`[Delete Bot] Cleaning up wallet: returning ${returnAmount}, P&L: ${pnl}`);

      // Update wallet balance
      user.paperWallet = {
        balance: newBalance,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: now,
      };

      // Remove bot allocation
      user.botAllocations.delete(instanceId);

      // Add transaction record
      user.walletTransactions.push({
        type: 'deallocate',
        amount: returnAmount,
        botId: instanceId,
        botName: allocation.botName || instanceId,
        description: `Returned $${returnAmount.toFixed(2)} from deleted bot (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
        balanceAfter: newBalance,
        timestamp: now,
      });

      await user.save();
      console.log(`[Delete Bot] Wallet cleaned up successfully, new balance: ${newBalance}`);

      walletUpdate = {
        previousBalance: currentBalance,
        newBalance,
        returned: returnAmount,
        pnl,
      };
    } else {
      console.log(`[Delete Bot] No allocation found for ${instanceId}`);
    }

    // Return success with warnings if orchestrator failed but wallet was cleaned
    const warnings = [];
    if (orchestratorError) {
      warnings.push(`Container cleanup may have failed: ${orchestratorError}`);
    }

    res.json({
      success: true,
      message: `Bot ${instanceId} deleted successfully`,
      wallet: walletUpdate,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (error) {
    console.error('Delete bot with wallet error:', error);
    res.status(500).json({ success: false, message: 'Server error during bot deletion' });
  }
});

// POST /api/freqtrade/sync-wallet - Sync wallet allocations with actual running bots
router.post('/sync-wallet', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  try {
    const userId = req.user.id;
    console.log(`[Sync Wallet] Starting sync for user ${userId}`);

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Get list of actual running bots from orchestrator
    const botsResult = await proxyRequest('GET', '/api/bots', token);
    if (!botsResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch bot list from orchestrator'
      });
    }

    const runningBots = new Set(botsResult.data.map(bot => bot.instanceId));
    console.log(`[Sync Wallet] Found ${runningBots.size} running bots:`, Array.from(runningBots));

    // Check for orphaned allocations
    const orphanedAllocations = [];
    const validAllocations = [];

    if (user.botAllocations) {
      for (const [botId, allocation] of user.botAllocations.entries()) {
        if (!runningBots.has(botId)) {
          orphanedAllocations.push({ botId, allocation });
        } else {
          validAllocations.push(botId);
        }
      }
    }

    console.log(`[Sync Wallet] Found ${orphanedAllocations.length} orphaned allocations`);

    // Clean up orphaned allocations
    let totalReturned = 0;
    const cleanedBots = [];

    if (orphanedAllocations.length > 0) {
      const now = new Date();
      let currentBalance = user.paperWallet?.balance || 0;

      for (const { botId, allocation } of orphanedAllocations) {
        const returnAmount = allocation.currentValue || allocation.allocatedAmount || 0;
        const pnl = (allocation.currentValue || 0) - (allocation.allocatedAmount || 0);

        console.log(`[Sync Wallet] Cleaning up ${botId}: returning ${returnAmount}`);

        currentBalance += returnAmount;
        totalReturned += returnAmount;

        // Remove allocation
        user.botAllocations.delete(botId);

        // Add transaction
        user.walletTransactions.push({
          type: 'deallocate',
          amount: returnAmount,
          botId,
          botName: allocation.botName || botId,
          description: `Auto-cleanup: returned $${returnAmount.toFixed(2)} from orphaned bot (P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`,
          balanceAfter: currentBalance,
          timestamp: now,
        });

        cleanedBots.push({
          botId,
          botName: allocation.botName || botId,
          returned: returnAmount,
          pnl,
        });
      }

      // Update wallet
      user.paperWallet = {
        balance: currentBalance,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: now,
      };

      await user.save();
      console.log(`[Sync Wallet] Cleaned up ${cleanedBots.length} orphaned allocations, returned ${totalReturned}`);
    }

    res.json({
      success: true,
      message: orphanedAllocations.length > 0
        ? `Cleaned up ${orphanedAllocations.length} orphaned bot allocation(s)`
        : 'Wallet is in sync with running bots',
      data: {
        runningBots: Array.from(runningBots),
        validAllocations,
        cleanedBots,
        totalReturned,
        newWalletBalance: user.paperWallet?.balance,
      },
    });
  } catch (error) {
    console.error('[Sync Wallet] Error:', error);
    res.status(500).json({ success: false, message: 'Server error during wallet sync' });
  }
});

// GET /api/freqtrade/health - Health check
router.get('/health', async (req, res) => {
  const result = await proxyRequest('GET', '/health', null);

  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/universal-settings - Get universal settings for all bots
router.get('/universal-settings', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/universal-settings', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/universal-settings/:instanceId - Get universal settings for specific bot
router.get('/universal-settings/:instanceId', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/universal-settings/${instanceId}`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// PUT /api/freqtrade/universal-settings/:instanceId - Update universal settings for specific bot
router.put('/universal-settings/:instanceId', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('PUT', `/api/universal-settings/${instanceId}`, token, req.body);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/universal-features/:instanceId - Get universal features for specific bot
router.get('/universal-features/:instanceId', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/universal-features/${instanceId}`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// PUT /api/freqtrade/universal-features/:instanceId - Update universal features for specific bot
router.put('/universal-features/:instanceId', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('PUT', `/api/universal-features/${instanceId}`, token, req.body);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/universal-features-defaults - Get default universal features
router.get('/universal-features-defaults', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('GET', '/api/universal-features-defaults', token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// POST /api/freqtrade/universal-features/:instanceId/reset - Reset universal features to defaults
router.post('/universal-features/:instanceId/reset', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('POST', `/api/universal-features/${instanceId}/reset`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// POST /api/freqtrade/universal-features/:instanceId/resume - Resume trading after emergency pause
router.post('/universal-features/:instanceId/resume', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('POST', `/api/universal-features/${instanceId}/resume`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// POST /api/freqtrade/universal-settings/:instanceId/reset - Reset universal settings to defaults
router.post('/universal-settings/:instanceId/reset', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('POST', `/api/universal-settings/${instanceId}/reset`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/proxy/:instanceId/api/v1/performance - Get bot performance
router.get('/proxy/:instanceId/api/v1/performance', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/proxy/${instanceId}/api/v1/performance`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/proxy/:instanceId/api/v1/profit - Get bot profit stats
router.get('/proxy/:instanceId/api/v1/profit', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/proxy/${instanceId}/api/v1/profit`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/proxy/:instanceId/api/v1/balance - Get bot balance
router.get('/proxy/:instanceId/api/v1/balance', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/proxy/${instanceId}/api/v1/balance`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// GET /api/freqtrade/proxy/:instanceId/api/v1/status - Get bot status
router.get('/proxy/:instanceId/api/v1/status', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  const result = await proxyRequest('GET', `/api/proxy/${instanceId}/api/v1/status`, token);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
  }
});

// Catch-all proxy route for any FreqTrade API endpoint
// This handles any /api/freqtrade/proxy/:instanceId/* requests not explicitly defined above
router.all('/proxy/:instanceId/*', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const { instanceId } = req.params;
  // Extract the path after /proxy/:instanceId/
  const apiPath = req.params[0]; // Everything after the wildcard
  const fullPath = `/api/proxy/${instanceId}/${apiPath}`;
  
  console.log(`[FreqTrade Proxy] Catch-all: ${req.method} ${fullPath}`);
  
  const result = await proxyRequest(req.method, fullPath, token, req.body);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error || result.data);
  }
});

// SSE Stream proxy - /api/freqtrade/stream
// This proxies the Server-Sent Events stream from bot-manager to the client
// to avoid CORS issues with direct EventSource connections
// NOTE: No auth middleware - EventSource can't send Authorization headers
// Token is passed as query param and validated by bot-manager
router.get('/stream', (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token provided' });
  }

  console.log(`[SSE Proxy] Token received, connecting to bot-manager...`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const botManagerStreamUrl = `${BOT_MANAGER_URL}/api/stream?token=${encodeURIComponent(token)}`;

  console.log(`[SSE Proxy] Connecting to: ${botManagerStreamUrl}`);

  // Use the appropriate protocol (http or https)
  const protocol = botManagerStreamUrl.startsWith('https') ? https : http;

  let req_to_bot_manager = null;

  try {
    req_to_bot_manager = protocol.get(botManagerStreamUrl, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    req_to_bot_manager.on('response', (response) => {
      console.log(`[SSE Proxy] Bot manager responded with status: ${response.statusCode}`);

      // If bot-manager returns error, respond with error
      if (response.statusCode !== 200) {
        res.status(response.statusCode).json({
          success: false,
          message: `Bot manager returned ${response.statusCode}`,
          error: response.statusMessage
        });
        return;
      }

      // Pipe the response data through to the client
      response.pipe(res);
    });

    req_to_bot_manager.on('error', (error) => {
      console.error('[SSE Proxy] Error connecting to bot manager:', error.message);
      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: 'Failed to connect to bot manager',
          error: error.message
        });
      }
    });

    // Handle client disconnect
    req.on('close', () => {
      console.log('[SSE Proxy] Client disconnected');
      if (req_to_bot_manager) {
        req_to_bot_manager.abort();
      }
    });

  } catch (error) {
    console.error('[SSE Proxy] Failed to create bot manager request:', error);
    res.status(502).json({
      success: false,
      message: 'Failed to create bot manager connection',
      error: error.message
    });
  }
});

module.exports = router;
