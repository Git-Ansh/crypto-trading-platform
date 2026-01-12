#!/usr/bin/env node
const path = require('path');

(async () => {
  try {
    const {
      initPoolSystem,
      shutdownPoolSystem,
      getPoolComponents
    } = require(path.resolve(__dirname, '../apps/bot-orchestrator/lib/pool-integration'));

    console.log('[NormalizeState] Initializing pool system...');
    await initPoolSystem({ enableHealthMonitor: false });

    const { poolManager } = getPoolComponents();
    if (!poolManager) {
      throw new Error('Pool manager not available after init');
    }

    console.log('[NormalizeState] Loading state, then re-saving with normalized paths...');
    await poolManager._loadState();
    await poolManager._saveState();

    const stats = poolManager.getPoolStats ? poolManager.getPoolStats() : {};
    console.log('[NormalizeState] Done. Current pools:', stats.totalPools || poolManager.pools.size);

    await shutdownPoolSystem();
    console.log('[NormalizeState] ✓ Completed');
  } catch (err) {
    console.error('[NormalizeState] Failed:', err);
    process.exitCode = 1;
  }
})();
