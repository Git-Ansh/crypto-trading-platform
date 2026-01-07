/**
 * Strategy Manager Service
 * Handles bot fallback/restart when strategies change
 */

const StrategyWatcher = require('./strategy-watcher');

class StrategyManager {
  constructor(botOrchestrator) {
    this.watcher = new StrategyWatcher();
    this.orchestrator = botOrchestrator;
    this.subscribers = new Set(); // WebSocket connections listening for changes
    this.botsUsingStrategy = new Map(); // strategy -> [botInstanceIds]
  }

  /**
   * Start strategy watcher and bot lifecycle management
   */
  async start() {
    await this.watcher.start();

    // Listen to strategy changes and react
    this.watcher.on('strategy:removed', (ev) => this._handleStrategyRemoved(ev));
    this.watcher.on('strategy:edited', (ev) => this._handleStrategyEdited(ev));
    this.watcher.on('strategy:added', (ev) => this._handleStrategyAdded(ev));
  }

  /**
   * Stop watcher
   */
  async stop() {
    await this.watcher.stop();
    this.subscribers.clear();
    this.botsUsingStrategy.clear();
  }

  /**
   * Get all available strategies
   */
  getStrategies() {
    return this.watcher.getStrategies();
  }

  /**
   * Get default strategy
   */
  getDefaultStrategy() {
    return this.watcher.getDefaultStrategy();
  }

  /**
   * Register a bot as using a strategy
   */
  registerBotStrategy(instanceId, strategy) {
    if (!this.botsUsingStrategy.has(strategy)) {
      this.botsUsingStrategy.set(strategy, new Set());
    }
    this.botsUsingStrategy.get(strategy).add(instanceId);
  }

  /**
   * Unregister a bot
   */
  unregisterBotStrategy(instanceId, strategy) {
    if (this.botsUsingStrategy.has(strategy)) {
      this.botsUsingStrategy.get(strategy).delete(instanceId);
    }
  }

  /**
   * Add WebSocket subscriber for real-time updates
   */
  addSubscriber(ws) {
    this.subscribers.add(ws);
    // Send current strategy list on connect
    ws.send(JSON.stringify({
      type: 'strategies:list',
      strategies: this.getStrategies()
    }));
  }

  /**
   * Remove WebSocket subscriber
   */
  removeSubscriber(ws) {
    this.subscribers.delete(ws);
  }

  /**
   * Broadcast strategy change to all subscribers
   */
  _broadcastChange(event) {
    const message = JSON.stringify({
      type: 'strategies:changed',
      event
    });
    for (const ws of this.subscribers) {
      try {
        if (ws.readyState === 1) { // OPEN
          ws.send(message);
        }
      } catch (err) {
        console.error('[StrategyManager] Error broadcasting to subscriber:', err.message);
        this.removeSubscriber(ws);
      }
    }
  }

  /**
   * Handle strategy removed
   */
  async _handleStrategyRemoved(ev) {
    const { name, isDefault } = ev;
    console.log(`[StrategyManager] Strategy removed: ${name}`);

    // Get bots using this strategy - first from local cache, then from orchestrator
    let botsToFallback = this.botsUsingStrategy.get(name);
    
    // Also query orchestrator for any bots we might have missed
    if (this.orchestrator && this.orchestrator.getBotsUsingStrategy) {
      try {
        const orchestratorBots = await this.orchestrator.getBotsUsingStrategy(name);
        if (orchestratorBots && orchestratorBots.length > 0) {
          if (!botsToFallback) {
            botsToFallback = new Set(orchestratorBots);
          } else {
            orchestratorBots.forEach(id => botsToFallback.add(id));
          }
        }
      } catch (err) {
        console.error(`[StrategyManager] Failed to query orchestrator for bots:`, err.message);
      }
    }

    if (botsToFallback && botsToFallback.size > 0) {
      console.log(`[StrategyManager] Falling back ${botsToFallback.size} bots from '${name}' to default`);
      
      for (const instanceId of botsToFallback) {
        try {
          // Fallback bot to default strategy and restart
          await this._fallbackBotStrategy(instanceId, name);
        } catch (err) {
          console.error(`[StrategyManager] Failed to fallback bot ${instanceId}:`, err.message);
        }
      }
      this.botsUsingStrategy.delete(name);
    }

    // Broadcast to all connected clients
    this._broadcastChange({
      type: 'removed',
      strategy: name,
      affectedBots: botsToFallback ? Array.from(botsToFallback) : [],
      availableStrategies: this.getStrategies()
    });
  }

