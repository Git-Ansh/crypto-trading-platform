/**
 * Performance Optimization Module
 * 
 * Provides caching, connection pooling, and performance optimizations for:
 * - Bot data caching (portfolio, trades, balance)
 * - Price data caching
 * - Database connection pooling
 * - Rate limiting for external API calls
 */

const fs = require('fs-extra');
const path = require('path');

// =============================================================================
// IN-MEMORY CACHE
// =============================================================================

class PerformanceCache {
  constructor() {
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0
    };
    
    // Default TTLs in milliseconds
    this.defaultTTLs = {
      botStatus: 30000,      // 30 seconds
      botBalance: 30000,     // 30 seconds
      botTrades: 15000,      // 15 seconds
      portfolio: 30000,      // 30 seconds
      price: 10000,          // 10 seconds
      settings: 60000,       // 1 minute
      indicators: 60000,     // 1 minute
      volatility: 300000     // 5 minutes
    };
    
    // Maximum cache entries per type
    this.maxEntries = {
      botStatus: 100,
      botBalance: 100,
      botTrades: 100,
      portfolio: 50,
      price: 500,
      settings: 200,
      indicators: 200,
      volatility: 100
    };
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Generate cache key
   */
  key(type, ...parts) {
    return `${type}:${parts.join(':')}`;
  }

  /**
   * Get value from cache
   */
  get(type, ...keyParts) {
    const key = this.key(type, ...keyParts);
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    
    this.stats.hits++;
    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(type, value, ...keyParts) {
    const key = this.key(type, ...keyParts);
    const ttl = this.defaultTTLs[type] || 30000;
    
    // Check if we need to evict entries
    this.evictIfNeeded(type);
    
    this.cache.set(key, {
      value,
      type,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl
    });
    
    this.stats.sets++;
    return value;
  }

  /**
   * Set with custom TTL
   */
  setWithTTL(type, value, ttl, ...keyParts) {
    const key = this.key(type, ...keyParts);
    
    this.evictIfNeeded(type);
    
    this.cache.set(key, {
      value,
      type,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl
    });
    
    this.stats.sets++;
    return value;
  }

  /**
   * Delete from cache
   */
  delete(type, ...keyParts) {
    const key = this.key(type, ...keyParts);
    return this.cache.delete(key);
  }

  /**
   * Clear cache by type or entirely
   */
  clear(type = null) {
    if (type) {
      const prefix = `${type}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  /**
   * Evict oldest entries if over limit
   */
  evictIfNeeded(type) {
    const maxEntries = this.maxEntries[type] || 100;
    const prefix = `${type}:`;
    
    // Count entries of this type
    let count = 0;
    const entries = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        count++;
        entries.push({ key, createdAt: entry.createdAt });
      }
    }
    
    // Evict oldest if over limit
    if (count >= maxEntries) {
      entries.sort((a, b) => a.createdAt - b.createdAt);
      const toEvict = entries.slice(0, Math.floor(maxEntries * 0.2)); // Evict 20%
      
      for (const { key } of toEvict) {
        this.cache.delete(key);
        this.stats.evictions++;
      }
    }
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[Cache] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;
    
    // Count by type
    const byType = {};
    for (const [key, entry] of this.cache.entries()) {
      const type = entry.type;
      byType[type] = (byType[type] || 0) + 1;
    }
    
    return {
      totalEntries: this.cache.size,
      byType,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: `${hitRate}%`,
      sets: this.stats.sets,
      evictions: this.stats.evictions
    };
  }

  /**
   * Stop cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// =============================================================================
// REQUEST RATE LIMITER (for external APIs)
// =============================================================================

class RateLimiter {
  constructor() {
    this.limits = new Map();
    this.requests = new Map();
    
    // Default limits per minute
    this.defaultLimits = {
      freqtrade: 60,      // 60 requests per minute per bot
      coingecko: 30,      // 30 requests per minute
      coinpaprika: 50,    // 50 requests per minute
      default: 100        // 100 requests per minute
    };
    
    // Cleanup old request records
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if request is allowed
   */
  isAllowed(type, identifier = 'default') {
    const key = `${type}:${identifier}`;
    const limit = this.limits.get(key) || this.defaultLimits[type] || this.defaultLimits.default;
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window
    
    // Get or create request array
    let requests = this.requests.get(key) || [];
    
    // Filter to only recent requests
    requests = requests.filter(ts => ts > windowStart);
    
    // Check if under limit
    if (requests.length >= limit) {
      return false;
    }
    
    // Record this request
    requests.push(now);
    this.requests.set(key, requests);
    
    return true;
  }

  /**
   * Wait for rate limit to clear
   */
  async waitForSlot(type, identifier = 'default', maxWaitMs = 5000) {
    const startTime = Date.now();
    
    while (!this.isAllowed(type, identifier)) {
      if (Date.now() - startTime > maxWaitMs) {
        throw new Error(`Rate limit timeout for ${type}:${identifier}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return true;
  }

  /**
   * Set custom limit
   */
  setLimit(type, identifier, limit) {
    const key = `${type}:${identifier}`;
    this.limits.set(key, limit);
  }

  /**
   * Cleanup old records
   */
  cleanup() {
    const now = Date.now();
    const windowStart = now - 60000;
    
    for (const [key, requests] of this.requests.entries()) {
      const filtered = requests.filter(ts => ts > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, filtered);
      }
    }
  }

  /**
   * Get rate limit stats
   */
  getStats() {
    const stats = {};
    const now = Date.now();
    const windowStart = now - 60000;
    
    for (const [key, requests] of this.requests.entries()) {
      const recent = requests.filter(ts => ts > windowStart);
      stats[key] = {
        requestsInWindow: recent.length,
        limit: this.limits.get(key) || this.defaultLimits.default
      };
    }
    
    return stats;
  }
}

// =============================================================================
// BATCH PROCESSOR
// =============================================================================

class BatchProcessor {
  constructor() {
    this.batches = new Map();
    this.processing = new Map();
  }

