# Frontend Audit - apps/web/

**Last Updated:** 2026-01-06  
**Framework:** React 19 + Vite 7 + TypeScript  
**UI Library:** Radix UI + Tailwind CSS 4  
**State Management:** React Context + Custom Hooks

---

## Component Inventory

### Core Components (apps/web/src/components/)

#### ✅ Complete & Working
1. **login-form.tsx** - Firebase OAuth + email/password login
2. **signup-form.tsx** - User registration
3. **theme-provider.tsx** - Dark/light mode
4. **mode-toggle.tsx** - Theme switcher
5. **ProtectedRoute.tsx** - Route authentication guard
6. **app-sidebar.tsx** - Main navigation sidebar
7. **nav-main.tsx** - Main navigation items
8. **nav-user.tsx** - User profile menu
9. **team-switcher.tsx** - Team/workspace switcher (placeholder)

#### 🔄 Partially Complete
10. **dashboard.tsx** - Main dashboard (needs pool metrics integration)
11. **freqtrade-dashboard.tsx** - FreqTrade-specific dashboard (needs updates)
12. **pool-info.tsx** - Pool status display (incomplete, needs full implementation)
13. **portfolio-chart.tsx** - Portfolio value chart (needs optimization)
14. **portfolio-chart-canvas.tsx** - Canvas-based chart (performance issues)
15. **positions-table.tsx** - Open positions table (needs real-time updates)
16. **positions.tsx** - Positions overview (needs pool integration)
17. **trade-history.tsx** - Trade history table (needs pagination)
18. **bot-control.tsx** - Bot start/stop controls (needs pool awareness)
19. **strategy-selector.tsx** - Strategy selection dropdown (needs versioning)

#### ❌ Incomplete / Needs Work
20. **bot-roadmap.tsx** - Bot roadmap visualization (placeholder)
21. **quick-trade.tsx** - Quick trade execution (not implemented)
22. **TestPage.tsx** - Test page (development only)

---

### UI Components (apps/web/src/components/ui/)

**Status:** ✅ All Complete (Radix UI + shadcn/ui)

- alert-dialog.tsx
- alert.tsx
- avatar.tsx
- badge.tsx
- breadcrumb.tsx
- button.tsx
- card.tsx
- chart.tsx
- collapsible.tsx
- dialog.tsx
- dropdown-menu.tsx
- input.tsx
- label.tsx
- loading.tsx
- progress.tsx
- select.tsx
- separator.tsx
- sheet.tsx
- sidebar.tsx
- skeleton.tsx
- slider.tsx
- sonner.tsx (toast notifications)
- switch.tsx
- table.tsx
- tabs.tsx
- toaster.tsx
- tooltip.tsx
- use-toast.tsx

---

### Pages (apps/web/src/pages/)

#### ✅ Complete & Working
1. **auth-debug.tsx** - Authentication debugging (development only)

#### 🔄 Partially Complete
2. **account-settings.tsx** - User account settings (needs wallet integration)
3. **bot-config.tsx** - Bot configuration page (needs universal features UI)
4. **bot-console.tsx** - Bot console/logs (needs real-time log streaming)
5. **bot-provisioning.tsx** - Bot creation wizard (needs pool allocation UI)

#### ❌ Incomplete / Needs Work
6. **freqtrade-test.tsx** - FreqTrade testing page (development only)

#### ❌ Missing Pages
- **pool-management.tsx** - Pool management dashboard (NOT CREATED)
- **strategy-management.tsx** - Strategy versioning UI (NOT CREATED)
- **universal-features.tsx** - Universal features configuration (NOT CREATED)
- **monitoring.tsx** - System monitoring dashboard (NOT CREATED)
- **analytics.tsx** - Trading analytics (NOT CREATED)

---

### Custom Hooks (apps/web/src/hooks/)

#### ✅ Complete & Working
1. **use-mobile.ts** - Mobile device detection
2. **use-wallet.ts** - Wallet data fetching and management

#### 🔄 Partially Complete
3. **use-freqtrade-sse.ts** - SSE-based FreqTrade integration (needs error handling)
4. **use-freqtrade-integration.ts** - WebSocket-based integration (deprecated, needs removal)
5. **use-dashboard-freqtrade.ts** - Dashboard data aggregation (needs optimization)
6. **use-strategy-management.ts** - Strategy management (needs versioning support)