  /**
   * Handle strategy edited (restart bots using it)
   */
  async _handleStrategyEdited(ev) {
    const { name } = ev;
    console.log(`[StrategyManager] Strategy edited: ${name}`);

    // Get bots using this strategy - first from local cache, then from orchestrator
    let botsToRestart = this.botsUsingStrategy.get(name);
    
    // Also query orchestrator for any bots we might have missed
    if (this.orchestrator && this.orchestrator.getBotsUsingStrategy) {
      try {
        const orchestratorBots = await this.orchestrator.getBotsUsingStrategy(name);
        if (orchestratorBots && orchestratorBots.length > 0) {
          if (!botsToRestart) {
            botsToRestart = new Set(orchestratorBots);
          } else {
            orchestratorBots.forEach(id => botsToRestart.add(id));
          }
        }
      } catch (err) {
        console.error(`[StrategyManager] Failed to query orchestrator for bots:`, err.message);
      }
    }

    if (botsToRestart && botsToRestart.size > 0) {
      console.log(`[StrategyManager] Restarting ${botsToRestart.size} bots using '${name}'`);
      
      for (const instanceId of botsToRestart) {
        try {
          await this._restartBot(instanceId);
        } catch (err) {
          console.error(`[StrategyManager] Failed to restart bot ${instanceId}:`, err.message);
        }
      }
    }

    // Broadcast to all connected clients
    this._broadcastChange({
      type: 'edited',
      strategy: name,
      affectedBots: botsToRestart ? Array.from(botsToRestart) : [],
      availableStrategies: this.getStrategies()
    });
  }

  /**
   * Handle strategy added
   */
  async _handleStrategyAdded(ev) {
    const { name } = ev;
    console.log(`[StrategyManager] Strategy added: ${name}`);

    // Broadcast new strategy list to all clients
    this._broadcastChange({
      type: 'added',
      strategy: name,
      availableStrategies: this.getStrategies()
    });
  }

  /**
   * Fallback a bot to default strategy (update config and restart)
   */
  async _fallbackBotStrategy(instanceId, oldStrategy) {
    try {
      const defaultStrat = this.getDefaultStrategy();
      console.log(`[StrategyManager] Falling back bot '${instanceId}' from '${oldStrategy}' to '${defaultStrat}'`);

      if (this.orchestrator && this.orchestrator.fallbackBotStrategy) {
        await this.orchestrator.fallbackBotStrategy(instanceId, defaultStrat);
      } else {
        console.warn(`[StrategyManager] Orchestrator.fallbackBotStrategy not available`);
      }

      this.unregisterBotStrategy(instanceId, oldStrategy);
      this.registerBotStrategy(instanceId, defaultStrat);
    } catch (err) {
      console.error(`[StrategyManager] Failed to fallback ${instanceId}:`, err);
      throw err;
    }
  }

  /**
   * Restart a bot process
   */
  async _restartBot(instanceId) {
    try {
      console.log(`[StrategyManager] Restarting bot '${instanceId}'`);
      
      if (this.orchestrator && this.orchestrator.restartBot) {
        await this.orchestrator.restartBot(instanceId);
      } else {
        console.warn(`[StrategyManager] Orchestrator.restartBot not available`);
      }
    } catch (err) {
      console.error(`[StrategyManager] Failed to restart ${instanceId}:`, err);
      throw err;
    }
  }
}

module.exports = StrategyManager;
