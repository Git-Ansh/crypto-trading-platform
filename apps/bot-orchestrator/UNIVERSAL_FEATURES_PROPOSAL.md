# Universal Bot Features - Enhancement Proposal

## Current Implementation Status

### ✅ Already Implemented (via UniversalRiskManager)
- **Risk Level (0-100)** - Dynamic position sizing, stop loss, max drawdown
- **Auto-Rebalance** - Portfolio allocation maintenance
- **DCA (Dollar Cost Averaging)** - Multi-level entries on dips

---

## Proposed New Universal Features

### Priority 1: Risk Management Enhancements

#### 1. Multiple Take Profit Levels
**Why**: Allows scaling out of winning positions systematically
```javascript
takeProfitLevels: [
  { percentage: 2, exitPercent: 25 },   // Take 25% at +2%
  { percentage: 5, exitPercent: 50 },   // Take 50% at +5%
  { percentage: 10, exitPercent: 100 }  // Full exit at +10%
],
takeProfitMode: 'ladder' | 'single'     // Ladder = multiple exits
```

**Implementation**:
- Add to universal-risk-manager.js
- Monitor position profit percentage
- Auto-execute partial sells at thresholds
- Update dashboard UI with TP level indicators

#### 2. Advanced Trailing Stop
**Why**: Protects profits while letting winners run
```javascript
trailingStop: {
  enabled: true,
  activationPercent: 3,      // Start trailing after +3% profit
  callbackRate: 1.5,         // Trail by 1.5%
  stepSize: 0.5,             // Move stop every 0.5% gain
  lockInProfit: true         // Never let profit turn to loss
}
```

#### 3. Max Daily Loss Circuit Breaker
**Why**: Prevents catastrophic drawdowns
```javascript
dailyLossProtection: {
  maxDailyLossPercent: 5,    // Stop if -5% in 24h
  pauseUntil: 'nextDay',     // Resume next trading day
  notifyUser: true,          // Send alert
  closePositions: false      // Keep positions but stop new entries
}
```

---

### Priority 2: Trading Control Features

#### 4. Trading Schedule
**Why**: Trade only during optimal market hours
```javascript
tradingSchedule: {
  enabled: true,
  timezone: 'America/New_York',
  activeHours: {
    start: '09:30',  // Market open
    end: '16:00'     // Before close
  },
  activeDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  avoidWeekends: true,
  holidayMode: false
}
```

#### 5. Position Limits
**Why**: Enforces diversification
```javascript
positionLimits: {
  maxPercentPerAsset: 30,       // No more than 30% in one asset
  maxPositionsPerAsset: 3,      // Max 3 BTC positions simultaneously
  minTimeBetweenSameAsset: 3600, // 1 hour cooldown
  maxCorrelatedPositions: 2      // Max 2 highly correlated assets
}
```

#### 6. Smart Order Execution
**Why**: Reduce slippage and fees
```javascript
orderExecution: {
  useLimit: true,              // Prefer limit orders
  limitOffsetPercent: 0.1,     // Place 0.1% better than market
  postOnly: true,              // Maker orders only (lower fees)
  timeInForce: 'GTC',          // Good til canceled
  icebergOrders: {
    enabled: false,
    visiblePercent: 20         // Show only 20% of order
  }
}
```

---

### Priority 3: Advanced Risk Features

#### 7. Volatility-Based Sizing
**Why**: Reduce exposure during high volatility
```javascript
volatilityAdjustment: {
  enabled: true,
  method: 'ATR',               // Average True Range
  lookbackPeriod: 14,          // 14 periods
  scaleFactor: 2.0,            // Size = baseSize / (1 + volatility * factor)
  minSizePercent: 50           // Never reduce below 50% of base size
}
```

#### 8. Correlation Management
**Why**: Avoid overexposure to correlated assets
```javascript
correlationSettings: {
  enabled: true,
  trackingWindow: 30,          // Days to calculate correlation
  maxCorrelatedPositions: 2,   // Max 2 assets with correlation > threshold
  correlationThreshold: 0.7,   // 0.7 = high correlation
  correlationPairs: {
    'BTC/USD': ['ETH/USD'],    // These are correlated
    'ETH/USD': ['BTC/USD']
  }
}
```

#### 9. Drawdown Management
**Why**: Progressive risk reduction during losing streaks
```javascript
drawdownProtection: {
  enabled: true,
  thresholds: [
    { drawdown: 5, riskReduction: 25 },   // -5% DD: reduce risk by 25%
    { drawdown: 10, riskReduction: 50 },  // -10% DD: reduce risk by 50%
    { drawdown: 15, riskReduction: 75 }   // -15% DD: reduce risk by 75%
  ],
  recoveryMultiplier: 1.5,     // Need 1.5x gain to restore risk
  resetOnNewPeak: true         // Reset when new equity high
}
```

---

### Priority 4: Portfolio Management

#### 10. Profit Compounding & Withdrawal
**Why**: Systematic profit management
```javascript
profitManagement: {
  compounding: {
    enabled: true,
    reinvestPercent: 80,       // Reinvest 80% of realized profits
    withdrawPercent: 20,       // Withdraw 20%
    minProfitToWithdraw: 1000  // Only withdraw when >$1000 profit
  },
  targetBalance: {
    enabled: false,
    target: 50000,             // Stop reinvesting at $50k
    maintainTarget: true       // Withdraw excess
  }
}
```

