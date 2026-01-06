/**
 * Pool Health Monitor
 * 
 * Monitors the health of pool containers and individual bots.
 * Provides auto-recovery capabilities for failed containers or bots.
 * 
 * Features:
 * - Periodic health checks for all pool containers
 * - Individual bot health monitoring within pools
 * - Automatic restart of failed bots
 * - Container failure detection and recovery
 * - Metrics collection for monitoring dashboards
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fetch = require('node-fetch');
const { getPoolManager } = require('./container-pool');

// Configuration
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000; // 30 seconds
const BOT_PING_TIMEOUT = parseInt(process.env.BOT_PING_TIMEOUT) || 5000; // 5 seconds
const MAX_RESTART_ATTEMPTS = parseInt(process.env.MAX_RESTART_ATTEMPTS) || 3;
const RESTART_COOLDOWN = parseInt(process.env.RESTART_COOLDOWN) || 60000; // 1 minute

/**
 * Health status structure
 * @typedef {Object} HealthStatus
 * @property {string} status - 'healthy' | 'degraded' | 'unhealthy'
 * @property {Date} checkedAt
 * @property {Object} details - Detailed health information
 */

class PoolHealthMonitor {
  constructor(options = {}) {
    this.poolManager = options.poolManager || getPoolManager();
    this.checkInterval = options.checkInterval || HEALTH_CHECK_INTERVAL;
    this.pingTimeout = options.pingTimeout || BOT_PING_TIMEOUT;
    this.maxRestarts = options.maxRestarts || MAX_RESTART_ATTEMPTS;
    this.restartCooldown = options.restartCooldown || RESTART_COOLDOWN;
    
    // State
    this.intervalHandle = null;
    this.running = false;
    this.healthCache = new Map(); // instanceId/poolId -> HealthStatus
    this.restartAttempts = new Map(); // instanceId -> { count, lastAttempt }
    this.listeners = new Set();
  }

  /**
   * Start the health monitor
   */
  start() {
    if (this.running) {
      console.log('[HealthMonitor] Already running');
      return;
    }
    
    console.log(`[HealthMonitor] Starting with ${this.checkInterval}ms interval`);
    this.running = true;
    
    // Run initial check
    this.runHealthCheck();
    
    // Schedule periodic checks
    this.intervalHandle = setInterval(() => {
      this.runHealthCheck();
    }, this.checkInterval);
  }

