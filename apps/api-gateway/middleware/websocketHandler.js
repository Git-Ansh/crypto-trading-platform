/**
 * WebSocket Middleware for Strategy Updates
 * Handles real-time strategy change subscriptions
 */

const WebSocket = require('ws');

/**
 * Upgrade HTTP server to support WebSocket
 */
function setupWebSocketServer(server, strategyManager) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/ws/strategies'
  });

  wss.on('connection', (ws) => {
    console.log('[WebSocket] New client connected for strategy updates');

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

  console.log('[WebSocket] Server initialized on path /ws/strategies');
  return wss;
}

module.exports = {
  setupWebSocketServer
};
