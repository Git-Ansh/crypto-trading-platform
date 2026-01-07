/**
 * Strategy API Routes
 * Exposes StrategyManager via HTTP endpoints and WebSocket
 */

const express = require('express');
const router = express.Router();

/**
 * GET /api/strategies
 * Returns list of available strategies
 */
router.get('/', (req, res) => {
  try {
    const strategyManager = req.app.locals.strategyManager;
    if (!strategyManager) {
      return res.status(503).json({ error: 'Strategy manager not initialized' });
    }

    const strategies = strategyManager.getStrategies();
    const defaultStrategy = strategyManager.getDefaultStrategy();

    res.json({
      strategies,
      defaultStrategy,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[StrategyAPI] GET /api/strategies error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/strategies/:name
 * Check if a specific strategy exists
 */
router.get('/:name', (req, res) => {
  try {
    const strategyManager = req.app.locals.strategyManager;
    if (!strategyManager) {
      return res.status(503).json({ error: 'Strategy manager not initialized' });
    }

    const { name } = req.params;
    const exists = strategyManager.watcher.hasStrategy(name);

    res.json({
      strategy: name,
      exists,
      isDefault: strategyManager.getDefaultStrategy() === name,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[StrategyAPI] GET /api/strategies/:name error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/strategies/register-bot
 * Register a bot as using a specific strategy
 * Body: { instanceId, strategy }
 */
router.post('/register-bot', (req, res) => {
  try {
    const strategyManager = req.app.locals.strategyManager;
    if (!strategyManager) {
      return res.status(503).json({ error: 'Strategy manager not initialized' });
    }

    const { instanceId, strategy } = req.body;
    if (!instanceId || !strategy) {
      return res.status(400).json({ error: 'instanceId and strategy required' });
    }

    strategyManager.registerBotStrategy(instanceId, strategy);
    res.json({
      success: true,
      instanceId,
      strategy,
      message: `Registered bot '${instanceId}' with strategy '${strategy}'`
    });
  } catch (err) {
    console.error('[StrategyAPI] POST /api/strategies/register-bot error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/strategies/unregister-bot
 * Unregister a bot
 * Body: { instanceId, strategy }
 */
router.post('/unregister-bot', (req, res) => {
  try {
    const strategyManager = req.app.locals.strategyManager;
    if (!strategyManager) {
      return res.status(503).json({ error: 'Strategy manager not initialized' });
    }

    const { instanceId, strategy } = req.body;
    if (!instanceId || !strategy) {
      return res.status(400).json({ error: 'instanceId and strategy required' });
    }

    strategyManager.unregisterBotStrategy(instanceId, strategy);
    res.json({
      success: true,
      instanceId,
      strategy,
      message: `Unregistered bot '${instanceId}' from strategy '${strategy}'`
    });
  } catch (err) {
    console.error('[StrategyAPI] POST /api/strategies/unregister-bot error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