  /**
   * Add item to batch and return promise for result
   */
  async add(batchKey, item, processorFn, options = {}) {
    const { 
      maxBatchSize = 10, 
      maxWaitMs = 100,
      timeout = 30000 
    } = options;
    
    return new Promise((resolve, reject) => {
      if (!this.batches.has(batchKey)) {
        this.batches.set(batchKey, {
          items: [],
          promises: [],
          timer: null
        });
      }
      
      const batch = this.batches.get(batchKey);
      const index = batch.items.length;
      
      batch.items.push(item);
      batch.promises.push({ resolve, reject, index });
      
      // Start timer if this is the first item
      if (batch.items.length === 1) {
        batch.timer = setTimeout(() => {
          this.processBatch(batchKey, processorFn);
        }, maxWaitMs);
      }
      
      // Process immediately if batch is full
      if (batch.items.length >= maxBatchSize) {
        clearTimeout(batch.timer);
        this.processBatch(batchKey, processorFn);
      }
      
      // Timeout handling
      setTimeout(() => {
        reject(new Error(`Batch timeout for ${batchKey}`));
      }, timeout);
    });
  }

  /**
   * Process a batch
   */
  async processBatch(batchKey, processorFn) {
    const batch = this.batches.get(batchKey);
    if (!batch || batch.items.length === 0) return;
    
    // Clear the batch immediately
    const { items, promises } = batch;
    this.batches.delete(batchKey);
    
    try {
      // Process all items
      const results = await processorFn(items);
      
      // Resolve individual promises
      for (let i = 0; i < promises.length; i++) {
        const { resolve, index } = promises[i];
        resolve(results[index]);
      }
    } catch (error) {
      // Reject all promises
      for (const { reject } of promises) {
        reject(error);
      }
    }
  }
}

// =============================================================================
// INDICATOR PRECOMPUTATION
// =============================================================================

class IndicatorCache {
  constructor() {
    this.cache = new PerformanceCache();
    this.computeQueue = new Map();
  }

  /**
   * Get or compute indicator
   */
  async getIndicator(pair, indicatorType, params, computeFn) {
    const key = `${pair}:${indicatorType}:${JSON.stringify(params)}`;
    
    // Check cache
    const cached = this.cache.get('indicators', key);
    if (cached) return cached;
    
    // Check if already computing
    if (this.computeQueue.has(key)) {
      return this.computeQueue.get(key);
    }
    
    // Compute
    const promise = computeFn(pair, params).then(result => {
      this.cache.set('indicators', result, key);
      this.computeQueue.delete(key);
      return result;
    }).catch(error => {
      this.computeQueue.delete(key);
      throw error;
    });
    
    this.computeQueue.set(key, promise);
    return promise;
  }

  /**
   * Precompute indicators for a pair
   */
  async precompute(pair, indicators) {
    const results = {};
    
    for (const { type, params, computeFn } of indicators) {
      try {
        results[type] = await this.getIndicator(pair, type, params, computeFn);
      } catch (error) {
        console.error(`[Indicators] Failed to compute ${type} for ${pair}:`, error.message);
      }
    }
    
    return results;
  }
}

// =============================================================================
// SINGLETON INSTANCES
// =============================================================================

const cache = new PerformanceCache();
const rateLimiter = new RateLimiter();
const batchProcessor = new BatchProcessor();
const indicatorCache = new IndicatorCache();

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Cached fetch wrapper
 */
async function cachedFetch(cacheType, url, options = {}, ...keyParts) {
  // Check cache first
  const cached = cache.get(cacheType, url, ...keyParts);
  if (cached) return cached;
  
  // Wait for rate limit
  await rateLimiter.waitForSlot('fetch', 'general');
  
  // Fetch
  const fetch = require('node-fetch');
  const response = await fetch(url, { timeout: 10000, ...options });
  const data = await response.json();
  
  // Cache result
  cache.set(cacheType, data, url, ...keyParts);
  
  return data;
}

/**
 * Cached bot API call
 */
async function cachedBotCall(instanceId, endpoint, port, cacheType = 'botStatus') {
  const cached = cache.get(cacheType, instanceId, endpoint);
  if (cached) return cached;
  
  // Wait for rate limit
  const allowed = await rateLimiter.waitForSlot('freqtrade', instanceId, 2000);
  if (!allowed) {
    throw new Error(`Rate limit exceeded for bot ${instanceId}`);
  }
  
  const fetch = require('node-fetch');
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    timeout: 5000
  });
  
  if (!response.ok) {
    throw new Error(`Bot API error: ${response.status}`);
  }
  
  const data = await response.json();
  cache.set(cacheType, data, instanceId, endpoint);
  
  return data;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  cache,
  rateLimiter,
  batchProcessor,
  indicatorCache,
  PerformanceCache,
  RateLimiter,
  BatchProcessor,
  IndicatorCache,
  cachedFetch,
  cachedBotCall
};
