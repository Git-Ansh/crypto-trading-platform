'use strict';

/**
 * DEPRECATED: Legacy SecurityManager (WebSocket) is removed.
 */
class SecurityManager {
    constructor() {
        if (!SecurityManager._warned) {
            // eslint-disable-next-line no-console
            console.warn('[DEPRECATED] SecurityManager (WebSocket) has been removed.');
            SecurityManager._warned = true;
        }
    }
    // Minimal no-op API
    checkConnectionLimit() { return { allowed: true }; }
    recordConnection() { }
    checkMessageRate() { return { allowed: true }; }
    validateMessage() { return { valid: true }; }
    recordMessage() { }
    getSecurityStats() { return {}; }
}

module.exports = SecurityManager;