---

### Services/Libraries (apps/web/src/lib/)

#### ✅ Complete & Working
1. **firebase.tsx** - Firebase initialization
2. **auth.ts** - Authentication utilities
3. **auth-helper.ts** - Auth helper functions
4. **auth-debug.ts** - Auth debugging (development only)
5. **config.ts** - Environment configuration
6. **utils.ts** - Utility functions (cn, etc.)

#### 🔄 Partially Complete
7. **api.ts** - API client with token refresh (needs error handling improvements)
8. **apiRateLimiter.ts** - Client-side rate limiting (needs tuning)
9. **freqtrade-api.ts** - FreqTrade API client (needs pool awareness)
10. **freqtrade-service.ts** - FreqTrade service layer (needs refactoring)
11. **freqtrade-sse-service.ts** - SSE service (needs reconnection logic)
12. **strategy-api.ts** - Strategy API client (needs versioning support)
13. **chart-data-manager.ts** - Chart data management (needs optimization)

#### ❌ Incomplete / Needs Work
14. **rate-limit-test.ts** - Rate limit testing (development only)

---

## Detailed Component Analysis

### 1. dashboard.tsx (NEEDS UPDATE)

**Current State:**
- Displays portfolio summary
- Shows bot list
- Shows recent trades
- Uses SSE for real-time updates

**Missing Features:**
- Pool metrics integration
- Pool health indicators
- Bot-to-pool mapping visualization
- Universal features status
- Risk management overview

**Required Changes:**
```typescript
// Add pool metrics section
<PoolMetricsCard />

// Add pool health status
<PoolHealthIndicator />

// Add bot-to-pool mapping
<BotPoolMapping />

// Add universal features summary
<UniversalFeaturesSummary />
```

**Estimated Effort:** 10-15 hours

---

### 2. pool-info.tsx (INCOMPLETE)

**Current State:**
- Basic pool status display
- Shows pool count
- Shows bot count

**Missing Features:**
- Pool utilization chart
- Pool health status
- Bot-to-pool mapping table
- Pool metrics (memory, CPU, etc.)
- Pool actions (cleanup, rebalance, etc.)

**Required Implementation:**
```typescript
interface PoolInfoProps {
  poolId: string;
}

export function PoolInfo({ poolId }: PoolInfoProps) {
  const { poolData, loading, error } = usePoolData(poolId);
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pool {poolId}</CardTitle>
        <CardDescription>
          {poolData.botsCount} / {poolData.capacity} bots
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PoolUtilizationChart data={poolData} />
        <PoolHealthStatus health={poolData.health} />
        <BotList bots={poolData.bots} />
      </CardContent>
      <CardFooter>
        <Button onClick={handleCleanup}>Cleanup</Button>
        <Button onClick={handleRebalance}>Rebalance</Button>
      </CardFooter>
    </Card>
  );
}
```

**Estimated Effort:** 15-20 hours

---

### 3. bot-provisioning.tsx (NEEDS UPDATE)

**Current State:**
- Bot creation wizard
- Strategy selection
- Basic configuration
- Wallet allocation

**Missing Features:**
- Pool allocation selection
- Universal features configuration
- Risk level presets
- Strategy version selection

**Required Changes:**
```typescript
// Add pool allocation step
<ProvisioningStep title="Pool Allocation">
  <PoolSelector onSelect={setSelectedPool} />
</ProvisioningStep>

// Add universal features step
<ProvisioningStep title="Universal Features">
  <UniversalFeaturesConfig onChange={setFeatures} />
</ProvisioningStep>

// Add risk preset selection
<ProvisioningStep title="Risk Management">
  <RiskPresetSelector onChange={setRiskLevel} />
</ProvisioningStep>
```

**Estimated Effort:** 10-15 hours

---

### 4. bot-config.tsx (NEEDS UPDATE)

**Current State:**
- Basic bot configuration
- Strategy selection
- Trading pairs

**Missing Features:**
- Universal features UI
- Risk management UI
- Take profit levels UI
- Trailing stop UI
- Position limits UI
- Trading schedule UI

