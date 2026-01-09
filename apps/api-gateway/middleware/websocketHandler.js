/**
 * WebSocket Middleware for Strategy Updates
 * Handles real-time strategy change subscriptions
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

/**
 * Verify JWT token from WebSocket connection
 */
function verifyWebSocketToken(request) {
  try {
    // Parse URL to get query parameters
    const parsedUrl = url.parse(request.url, true);
    const token = parsedUrl.query.token;

    if (!token) {
      console.log('[WebSocket] No token provided in connection');
      return null;
    }

    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('[WebSocket] Token verified for user:', decoded.user?.id);
    return decoded;
  } catch (err) {
    console.error('[WebSocket] Token verification failed:', err.message);
    return null;
  }
}

/**
 * Upgrade HTTP server to support WebSocket
 */
function setupWebSocketServer(server, strategyManager) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/ws/strategies',
    verifyClient: (info, callback) => {
      // Verify JWT token before accepting connection
      const decoded = verifyWebSocketToken(info.req);
      if (!decoded) {
        callback(false, 401, 'Unauthorized');
      } else {
        // Attach user info to the request for later use
        info.req.user = decoded.user;
        callback(true);
      }
    }
  });

  wss.on('connection', (ws, request) => {
    console.log('[WebSocket] New authenticated client connected for strategy updates');
    console.log('[WebSocket] User:', request.user?.id);

    // Register with strategy manager
    strategyManager.addSubscriber(ws);

    // Handle incoming messages (ping, etc.)
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        console.log('[WebSocket] Received message:', data);

        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (err) {
        console.error('[WebSocket] Error parsing message:', err);
      }
    });

    // Handle client disconnect
    ws.on('close', () => {
      console.log('[WebSocket] Client disconnected');
      strategyManager.removeSubscriber(ws);
    });

    // Handle errors
    ws.on('error', (err) => {
      console.error('[WebSocket] Connection error:', err.message);
      strategyManager.removeSubscriber(ws);
    });
  });

  console.log('[WebSocket] Server initialized on path /ws/strategies with authentication');
  return wss;
}

module.exports = {
  setupWebSocketServer
};
