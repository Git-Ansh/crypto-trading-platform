/**
 * Strategy Watcher Service
 * Monitors strategies directory for real-time changes
 * 
 * Events:
 * - 'strategy:added' -> {name, path}
 * - 'strategy:removed' -> {name, path}
 * - 'strategy:edited' -> {name, path}
 */

const fs = require('fs-extra');
const path = require('path');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

const DEFAULT_STRATEGY = 'EmaRsiStrategy';
// Default path relative to project root for production
const STRATEGIES_DIR = process.env.MAIN_STRATEGIES_SOURCE_DIR || path.join(__dirname, '../../data/strategies');

class StrategyWatcher extends EventEmitter {
  constructor() {
    super();
    this.watcher = null;
    this.strategies = new Map(); // name -> { path, mtime, hash }
    this.debounceTimers = new Map(); // debounce edits
    this.isReady = false;
  }

  /**
   * Start watching for strategy changes
   */
  async start() {
    try {
      console.log(`[StrategyWatcher] Starting watcher for ${STRATEGIES_DIR}`);
      
      // Load initial strategies
      await this._loadInitialStrategies();
      
      // Set up file system watcher
      this.watcher = chokidar.watch(STRATEGIES_DIR, {
        ignored: /(^|[\/\\])\.|node_modules/,
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 300, // Wait 300ms of no changes
          pollInterval: 100
        }
      });

      this.watcher
        .on('add', (filepath) => this._handleAdd(filepath))
        .on('unlink', (filepath) => this._handleRemove(filepath))
        .on('change', (filepath) => this._handleEdit(filepath))
        .on('ready', () => {
          this.isReady = true;
          console.log(`[StrategyWatcher] Ready. Watching ${this.strategies.size} strategies.`);
          this.emit('watcher:ready', { count: this.strategies.size });
        })
        .on('error', (err) => {
          console.error(`[StrategyWatcher] Watcher error:`, err);
          this.emit('watcher:error', err);
        });

    } catch (err) {
      console.error(`[StrategyWatcher] Failed to start:`, err);
      throw err;
    }
  }

  /**
   * Stop watching
   */
  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.strategies.clear();
    this.debounceTimers.clear();
    this.isReady = false;
    console.log(`[StrategyWatcher] Stopped.`);
  }

  /**
   * Get all available strategies
   */
  getStrategies() {
    const list = [];
    for (const [name, info] of this.strategies) {
      list.push({
        name,
        path: info.path,
        isDefault: name === DEFAULT_STRATEGY
      });
    }
    return list.sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get default strategy
   */
  getDefaultStrategy() {
    return DEFAULT_STRATEGY;
  }

  /**
   * Check if strategy exists
   */
  hasStrategy(name) {
    return this.strategies.has(name);
  }

  /**
   * Load initial strategies from disk
   */
  async _loadInitialStrategies() {
    try {
      if (!await fs.pathExists(STRATEGIES_DIR)) {
        console.warn(`[StrategyWatcher] STRATEGIES_DIR does not exist: ${STRATEGIES_DIR}`);
        return;
      }

      const entries = await fs.readdir(STRATEGIES_DIR, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.py')) {
          const name = entry.name.replace('.py', '');
          const fullPath = path.join(STRATEGIES_DIR, entry.name);
          const stat = await fs.stat(fullPath);
          
          this.strategies.set(name, {
            path: fullPath,
            mtime: stat.mtime.getTime()
          });
          
          console.log(`[StrategyWatcher] Loaded strategy: ${name}`);
        }
      }
    } catch (err) {
      console.error(`[StrategyWatcher] Failed to load initial strategies:`, err);
    }
  }

  /**
   * Handle file added
   */
  async _handleAdd(filepath) {
    try {
      const filename = path.basename(filepath);
      if (!filename.endsWith('.py') || filename.startsWith('.')) {
        return;
      }

      const name = filename.replace('.py', '');
      const stat = await fs.stat(filepath);
      
      this.strategies.set(name, {
        path: filepath,
        mtime: stat.mtime.getTime()
      });
      
      console.log(`[StrategyWatcher] Strategy added: ${name}`);
      this.emit('strategy:added', { name, path: filepath });
    } catch (err) {
      console.error(`[StrategyWatcher] Error handling add:`, err);
    }
  }

  /**
   * Handle file removed
   */
  async _handleRemove(filepath) {
    try {
      const filename = path.basename(filepath);
      if (!filename.endsWith('.py')) {
        return;
      }

      const name = filename.replace('.py', '');
      
      if (this.strategies.has(name)) {
        this.strategies.delete(name);
        console.log(`[StrategyWatcher] Strategy removed: ${name}`);
        this.emit('strategy:removed', { name, path: filepath, isDefault: name === DEFAULT_STRATEGY });
      }
    } catch (err) {
      console.error(`[StrategyWatcher] Error handling remove:`, err);
    }
  }

  /**
   * Handle file edited (debounced)
   */
  async _handleEdit(filepath) {
    try {
      const filename = path.basename(filepath);
      if (!filename.endsWith('.py')) {
        return;
      }

      const name = filename.replace('.py', '');
      
      // Debounce edits (wait 500ms after last change)
      if (this.debounceTimers.has(name)) {
        clearTimeout(this.debounceTimers.get(name));
      }

      const timer = setTimeout(async () => {
        try {
          const stat = await fs.stat(filepath);
          const oldMtime = this.strategies.get(name)?.mtime;
          
          // Only emit if mtime changed (not first write)
          if (oldMtime && oldMtime !== stat.mtime.getTime()) {
            this.strategies.set(name, {
              path: filepath,
              mtime: stat.mtime.getTime()
            });
            
            console.log(`[StrategyWatcher] Strategy edited: ${name}`);
            this.emit('strategy:edited', { name, path: filepath });
          }
        } catch (err) {
          console.error(`[StrategyWatcher] Error finalizing edit:`, err);
        } finally {
          this.debounceTimers.delete(name);
        }
      }, 500);
      
      this.debounceTimers.set(name, timer);
    } catch (err) {
      console.error(`[StrategyWatcher] Error handling edit:`, err);
    }
  }
}

module.exports = StrategyWatcher;