  /**
   * Stop the health monitor
   */
  stop() {
    if (!this.running) return;
    
    console.log('[HealthMonitor] Stopping');
    this.running = false;
    
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Add a health event listener
   * @param {Function} listener - Callback function(event)
   */
  addListener(listener) {
    this.listeners.add(listener);
  }

  /**
   * Remove a health event listener
   * @param {Function} listener
   */
  removeListener(listener) {
    this.listeners.delete(listener);
  }

  /**
   * Emit a health event to all listeners
   * @private
   */
  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[HealthMonitor] Listener error:', err);
      }
    }
  }

  /**
   * Run a full health check on all pools and bots
   * @param {string} [userId] - Optional userId to filter pools
   */
  async runHealthCheck(userId = null) {
    const startTime = Date.now();
    console.log(`[HealthMonitor] Running health check${userId ? ` for user ${userId}` : ''}...`);

    const results = {
      timestamp: new Date().toISOString(),
      pools: [],
      bots: [],
      issues: [],
      recoveryActions: []
    };

    const stats = this.poolManager.getPoolStats();

    // Filter pools by userId if specified
    const poolsToCheck = userId
      ? stats.pools.filter(pool => pool.userId === userId)
      : stats.pools;

    // Check each pool container
    for (const pool of poolsToCheck) {
      const poolHealth = await this._checkPoolHealth(pool);
      results.pools.push(poolHealth);

      if (poolHealth.status !== 'healthy') {
        results.issues.push({
          type: 'pool',
          id: pool.id,
          status: poolHealth.status,
          message: poolHealth.message
        });

        // Attempt recovery if possible
        if (poolHealth.recoverable) {
          const action = await this._recoverPool(pool);
          if (action) results.recoveryActions.push(action);
        }
      }
      
      // Check bots within the pool
      for (const instanceId of pool.bots) {
        const botHealth = await this._checkBotHealth(instanceId, pool);
        results.bots.push(botHealth);
        
        if (botHealth.status !== 'healthy') {
          results.issues.push({
            type: 'bot',
            id: instanceId,
            poolId: pool.id,
            status: botHealth.status,
            message: botHealth.message
          });
          
          // Attempt recovery if possible
          if (botHealth.recoverable) {
            const action = await this._recoverBot(instanceId, pool);
            if (action) results.recoveryActions.push(action);
          }
        }
      }
    }
    
    results.durationMs = Date.now() - startTime;
    
    // Emit results
    this._emit({
      type: 'health_check_complete',
      ...results
    });
    
    // Log summary
    const healthyPools = results.pools.filter(p => p.status === 'healthy').length;
    const healthyBots = results.bots.filter(b => b.status === 'healthy').length;
    console.log(
      `[HealthMonitor] Check complete in ${results.durationMs}ms: ` +
      `${healthyPools}/${results.pools.length} pools healthy, ` +
      `${healthyBots}/${results.bots.length} bots healthy, ` +
      `${results.issues.length} issues, ` +
      `${results.recoveryActions.length} recovery actions`
    );
    
    return results;
  }

  /**
   * Check health of a pool container
   * @private
   */
  async _checkPoolHealth(pool) {
    const result = {
      id: pool.id,
      containerName: pool.containerName,
      status: 'unknown',
      message: '',
      checkedAt: new Date().toISOString(),
      recoverable: false,
      details: {}
    };
    
    try {
      // Check if container is running
      const { stdout } = await execPromise(
        `docker inspect -f '{{.State.Status}}' ${pool.containerName} 2>/dev/null || echo "not_found"`
      );
      
      const containerStatus = stdout.trim();
      result.details.containerStatus = containerStatus;
      
      if (containerStatus === 'not_found' || containerStatus === '') {
        result.status = 'unhealthy';
        result.message = 'Container not found';
        result.recoverable = true;
        return result;
      }
      
      if (containerStatus !== 'running') {
        result.status = 'unhealthy';
        result.message = `Container status: ${containerStatus}`;
        result.recoverable = true;
        return result;
      }
      
      // Check supervisord is running
      try {
        const { stdout: supervisorOut } = await execPromise(
          `docker exec ${pool.containerName} supervisorctl status 2>/dev/null || echo "FAILED"`
        );
        
        if (supervisorOut.includes('FAILED') || supervisorOut.includes('error')) {
          result.status = 'degraded';
          result.message = 'Supervisor not responding';
          result.recoverable = true;
          result.details.supervisor = 'error';
        } else {
          result.details.supervisor = 'running';
        }
      } catch (err) {
        result.status = 'degraded';
        result.message = 'Supervisor check failed';
        result.details.supervisorError = err.message;
      }
      
      // Get container metrics
      try {
        const { stdout: statsOut } = await execPromise(
          `docker stats ${pool.containerName} --no-stream --format "{{.MemUsage}}|{{.CPUPerc}}|{{.NetIO}}" 2>/dev/null`
        );
        
        const parts = statsOut.trim().split('|');
        result.details.metrics = {
          memory: parts[0] || 'unknown',
          cpu: parts[1] || 'unknown',
          network: parts[2] || 'unknown'
        };
      } catch (err) {
        result.details.metricsError = err.message;
      }
      
      // If we got here with no issues, container is healthy
      if (result.status === 'unknown') {
        result.status = 'healthy';
        result.message = 'Container running normally';
      }
      
    } catch (err) {
      result.status = 'unhealthy';
      result.message = err.message;
      result.recoverable = true;
    }
    
    // Cache result
    this.healthCache.set(`pool:${pool.id}`, result);
    
    return result;
  }

  /**
   * Check health of a bot within a pool
   * @private
   */
  async _checkBotHealth(instanceId, pool) {
    const slot = this.poolManager.botMapping?.get(instanceId);
    
    const result = {
      id: instanceId,
      poolId: pool.id,
      status: 'unknown',
      message: '',
      checkedAt: new Date().toISOString(),
      recoverable: false,
      details: {}
    };
    
    if (!slot) {
      result.status = 'unhealthy';
      result.message = 'Bot slot not found';
      return result;
    }
    
    result.details.port = slot.port;
    result.details.slotStatus = slot.status;
    
    try {
      // Check supervisor process status
      const { stdout } = await execPromise(
        `docker exec ${pool.containerName} supervisorctl status bot-${instanceId} 2>/dev/null || echo "NOT_FOUND"`
      );
      
      const processStatus = stdout.trim();
      result.details.processStatus = processStatus;
      
      if (processStatus.includes('NOT_FOUND')) {
        result.status = 'unhealthy';
        result.message = 'Bot process not found in supervisor';
        result.recoverable = true;
        return result;
      }
      
      if (processStatus.includes('RUNNING')) {
        // Bot process is running in supervisor - that's healthy
        // Note: FreqTrade API requires authentication, so we check supervisor status only
        result.status = 'healthy';
        result.message = 'Bot process running in supervisor';
        result.details.supervisorStatus = 'RUNNING';
      } else if (processStatus.includes('STOPPED')) {
        result.status = 'unhealthy';
        result.message = 'Bot process stopped';
        result.recoverable = true;
      } else if (processStatus.includes('FATAL') || processStatus.includes('BACKOFF')) {
        result.status = 'unhealthy';
        result.message = `Bot process in ${processStatus} state`;
        result.recoverable = true;
      } else {
        result.status = 'degraded';
        result.message = `Unknown process status: ${processStatus}`;
      }
      
    } catch (err) {
      result.status = 'unhealthy';
      result.message = err.message;
      result.recoverable = true;
    }
    
    // Cache result
    this.healthCache.set(`bot:${instanceId}`, result);
    
    return result;
  }

  /**
   * Attempt to recover a failed pool
   * @private
   */
  async _recoverPool(pool) {
    console.log(`[HealthMonitor] Attempting to recover pool ${pool.id}`);
    
    try {
      // Check restart attempts
      const key = `pool:${pool.id}`;
      const attempts = this.restartAttempts.get(key) || { count: 0, lastAttempt: 0 };
      
      if (attempts.count >= this.maxRestarts) {
        const cooldownRemaining = (attempts.lastAttempt + this.restartCooldown) - Date.now();
        if (cooldownRemaining > 0) {
          console.log(`[HealthMonitor] Pool ${pool.id} in cooldown for ${cooldownRemaining}ms`);
          return {
            type: 'pool_recovery_skipped',
            id: pool.id,
            reason: 'max_restarts_reached',
            cooldownRemaining
          };
        }
        // Reset counter after cooldown
        attempts.count = 0;
      }
      
      // Try to restart the container
      console.log(`[HealthMonitor] Restarting pool container ${pool.containerName}`);
      await execPromise(`docker restart ${pool.containerName}`);
      
      // Update restart tracking
      attempts.count++;
      attempts.lastAttempt = Date.now();
      this.restartAttempts.set(key, attempts);
      
      // Update pool status
      pool.status = 'running';
      
      return {
        type: 'pool_recovery_attempted',
        id: pool.id,
        action: 'container_restart',
        attemptNumber: attempts.count
      };
      
    } catch (err) {
      console.error(`[HealthMonitor] Pool recovery failed for ${pool.id}: ${err.message}`);
      
      return {
        type: 'pool_recovery_failed',
        id: pool.id,
        error: err.message
      };
    }
  }

  /**
   * Attempt to recover a failed bot
   * @private
   */
  async _recoverBot(instanceId, pool) {
    console.log(`[HealthMonitor] Attempting to recover bot ${instanceId} in pool ${pool.id}`);
    
    try {
      // Check restart attempts
      const key = `bot:${instanceId}`;
      const attempts = this.restartAttempts.get(key) || { count: 0, lastAttempt: 0 };
      
      if (attempts.count >= this.maxRestarts) {
        const cooldownRemaining = (attempts.lastAttempt + this.restartCooldown) - Date.now();
        if (cooldownRemaining > 0) {
          console.log(`[HealthMonitor] Bot ${instanceId} in cooldown for ${cooldownRemaining}ms`);
          return {
            type: 'bot_recovery_skipped',
            id: instanceId,
            poolId: pool.id,
            reason: 'max_restarts_reached',
            cooldownRemaining
          };
        }
        // Reset counter after cooldown
        attempts.count = 0;
      }
      
      // Try to restart the bot process via supervisor
      console.log(`[HealthMonitor] Restarting bot ${instanceId} via supervisorctl`);
      await execPromise(
        `docker exec ${pool.containerName} supervisorctl restart bot-${instanceId}`
      );
      
      // Update restart tracking
      attempts.count++;
      attempts.lastAttempt = Date.now();
      this.restartAttempts.set(key, attempts);
      
      // Update slot status
      const slot = this.poolManager.botMapping?.get(instanceId);
      if (slot) {
        slot.status = 'running';
      }
      
      return {
        type: 'bot_recovery_attempted',
        id: instanceId,
        poolId: pool.id,
        action: 'process_restart',
        attemptNumber: attempts.count
      };
      
    } catch (err) {
      console.error(`[HealthMonitor] Bot recovery failed for ${instanceId}: ${err.message}`);
      
      return {
        type: 'bot_recovery_failed',
        id: instanceId,
        poolId: pool.id,
        error: err.message
      };
    }
  }

  /**
   * Get cached health status
   * @param {string} type - 'pool' or 'bot'
   * @param {string} id - Pool ID or instance ID
   */
  getCachedHealth(type, id) {
    return this.healthCache.get(`${type}:${id}`);
  }

  /**
   * Get overall system health summary
   */
  getHealthSummary() {
    const summary = {
      status: 'healthy',
      pools: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0
      },
      bots: {
        total: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0
      },
      lastCheck: null
    };
    
    for (const [key, health] of this.healthCache) {
      const [type] = key.split(':');
      const category = type === 'pool' ? summary.pools : summary.bots;
      
      category.total++;
      if (health.status === 'healthy') category.healthy++;
      else if (health.status === 'degraded') category.degraded++;
      else category.unhealthy++;
      
      if (!summary.lastCheck || new Date(health.checkedAt) > new Date(summary.lastCheck)) {
        summary.lastCheck = health.checkedAt;
      }
    }
    
    // Determine overall status
    if (summary.pools.unhealthy > 0 || summary.bots.unhealthy > summary.bots.total * 0.2) {
      summary.status = 'unhealthy';
    } else if (summary.pools.degraded > 0 || summary.bots.degraded > 0) {
      summary.status = 'degraded';
    }
    
    return summary;
  }
}

// Singleton instance
let monitor = null;

function getHealthMonitor(options) {
  if (!monitor) {
    monitor = new PoolHealthMonitor(options);
  }
  return monitor;
}

module.exports = {
  PoolHealthMonitor,
  getHealthMonitor,
  HEALTH_CHECK_INTERVAL,
  MAX_RESTART_ATTEMPTS
};