#### 11. Emergency Controls
**Why**: Quick response to market crashes
```javascript
emergencyStop: {
  enabled: true,
  triggers: {
    btcDropPercent: 15,        // If BTC drops 15% in 1hr
    portfolioDropPercent: 10,  // Or portfolio drops 10% in 1hr
    exchangeIssues: true       // Or exchange API errors
  },
  actions: {
    closeAllPositions: false,  // Keep positions
    cancelAllOrders: true,     // Cancel pending orders
    stopNewEntries: true,      // No new positions
    notifyUser: true           // Send alert
  },
  pauseDuration: 24,           // Hours
  manualOverride: true         // User can manually resume
}
```

---

## Performance Optimization Recommendations

### 1. Database Optimizations
```javascript
// Add indexes to frequently queried fields
CREATE INDEX idx_trades_pair ON trades(pair);
CREATE INDEX idx_trades_open_date ON trades(open_date);
CREATE INDEX idx_trades_close_date ON trades(close_date);
CREATE INDEX idx_trades_profit ON trades(profit_abs);

// Use connection pooling
const pool = new Pool({
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### 2. Caching Layer
```javascript
// Cache frequently accessed data
const NodeCache = require('node-cache');
const botCache = new NodeCache({ stdTTL: 30 }); // 30 second cache

async function getBotPerformance(instanceId) {
  const cacheKey = `perf_${instanceId}`;
  let data = botCache.get(cacheKey);
  
  if (!data) {
    data = await fetchFromDatabase(instanceId);
    botCache.set(cacheKey, data);
  }
  
  return data;
}
```

### 3. Batch Processing
```javascript
// Process multiple bots in parallel with rate limiting
const pLimit = require('p-limit');
const limit = pLimit(5); // Max 5 concurrent operations

const results = await Promise.all(
  botIds.map(id => limit(() => updateBotMetrics(id)))
);
```

### 4. WebSocket Optimization
```javascript
// Use message queuing to prevent overload
const messageQueue = [];
let isProcessing = false;

function queueMessage(msg) {
  messageQueue.push(msg);
  if (!isProcessing) processQueue();
}

async function processQueue() {
  isProcessing = true;
  while (messageQueue.length > 0) {
    const batch = messageQueue.splice(0, 10); // Process 10 at a time
    await Promise.all(batch.map(sendMessage));
    await sleep(100); // Rate limit
  }
  isProcessing = false;
}
```

### 5. Strategy Optimization
```javascript
// Precompute indicators once per candle
class OptimizedStrategy {
  populateIndicators(dataframe) {
    // Cache indicator calculations
    const cacheKey = `indicators_${dataframe.iloc[-1].date}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    // Calculate once
    dataframe['rsi'] = ta.RSI(dataframe);
    dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=12);
    dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=26);
    
    this.cache.set(cacheKey, dataframe);
    return dataframe;
  }
}
```

### 6. Memory Management
```javascript
// Clean up old data periodically
async function cleanupOldData() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90); // Keep 90 days
  
  await db.query('DELETE FROM trades WHERE close_date < ?', [cutoffDate]);
  await db.query('VACUUM'); // Reclaim space
}

// Run cleanup weekly
cron.schedule('0 2 * * 0', cleanupOldData);
```

---

## Implementation Priority

### Phase 1 (Essential)
1. Multiple Take Profit Levels
2. Advanced Trailing Stop
3. Max Daily Loss Circuit Breaker
4. Database indexing & caching

### Phase 2 (Important)
5. Trading Schedule
6. Position Limits
7. Volatility-Based Sizing
8. Batch processing optimization

### Phase 3 (Advanced)
9. Correlation Management
10. Drawdown Protection
11. Emergency Controls
12. Profit Compounding

### Phase 4 (Polish)
13. Smart Order Execution
14. WebSocket optimization
15. Strategy precomputation
16. Memory management

---

## API Endpoints to Add

```javascript
// Get all universal features for a bot
GET /api/universal-features/:instanceId

// Update specific feature settings
PUT /api/universal-features/:instanceId/:featureName

// Get performance metrics affected by features
GET /api/feature-impact/:instanceId

// Test feature configuration (dry-run simulation)
POST /api/feature-test/:instanceId
```

---

## UI Components Needed

### Dashboard Enhancements
1. **Feature Toggle Panel** - Enable/disable features per bot
2. **Risk Gauge** - Visual risk level indicator with breakdown
3. **Performance Attribution** - Show which features impacted P&L
4. **Feature Recommendations** - AI-suggested optimal settings

### New Pages
1. **Advanced Settings** - Full feature configuration
2. **Risk Analysis** - Detailed risk metrics and backtesting
3. **Feature Impact** - Historical performance by feature

---

## Testing Strategy

1. **Unit Tests** - Each feature independently
2. **Integration Tests** - Features working together
3. **Backtest** - Historical data simulation
4. **Paper Trading** - Live market, fake money
5. **Gradual Rollout** - Enable for 10% of users first

---

## Documentation Needs

1. Feature explanation videos
2. Risk calculator tool
3. Best practices guide
4. Strategy compatibility matrix
5. Performance benchmarks
