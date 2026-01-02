'use strict';

/**
 * DEPRECATED: WebSocket subsystem has been removed in favor of SSE (/api/stream).
 * This stub remains only to avoid breaking legacy imports. Do not use.
 */
class WebSocketManager {
  constructor() {
    // Warn once on construction
    if (!WebSocketManager._warned) {
      // eslint-disable-next-line no-console
      console.warn('[DEPRECATED] WebSocketManager has been removed. Use SSE via GET /api/stream.');
      WebSocketManager._warned = true;
    }
  }
}

module.exports = WebSocketManager;
