'use strict';

/**
 * DEPRECATED: Legacy ProductionMonitor used by WebSocket layer is removed.
 */
class ProductionMonitor {
    constructor() {
        if (!ProductionMonitor._warned) {
            // eslint-disable-next-line no-console
            console.warn('[DEPRECATED] ProductionMonitor (WebSocket) has been removed.');
            ProductionMonitor._warned = true;
        }
    }
    // Minimal no-op API
    trackRequestStart() { }
    trackRequestEnd() { }
    recordError() { }
    updateBusinessMetrics() { }
    getMetricsReport() { return {}; }
}

module.exports = ProductionMonitor;