**Required Implementation:**
```typescript
<Tabs defaultValue="basic">
  <TabsList>
    <TabsTrigger value="basic">Basic</TabsTrigger>
    <TabsTrigger value="universal">Universal Features</TabsTrigger>
    <TabsTrigger value="risk">Risk Management</TabsTrigger>
    <TabsTrigger value="advanced">Advanced</TabsTrigger>
  </TabsList>
  
  <TabsContent value="universal">
    <UniversalFeaturesPanel botId={botId} />
  </TabsContent>
  
  <TabsContent value="risk">
    <RiskManagementPanel botId={botId} />
  </TabsContent>
</Tabs>
```

**Estimated Effort:** 20-25 hours

---

### 5. use-freqtrade-sse.ts (NEEDS IMPROVEMENT)

**Current State:**
- SSE connection to bot-orchestrator
- Real-time portfolio updates
- Real-time trade updates
- Basic error handling

**Issues:**
- No automatic reconnection on disconnect
- No exponential backoff
- Memory leaks on unmount
- No connection status indicator

**Required Improvements:**
```typescript
export function useFreqTradeSSE() {
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('disconnected');
  const [retryCount, setRetryCount] = useState(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const connect = useCallback(() => {
    const eventSource = new EventSource(`${API_URL}/portfolio/stream`);

    eventSource.onopen = () => {
      setConnectionStatus('connected');
      setRetryCount(0);
    };

    eventSource.onerror = () => {
      setConnectionStatus('disconnected');
      eventSource.close();

      // Exponential backoff
      const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
      reconnectTimeoutRef.current = setTimeout(() => {
        setConnectionStatus('reconnecting');
        setRetryCount(prev => prev + 1);
        connect();
      }, delay);
    };

    return eventSource;
  }, [retryCount]);

  useEffect(() => {
    const eventSource = connect();

    return () => {
      eventSource.close();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  return { connectionStatus, /* ... */ };
}
```

**Estimated Effort:** 5-8 hours

---

### 6. portfolio-chart-canvas.tsx (PERFORMANCE ISSUES)

**Current State:**
- Canvas-based chart rendering
- Real-time updates
- Multiple timeframes

**Issues:**
- High CPU usage on updates
- Memory leaks
- Choppy animations
- No debouncing

**Required Optimizations:**
```typescript
// Add debouncing
const debouncedUpdate = useMemo(
  () => debounce((data: ChartData) => {
    updateChart(data);
  }, 100),
  []
);

// Use requestAnimationFrame
const animationFrameRef = useRef<number>();

const render = useCallback(() => {
  if (!canvasRef.current) return;

  const ctx = canvasRef.current.getContext('2d');
  if (!ctx) return;

  // Clear and redraw
  ctx.clearRect(0, 0, width, height);
  drawChart(ctx, chartData);

  animationFrameRef.current = requestAnimationFrame(render);
}, [chartData, width, height]);

useEffect(() => {
  animationFrameRef.current = requestAnimationFrame(render);

  return () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
  };
}, [render]);
```

**Estimated Effort:** 8-10 hours

---

## Missing Pages to Create

### 1. pool-management.tsx (NOT CREATED)

**Purpose:** Centralized pool management dashboard

**Features:**
- List all pools
- Pool utilization charts
- Pool health status
- Bot-to-pool mapping
- Pool actions (cleanup, rebalance, create, delete)
- Pool metrics (memory, CPU, network)

**Estimated Effort:** 20-25 hours

---

### 2. strategy-management.tsx (NOT CREATED)

**Purpose:** Strategy versioning and deployment UI

**Features:**
- List all strategies
- Strategy version history
- Deploy strategy to bots
- Rollback strategy
- Strategy changelog
- Backtest results

**Estimated Effort:** 15-20 hours

---

### 3. universal-features.tsx (NOT CREATED)

**Purpose:** Universal features configuration dashboard

**Features:**
- Global risk management settings
- Take profit presets
- Trailing stop presets
- Position limits
- Trading schedule
- Feature toggles per bot

**Estimated Effort:** 20-25 hours

---

### 4. monitoring.tsx (NOT CREATED)

**Purpose:** System monitoring dashboard (Grafana alternative)

**Features:**
- System metrics (CPU, memory, disk)
- API metrics (response times, error rates)
- Bot metrics (active bots, trades, PnL)
- Pool metrics (utilization, health)
- Real-time alerts
- Historical charts

