const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const http = require('http');
const https = require('https');

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
  try {
    const url = new URL(`${BOT_MANAGER_URL}${endpoint}`);
    
    // Add query parameters if provided
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url.toString(), options);
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

// POST /api/freqtrade/provision - Provision a new bot
router.post('/provision', auth, async (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token' });
  }

  const result = await proxyRequest('POST', '/api/provision', token, req.body);
  
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(result.status).json(result.error);
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
