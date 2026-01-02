'use strict';

/**
 * DEPRECATED: UserBotService (WebSocket) is no longer used. SSE aggregator in index.js replaces this.
 */
class UserBotService {
    constructor() {
        if (!UserBotService._warned) {
            // eslint-disable-next-line no-console
            console.warn('[DEPRECATED] UserBotService (WebSocket) has been removed.');
            UserBotService._warned = true;
        }
    }
}

module.exports = UserBotService;