**Estimated Effort:** 30-40 hours

---

### 5. analytics.tsx (NOT CREATED)

**Purpose:** Trading analytics and insights

**Features:**
- Win rate by strategy
- PnL by trading pair
- Best/worst performing bots
- Risk-adjusted returns
- Drawdown analysis
- Correlation matrix

**Estimated Effort:** 25-30 hours

---

## Component Refactoring Priorities

### High Priority
1. **pool-info.tsx** - Complete implementation (15-20h)
2. **dashboard.tsx** - Add pool metrics (10-15h)
3. **bot-provisioning.tsx** - Add pool allocation (10-15h)
4. **use-freqtrade-sse.ts** - Fix reconnection logic (5-8h)

**Total:** 40-58 hours

### Medium Priority
5. **bot-config.tsx** - Add universal features UI (20-25h)
6. **portfolio-chart-canvas.tsx** - Performance optimization (8-10h)
7. **strategy-selector.tsx** - Add versioning (5-8h)
8. **positions-table.tsx** - Add real-time updates (5-8h)

**Total:** 38-51 hours

### Low Priority
9. **trade-history.tsx** - Add pagination (5-8h)
10. **bot-control.tsx** - Add pool awareness (5-8h)
11. **freqtrade-dashboard.tsx** - Update for pools (8-10h)

**Total:** 18-26 hours

---

## New Pages to Create

### High Priority
1. **pool-management.tsx** (20-25h)
2. **universal-features.tsx** (20-25h)

**Total:** 40-50 hours

### Medium Priority
3. **strategy-management.tsx** (15-20h)
4. **monitoring.tsx** (30-40h)

**Total:** 45-60 hours

### Low Priority
5. **analytics.tsx** (25-30h)

**Total:** 25-30 hours

---

## Testing Requirements

### Unit Tests Needed
- [ ] dashboard.test.tsx
- [ ] pool-info.test.tsx
- [ ] bot-provisioning.test.tsx
- [ ] bot-config.test.tsx
- [ ] use-freqtrade-sse.test.ts
- [ ] use-wallet.test.ts
- [ ] api.test.ts
- [ ] freqtrade-api.test.ts

**Estimated Effort:** 20-30 hours

### Integration Tests Needed
- [ ] Bot provisioning flow
- [ ] Pool management flow
- [ ] Strategy deployment flow
- [ ] Universal features configuration flow

**Estimated Effort:** 15-20 hours

---

## Summary

### Total Frontend Work Remaining

**Component Refactoring:**
- High Priority: 40-58 hours
- Medium Priority: 38-51 hours
- Low Priority: 18-26 hours

**New Pages:**
- High Priority: 40-50 hours
- Medium Priority: 45-60 hours
- Low Priority: 25-30 hours

**Testing:**
- Unit Tests: 20-30 hours
- Integration Tests: 15-20 hours

**Grand Total:** 241-325 hours (~6-8 weeks full-time)

---

## Recommended Frontend Sprint Plan

### Sprint 1 (Week 1-2): Pool UI
- [ ] Complete pool-info.tsx
- [ ] Update dashboard.tsx with pool metrics
- [ ] Create pool-management.tsx page
- [ ] Update bot-provisioning.tsx with pool allocation

**Effort:** 55-75 hours

### Sprint 2 (Week 3-4): Universal Features
- [ ] Create universal-features.tsx page
- [ ] Update bot-config.tsx with universal features UI
- [ ] Add risk management presets
- [ ] Add take profit/trailing stop UI

**Effort:** 40-50 hours

### Sprint 3 (Week 5-6): Performance & Testing
- [ ] Fix use-freqtrade-sse.ts reconnection
- [ ] Optimize portfolio-chart-canvas.tsx
- [ ] Write unit tests (80%+ coverage)
- [ ] Write integration tests

**Effort:** 48-66 hours

### Sprint 4 (Week 7-8): Advanced Features
- [ ] Create strategy-management.tsx page
- [ ] Create monitoring.tsx page
- [ ] Create analytics.tsx page
- [ ] Polish and bug fixes

**Effort:** 70-90 hours

---

**End of Frontend Audit**
