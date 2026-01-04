# Architecture Modernization & Monorepo Migration Plan

## Current Architecture Analysis

Your current architecture has **critical scaling limitations** (one Docker container per bot = resource explosion) and **organizational issues** (two separate repos, 5111-line monolith, duplicate code). The architecture is functional but won't scale beyond 20-30 bots and has significant technical debt.

### Current State

**Repository Structure:**
```
/root/
├── Crypto/                          # Main Repository
│   ├── Client/                      # React Frontend (Vite + TypeScript) - Port 5173
│   └── server/                      # Express.js Main Server (Port 5001)
│                                    # - MongoDB, Firebase Auth, CORS Proxy
└── Crypto-Pilot-Freqtrade/         # Bot Manager Repository
    ├── bot-manager/                 # Bot Manager Service (Port 5000)
    │                                # - 5111-line monolith
    │                                # - Docker orchestration
    │                                # - SSE streaming
    ├── Admin Strategies/            # Shared Strategy Files (copied per bot)
    ├── freqtrade-instances/         # Per-User Bot Instances
    └── freqtrade_shared_data/       # Shared Market Data
```

**Technology Stack:**
- **Frontend**: React 18 + Vite + TypeScript
- **Main Server**: Express.js + MongoDB + Firebase Admin
- **Bot Manager**: Express.js + SQLite (per-bot) + Turso sync
- **Bot Runtime**: Docker containers (freqtradeorg/freqtrade:stable)
- **Auth**: Dual-mode (Firebase OAuth + JWT HS256)
- **Real-time**: Server-Sent Events (SSE)

**Service Communication:**
```
Browser → Main Server (5001) → Bot Manager (5000) → FreqTrade Containers (8100+)
         [CORS Proxy]         [HTTP API]          [Per-bot SQLite]
```

### Critical Issues Identified

**🔴 Scaling Bottlenecks:**

1. **One Container Per Bot = Resource Explosion**
   - Current: 5 users × 2 bots = 10 Docker containers
   - Impact: ~500MB RAM per container = 5GB+ total
   - Doesn't scale beyond 20-30 bots on single VPS

2. **5111-Line Monolithic Bot Manager** ([bot-manager/index.js](Crypto-Pilot-Freqtrade/bot-manager/index.js))
   - Contains: Bot provisioning, Docker management, SSE streaming, portfolio aggregation, auth logic, settings management
   - Unmaintainable, hard to test, prone to merge conflicts

3. **Strategy File Duplication**
   - Full copy of all strategies to each bot directory
   - Update requires propagating to all bot instances
   - No versioning or rollback capability

4. **Two-Repository Structure**
   - Duplicate dependencies (`node_modules` in both repos)
   - Configuration drift (different package versions)
   - No shared code (auth, types, configs)
   - Complex deployment (two systemd services)

**🟡 Maintainability Issues:**

5. **Duplicate Auth Logic**
   - bot-manager/auth.js (367 lines)
   - server/middleware/auth.js (145 lines)
   - Same Firebase + JWT logic in both

6. **Sequential Bot Operations**
   - Single-threaded provisioning queue
   - Sequential portfolio aggregation (N bots = N × 500ms)
   - No parallel Docker operations

7. **Global Turso Failure Flag**
   - Single auth failure disables Turso sync for ALL future bots
   - Silent data loss risk

8. **Hardcoded Port Allocation**
   - Bots start at 8100, increment
   - Port collision risk on bot deletion/recreation

## Proposed Architecture: Modernized Multi-Tenant Platform

### Phase 1: Monorepo Foundation

**Goal:** Consolidate repositories, establish shared packages, eliminate duplication

**Structure:**
```
/root/crypto-trading-platform/
├── package.json                    # Root workspace config
├── nx.json / turbo.json           # Build orchestration
├── tsconfig.base.json             # Shared TypeScript config
│
├── apps/
│   ├── web/                       # React frontend (Vite)
│   ├── api-gateway/               # Single unified API server
│   └── bot-orchestrator/          # Refactored bot manager
│
├── packages/
│   ├── shared-types/              # TypeScript interfaces
│   ├── shared-auth/               # Unified auth logic
│   ├── shared-config/             # Environment/config management
│   ├── shared-utils/              # Common utilities
│   └── freqtrade-client/          # Bot API client library
│
├── services/
│   └── strategy-manager/          # Strategy versioning service
│
├── infrastructure/
│   ├── docker/                    # Dockerfiles, compose files
│   ├── nginx/                     # Nginx configs
│   └── systemd/                   # Service definitions
│
└── data/
    ├── strategies/                # Centralized strategy files
    ├── bot-instances/             # Bot data (SQLite/configs)
    └── shared-market-data/        # Exchange data
```

**Technology Choice:**
- **NX** (recommended) - Better for TypeScript, built-in caching, plugin ecosystem
- **Turborepo** (alternative) - Lighter, faster for simple monorepos

**Migration Steps:**
1. Create new monorepo root at `/root/crypto-trading-platform/`
2. Move `Crypto/Client/` → `apps/web/`
3. Move `Crypto/server/` → `apps/api-gateway/` (initially)
4. Move `Crypto-Pilot-Freqtrade/bot-manager/` → `apps/bot-orchestrator/`
5. Extract common code → `packages/shared-*`
6. Update systemd service paths
7. Archive old repos as `/root/Crypto.backup/` and `/root/Crypto-Pilot-Freqtrade.backup/`

**Benefits:**
- ✅ Single `npm install` for all dependencies
- ✅ Shared TypeScript types prevent API drift
- ✅ Unified auth logic (single source of truth)
- ✅ Atomic commits across services
- ✅ Simplified CI/CD pipeline


**The frontend is hosted on vercel right now. Serverd from the Crypto Repository. Make accomodation for this and give me steps to deploy to vercel from the monorepo. Also make it such that if I ever have to migrate this project from this vps to another, it's easy to do.**

### Phase 1.5: Wallet System Architecture (✅ IMPLEMENTED)

**Goal:** Implement paper trading wallet with bot pool allocation

#### Data Model

```
User
├── paperWallet: {
│     balance: number,             // Unallocated funds
│     currency: 'USD',             // Base currency
│     lastUpdated: Date
│   }
│
├── walletTransactions: [{
│     type: 'deposit' | 'withdraw' | 'allocate' | 'deallocate' | 'profit' | 'loss',
│     amount: number,
│     botId?: string,
│     botName?: string,
│     description: string,
│     balanceAfter: number,
│     timestamp: Date
│   }]
│
└── botAllocations: Map<botId, {
      allocatedAmount: number,     // Initial allocation from wallet
      currentValue: number,        // Current value (allocated + P&L)
      reservedInTrades: number,    // Currently in open positions
      availableBalance: number,    // Free to trade
      lifetimePnL: number,         // Total profit/loss since creation
      allocatedAt: Date,
      botName: string
    }>
```

#### Key Concepts

| Concept | Definition |
|---------|------------|
| **User Wallet** | The master paper money account. User deposits paper funds here. |
| **Bot Pool** | A portion of the wallet allocated to a specific bot. The bot can only trade with this. |
| **Available Balance** | Pool funds not currently in open trades. |
| **Reserved** | Funds locked in open positions. |
| **Current Value** | `allocatedAmount + unrealizedPnL + realizedPnL` |

**Portfolio Value Calculation:**
`Total Portfolio Value = User Wallet Balance + Sum of all Bot Pool Current Values`

#### Flow Diagrams

**1. Bot Provisioning with Pool Allocation:**
```
User Wallet: $10,000
     │
     ▼ User creates bot, allocates $2,000
     │
User Wallet: $8,000
Bot-1 Pool: $2,000 (available: $2,000, reserved: $0)
FreqTrade config: dry_run_wallet: { "USD": 2000 }
```

**2. Bot Opens a Trade:**
```
Bot-1 Pool: $2,000
     │
     ▼ Opens trade worth $500
     │
Bot-1 Pool: (available: $1,500, reserved: $500)
```

**3. Trade Closes with Profit:**
```
Bot-1 Pool: (available: $1,500, reserved: $500)
     │
     ▼ Trade closes at +$50 profit
     │
Bot-1 Pool: (available: $2,050, reserved: $0, currentValue: $2,050)
```

**4. Bot Deletion - Funds Return to Wallet:**
```
User Wallet: $8,000
Bot-1 Pool: $2,050 (after profits)
     │
     ▼ User deletes bot (all trades force-closed)
     │
User Wallet: $10,050
Bot-1 Pool: [deleted]
```

#### Implemented API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/account/wallet` | GET | Get wallet balance and allocations |
| `/api/account/wallet/deposit` | POST | Deposit paper money |
| `/api/account/wallet/withdraw` | POST | Withdraw paper money |
| `/api/account/wallet/set-balance` | POST | Set wallet balance directly |
| `/api/account/wallet/transactions` | GET | Get transaction history |
| `/api/account/wallet/allocate-to-bot` | POST | Allocate funds to a bot |
| `/api/account/wallet/return-from-bot` | POST | Return funds from a bot |
| `/api/account/wallet/update-bot-pool` | PUT | Update bot pool values (P&L sync) |
| `/api/account/wallet/bot-pool/:botId` | GET | Get specific bot pool status |
| `/api/freqtrade/provision` | POST | Provision bot with wallet allocation |
| `/api/freqtrade/bots/:instanceId` | DELETE | Delete bot and return funds |

#### FreqTrade Integration

When provisioning a bot, the `initialBalance` is used to set the FreqTrade `dry_run_wallet`:
```javascript
dry_run_wallet: {
  "USD": initialBalance,                    // From wallet allocation
  "BTC": Math.floor(initialBalance * 0.0001),
  "ETH": Math.floor(initialBalance * 0.003)
}
```

#### Files Modified

- `packages/shared-types/src/index.ts` - Wallet type definitions
- `apps/api-gateway/models/user.js` - User model with botAllocations
- `apps/api-gateway/routes/account.js` - Wallet endpoints
- `apps/api-gateway/routes/freqtrade-proxy.js` - Integrated provisioning/deletion

### Phase 2: Multi-Tenant Bot Architecture

**Goal:** Replace one-container-per-bot with pooled container strategy

**Current Problem:**
```
User A, Bot 1 → Container 1 (500MB)
User A, Bot 2 → Container 2 (500MB)
User B, Bot 1 → Container 3 (500MB)
...
Total: N bots = N × 500MB
```

**Proposed Solution: Container Pooling**

**Option A: Multi-Instance FreqTrade Containers**
```
Container Pool 1 (handles 10 bots) → 600MB
Container Pool 2 (handles 10 bots) → 600MB
...
Total: N bots = (N/10) × 600MB

Savings: 50 bots = 5 containers × 600MB = 3GB (vs 25GB)
```

**Implementation:**
1. Modify FreqTrade config to support multiple bot instances per container
2. Use separate SQLite databases per bot (isolated)
3. Route API requests via bot ID to correct container
4. Implement bot-to-container mapping service

**Option B: Custom Python Bot Runner (More Control)**
```python
# apps/bot-orchestrator/runners/multi_bot_runner.py
class MultiBotOrchestrator:
    def __init__(self, max_bots_per_process=10):
        self.bots = {}
        self.max_bots = max_bots_per_process
    
    async def add_bot(self, bot_id, config):
        """Load bot config and start FreqTrade instance"""
        bot_instance = FreqtradeBot(config)
        self.bots[bot_id] = bot_instance
        await bot_instance.start()
    
    async def remove_bot(self, bot_id):
        """Stop and cleanup bot instance"""
        await self.bots[bot_id].stop()
        del self.bots[bot_id]
    
    async def get_bot_status(self, bot_id):
        """Proxy status call to specific bot"""
        return await self.bots[bot_id].get_status()
```

**Container Strategy:**
- Run 3-5 Python processes (containers) each handling 10-15 bots
- Use process manager (PM2, systemd, or Kubernetes)
- Implement health checks and auto-restart
- Load balance new bots across containers

**Alternative: Keep Current Architecture but Optimize**
- Use lighter base image (Alpine-based FreqTrade)
- Set Docker memory limits per container
- Implement container hibernation (pause idle bots)
- Scale horizontally with multiple VPS instances

**Recommendation:** Start with **Option A** (multi-instance per container) as it maintains FreqTrade's stability while reducing resource usage 80%.

**User preference: Option A**



### Phase 3: Refactor Bot Manager Monolith

**Goal:** Break [bot-manager/index.jrdules

**Current Structure:**
```javascript
// bot-manager/index.js
// Lines 1-5111: Everything in one file
// - Express setup, middleware
// - Bot provisioning queue
// - Docker container management
// - SSE streaming
// - Portfolio aggregation
// - Auth logic
// - 50+ route handlers
```

**Proposed Modular Structure:**
```
apps/bot-orchestrator/
├── src/
│   ├── main.ts                    # App bootstrap
│   ├── config/
│   │   └── app.config.ts          # Environment variables
│   │
│   ├── modules/
│   │   ├── bots/
│   │   │   ├── bot.controller.ts      # HTTP routes
│   │   │   ├── bot.service.ts         # Business logic
│   │   │   ├── bot.repository.ts      # Data access
│   │   │   ├── bot.entity.ts          # Bot model
│   │   │   └── dto/                   # Request/response types
│   │   │
│   │   ├── containers/
│   │   │   ├── container.service.ts   # Docker orchestration
│   │   │   ├── container-pool.ts      # Multi-tenant pooling
│   │   │   └── health-monitor.ts      # Container health checks
│   │   │
│   │   ├── strategies/
│   │   │   ├── strategy.service.ts    # Strategy management
│   │   │   ├── strategy-sync.ts       # Git-based versioning
│   │   │   └── strategy-validator.ts  # Python syntax check
│   │   │
│   │   ├── portfolio/
│   │   │   ├── portfolio.service.ts   # Aggregation logic
│   │   │   ├── snapshot.service.ts    # Historical data
│   │   │   └── streaming.service.ts   # SSE implementation
│   │   │
│   │   ├── provisioning/
│   │   │   ├── queue.service.ts       # Bot creation queue
│   │   │   ├── provisioner.ts         # Setup orchestration
│   │   │   └── templates/             # Config templates
│   │   │
│   │   └── sync/
│   │       ├── turso-sync.service.ts  # Database sync
│   │       └── sync-scheduler.ts      # Cron jobs
│   │
│   ├── common/
│   │   ├── middleware/                # Auth, CORS, logging
│   │   ├── guards/                    # Authorization
│   │   ├── interceptors/              # Response transformation
│   │   └── filters/                   # Error handling
│   │
│   └── database/
│       ├── migrations/                # Schema versioning
│       └── repositories/              # Base repository pattern
│
└── test/
    ├── unit/                          # Unit tests per module
    └── integration/                   # E2E tests
```

**Technology Choice for Refactor:**

**Option 1: NestJS (Recommended)**
- ✅ Built-in dependency injection
- ✅ Module system enforces separation
- ✅ TypeScript-first
- ✅ Microservices support (future scaling)
- ✅ Built-in testing framework
- ❌ Learning curve if team unfamiliar

**Option 2: Express + TypeScript (Minimal Change)**
- ✅ Keep existing Express knowledge
- ✅ Easier incremental refactor
- ✅ Less dependencies
- ❌ Manual dependency injection
- ❌ No enforced structure

**Migration Strategy:**
1. Create parallel NestJS app structure
2. Migrate routes one module at a time (start with `/health`, `/strategies`)
3. Run both servers simultaneously (NestJS on 5002, old on 5000)
4. Update Nginx to route new endpoints to NestJS
5. Gradually migrate all routes
6. Decommission old service

**Execute this strategy.**

### Phase 4: Unified API Gateway

**Goal:** Merge Main Server (5001) and Bot Manager (5000) into single API service

**Current Flow:**
```
Browser → Main Server (5001) → Bot Manager (5000) → FreqTrade Containers
         [Auth + CORS]         [Bot Management]     [Trading Logic]
```

**Proposed Flow:**
```
Browser → API Gateway (5000) → Bot Orchestrator → FreqTrade Containers
         [Auth, Rate Limit,     [Internal Service]  [Trading Logic]
          CORS, Routing]
```

**API Gateway Responsibilities:**
- Authentication (Firebase + JWT)
- Authorization (role-based access)
- Rate limiting (per user/endpoint)
- Request validation
- Response caching
- CORS handling
- API versioning (/api/v1/, /api/v2/)
- WebSocket/SSE management
- Logging & metrics

**Bot Orchestrator (Internal Service):**
- Bot CRUD operations
- Container management
- Strategy deployment
- Portfolio aggregation
- Database operations

**Benefits:**
- ✅ Single entry point simplifies deployment
- ✅ Centralized auth & rate limiting
- ✅ Remove proxy layer (reduced latency)
- ✅ Easier to add new services later
- ✅ Better observability (single log stream)

**Implementation Options:**

**Option A: NestJS API Gateway + Microservices**
```typescript
// API Gateway
@Controller('api/v1/bots')
export class BotsController {
  constructor(
    @Inject('BOT_SERVICE') private botService: ClientProxy
  ) {}
  
  @Get()
  @UseGuards(JwtAuthGuard)
  async listBots(@User() user: UserEntity) {
    return this.botService.send('bots.list', { userId: user.id });
  }
}

// Bot Orchestrator (separate process)
@MessagePattern('bots.list')
async listBots(data: { userId: string }) {
  return this.botRepository.findByUser(data.userId);
}
```

**Option B: Express + Internal Function Calls**
```typescript
// Simpler, all in one process
app.get('/api/v1/bots', authenticate, async (req, res) => {
  const bots = await botService.listBots(req.user.id);
  res.json(bots);
});
```

**Recommendation:** Start with **Option B** (monolith) for simplicity, migrate to **Option A** (microservices) when scaling to multiple VPS instances.

**User preference: Option B**

### Phase 5: Database Consolidation

**Goal:** Eliminate database fragmentation and improve query performance

**Current State:**
- **MongoDB**: User data, auth, portfolio snapshots (Main Server)
- **SQLite**: Per-bot trades, orders, pairlock (Each bot)
- **Turso**: Cloud backup of SQLite (Optional)

**Problems:**
- 3 different database technologies
- No cross-bot queries (e.g., "show all open trades across my bots")
- Complex aggregation logic
- Turso adds cost and complexity

**Proposed: PostgreSQL as Primary Database**

**Why PostgreSQL:**
- ✅ Relational integrity (foreign keys)
- ✅ JSONB for flexible data (replaces MongoDB)
- ✅ Excellent performance at scale
- ✅ TimescaleDB extension for time-series data
- ✅ Full-text search
- ✅ Mature ecosystem

**Schema Design:**
```sql
-- Users and authentication
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  firebase_uid VARCHAR(255) UNIQUE,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bot instances
CREATE TABLE bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  strategy_name VARCHAR(255) NOT NULL,
  config JSONB NOT NULL,
  status VARCHAR(50) DEFAULT 'inactive',
  container_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Trades (directly from FreqTrade, no more SQLite)
CREATE TABLE trades (
  id BIGSERIAL PRIMARY KEY,
  bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
  trade_id INTEGER NOT NULL,
  pair VARCHAR(50) NOT NULL,
  is_open BOOLEAN DEFAULT true,
  open_rate NUMERIC(20, 10),
  close_rate NUMERIC(20, 10),
  amount NUMERIC(20, 10),
  profit_abs NUMERIC(20, 10),
  profit_ratio NUMERIC(10, 6),
  open_date TIMESTAMPTZ,
  close_date TIMESTAMPTZ,
  strategy VARCHAR(255),
  timeframe VARCHAR(10),
  UNIQUE(bot_id, trade_id)
);
CREATE INDEX idx_trades_bot_open ON trades(bot_id, is_open);
CREATE INDEX idx_trades_pair ON trades(pair);

-- Orders
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
  trade_id BIGINT REFERENCES trades(id) ON DELETE CASCADE,
  order_id VARCHAR(255) NOT NULL,
  order_type VARCHAR(50),
  side VARCHAR(10),
  pair VARCHAR(50),
  price NUMERIC(20, 10),
  amount NUMERIC(20, 10),
  filled NUMERIC(20, 10),
  status VARCHAR(50),
  timestamp TIMESTAMPTZ,
  UNIQUE(bot_id, order_id)
);

-- Portfolio snapshots (using TimescaleDB hypertable for time-series optimization)
CREATE TABLE portfolio_snapshots (
  time TIMESTAMPTZ NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  total_value NUMERIC(20, 10),
  data JSONB,
  PRIMARY KEY (user_id, time)
);
SELECT create_hypertable('portfolio_snapshots', 'time');

-- Strategies (version control)
CREATE TABLE strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) UNIQUE NOT NULL,
  version VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, version)
);
```

**Migration Strategy:**

**Step 1: Add PostgreSQL alongside existing databases**
```bash
docker run -d \
  --name postgres \
  -e POSTGRES_PASSWORD=secure_password \
  -e POSTGRES_DB=crypto_trading \
  -p 5432:5432 \
  -v /root/crypto-trading-platform/data/postgres:/var/lib/postgresql/data \
  postgres:16-alpine
```

**Step 2: Keep writing to both databases temporarily**
```typescript
// Dual-write pattern during migration
async createTrade(botId: string, trade: Trade) {
  // Write to PostgreSQL
  await this.postgresRepo.save(trade);
  
  // Still write to SQLite (temporary)
  await this.sqliteRepo.save(trade);
}
```

**Step 3: Verify data consistency**
```typescript
// Compare counts and values
const pgCount = await pg.query('SELECT COUNT(*) FROM trades WHERE bot_id = $1', [botId]);
const sqliteCount = await sqlite.query('SELECT COUNT(*) FROM trades');
assert(pgCount === sqliteCount);
```

**Step 4: Switch reads to PostgreSQL**
```typescript
// Change all read operations to PostgreSQL
async getTrades(botId: string) {
  return this.postgresRepo.find({ bot_id: botId });
}
```

**Step 5: Stop writing to SQLite, remove FreqTrade SQLite dependency**
```python
# Modify FreqTrade to write to PostgreSQL directly
# Or: Continue letting FreqTrade write to SQLite, sync via cron
```

**Alternative: Keep SQLite, Add PostgreSQL for Aggregations**
- Let each bot keep its SQLite database (FreqTrade native)
- Sync to PostgreSQL every 30 seconds for cross-bot queries
- Best of both worlds: FreqTrade stability + relational queries

**Recommendation:** Use **hybrid approach** initially (SQLite per bot + PostgreSQL for aggregation), fully migrate later when confident.

**User preference: Hybrid approach, also keep Turso for cloud backup. And give me steps on how to migrate from mongo to postgres and steps fro activating turso.**

### Phase 6: Strategy Management Service

**Goal:** Centralize strategy files, add versioning, enable rollback

**Current Problem:**
- Strategies copied to each bot directory
- No version control
- Update requires restarting all bots
- No rollback if strategy breaks

**Proposed: Git-Based Strategy Repository**

**Structure:**
```
data/strategies/
├── .git/                          # Git repository
├── strategies/
│   ├── AggressiveSophisticated1m.py
│   ├── BalancedStrat.py
│   ├── DCAStrategy.py
│   └── ...
├── tests/                         # Strategy backtests
└── configs/                       # Strategy metadata
    ├── AggressiveSophisticated1m.json
    └── BalancedStrat.json
```

**Strategy Metadata Example:**
```json
{
  "name": "AggressiveSophisticated1m",
  "version": "1.2.3",
  "description": "High-frequency scalping strategy",
  "author": "admin",
  "risk_level": "high",
  "timeframes": ["1m"],
  "compatible_pairs": ["BTC/USDT", "ETH/USDT"],
  "parameters": {
    "min_roi": {"0": 0.01},
    "stoploss": -0.05
  },
  "changelog": {
    "1.2.3": "Improved RSI thresholds",
    "1.2.2": "Fixed buy signal bug",
    "1.2.1": "Initial release"
  }
}
```

**Service Implementation:**
```typescript
// packages/strategy-manager/src/strategy.service.ts
export class StrategyService {
  constructor(private gitRepo: GitRepository) {}

  async listStrategies(): Promise<Strategy[]> {
    // Scan strategies/ directory, load metadata
    const files = await fs.readdir(this.strategiesPath);
    return Promise.all(
      files.filter(f => f.endsWith('.py'))
        .map(f => this.loadStrategyMetadata(f))
    );
  }

  async getStrategy(name: string, version?: string): Promise<StrategyContent> {
    if (version) {
      // Checkout specific git tag
      await this.gitRepo.checkout(`v${version}`);
    }
    return fs.readFile(`${this.strategiesPath}/${name}.py`, 'utf-8');
  }

  async deployStrategy(name: string, version: string, botIds: string[]): Promise<void> {
    const content = await this.getStrategy(name, version);
    
    // Validate strategy (syntax check)
    await this.validateStrategy(content);
    
    // Deploy to bots via Docker volume mount (not copy!)
    for (const botId of botIds) {
      await this.botService.updateStrategy(botId, name, version);
      await this.botService.restart(botId);
    }
  }

  async rollback(botId: string, toPreviousVersion: string): Promise<void> {
    const bot = await this.botService.getBot(botId);
    await this.deployStrategy(bot.strategyName, toPreviousVersion, [botId]);
  }

  async createStrategyVersion(name: string, content: string, message: string): Promise<void> {
    // Write file
    await fs.writeFile(`${this.strategiesPath}/${name}.py`, content);
    
    // Git commit and tag
    await this.gitRepo.add(`strategies/${name}.py`);
    await this.gitRepo.commit(message);
    const version = this.generateVersion(); // e.g., 1.2.4
    await this.gitRepo.tag(`v${version}`);
  }

  private async validateStrategy(content: string): Promise<void> {
    // Run Python syntax check
    const result = await exec(`python3 -m py_compile`, { input: content });
    if (result.stderr) {
      throw new Error(`Strategy syntax error: ${result.stderr}`);
    }
    
    // Check for required methods (populate_indicators, populate_buy_trend, etc.)
    if (!content.includes('def populate_indicators')) {
      throw new Error('Strategy must implement populate_indicators');
    }
  }
}
```

**Docker Volume Mount Strategy:**
```yaml
# docker-compose.yml for bot
services:
  freqtrade:
    volumes:
      # Read-only mount of entire strategy repository
      - /root/crypto-trading-platform/data/strategies/strategies:/freqtrade/user_data/strategies:ro
      
      # Bot's specific config points to strategy by name
      - ./config.json:/freqtrade/config.json:ro
```

**Benefits:**
- ✅ Single source of truth for strategies
- ✅ Full version history (git log)
- ✅ Rollback to any previous version
- ✅ No file duplication
- ✅ Update once, propagate everywhere

### Phase 7: Observability & Monitoring

**Goal:** Add comprehensive logging, metrics, and alerting

**Current State:**
- Logs scattered across systemd journals
- No aggregated logging
- No performance metrics
- No alerting on failures

**Proposed Stack:**

**1. Structured Logging (Pino or Winston)**
```typescript
// packages/shared-utils/src/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true },
        level: 'info',
      },
      {
        target: 'pino/file',
        options: { destination: '/var/log/crypto-trading/app.log' },
        level: 'info',
      },
      {
        target: 'pino-loki',
        options: {
          batching: true,
          interval: 5,
          host: 'http://localhost:3100',
        },
        level: 'warn',
      },
    ],
  },
});

// Usage
logger.info({ userId, botId, action: 'bot_started' }, 'Bot started successfully');
logger.error({ err, userId, botId }, 'Failed to provision bot');
```

**2. Metrics (Prometheus + Grafana)**
```typescript
// packages/shared-utils/src/metrics.ts
import { register, Counter, Histogram, Gauge } from 'prom-client';

export const metrics = {
  botsCreated: new Counter({
    name: 'bots_created_total',
    help: 'Total number of bots created',
    labelNames: ['user_id', 'strategy'],
  }),
  
  tradesExecuted: new Counter({
    name: 'trades_executed_total',
    help: 'Total trades executed',
    labelNames: ['bot_id', 'pair', 'side'],
  }),
  
  requestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.5, 1, 2, 5],
  }),
  
  activeContainers: new Gauge({
    name: 'docker_containers_active',
    help: 'Number of active FreqTrade containers',
  }),
};

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

**3. Distributed Tracing (Optional - OpenTelemetry)**
```typescript
// Trace request flow across services
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('bot-orchestrator');

async function provisionBot(userId: string, config: BotConfig) {
  const span = tracer.startSpan('provision_bot');
  span.setAttribute('user.id', userId);
  
  try {
    await createBotDirectory(userId);
    await launchContainer(userId);
    await initializeDatabase(userId);
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}
```

**4. Alerting (Alertmanager or Custom)**
```typescript
// Alert on critical failures
async function checkSystemHealth() {
  const activeContainers = await docker.listContainers();
  const expectedBots = await botRepository.count({ status: 'active' });
  
  if (activeContainers.length < expectedBots * 0.8) {
    await alerting.send({
      severity: 'critical',
      title: 'Bot Container Mismatch',
      message: `Expected ${expectedBots} bots, found ${activeContainers.length} containers`,
    });
  }
  
  // Check database lag
  const lag = await checkPostgresReplicationLag();
  if (lag > 5000) {
    await alerting.send({
      severity: 'warning',
      title: 'Database Replication Lag',
      message: `Replication lag: ${lag}ms`,
    });
  }
}
```

**Grafana Dashboards:**
- Bot performance (total bots, active trades, PnL)
- System resources (CPU, memory, disk per container)
- API performance (request rate, latency, error rate)
- Database metrics (query time, connection pool)

## Implementation Roadmap

### Timeline: 3-Month Phased Migration

**Month 1: Foundation (Weeks 1-4)**

**Week 1-2: Monorepo Setup**
- [ ] Create NX workspace at `/root/crypto-trading-platform/`
- [ ] Migrate `Crypto/Client/` → `apps/web/`
- [ ] Migrate `Crypto/server/` → `apps/api-gateway/`
- [ ] Migrate `Crypto-Pilot-Freqtrade/bot-manager/` → `apps/bot-orchestrator/`
- [ ] Create `packages/shared-types/`, `packages/shared-auth/`, `packages/shared-config/`
- [ ] Update systemd services to point to new paths
- [ ] Test all services run from new structure

**Week 3: Extract Shared Packages**
- [ ] Extract auth logic to `packages/shared-auth/`
- [ ] Create TypeScript interfaces in `packages/shared-types/`
- [ ] Centralize environment config in `packages/shared-config/`
- [ ] Update imports across all apps

**Week 4: Database Setup**
- [ ] Deploy PostgreSQL container
- [ ] Create initial schema and migrations
- [ ] Set up dual-write to both MongoDB and PostgreSQL
- [ ] Verify data consistency

**Month 2: Refactoring (Weeks 5-8)**

**Week 5-6: Refactor Bot Manager**
- [ ] Create NestJS app structure (or Express with modules)
- [ ] Extract bot CRUD operations to `BotService` and `BotRepository`
- [ ] Extract container management to `ContainerService`
- [ ] Extract strategy logic to `StrategyService`
- [ ] Migrate `/bots` endpoints to new structure

**Week 7: Portfolio & Streaming**
- [ ] Extract portfolio aggregation to `PortfolioService`
- [ ] Refactor SSE streaming to `StreamingService`
- [ ] Implement connection pooling and reconnection logic
- [ ] Optimize portfolio calculation (parallel fetches)

**Week 8: Testing & Validation**
- [ ] Write unit tests for all services (target 80% coverage)
- [ ] Write integration tests for critical flows
- [ ] Load testing (simulate 50+ bots)
- [ ] Fix bugs and performance issues

**Month 3: Optimization & Deployment (Weeks 9-12)**

**Week 9: Strategy Management**
- [ ] Initialize Git repository in `data/strategies/`
- [ ] Create strategy metadata JSON files
- [ ] Implement `StrategyService` with versioning
- [ ] Migrate to Docker volume mounts (remove file copying)

**Week 10: Multi-Tenant Containers**
- [ ] Design bot-to-container allocation algorithm
- [ ] Implement multi-bot container pooling
- [ ] Test with 10 bots per container
- [ ] Gradual rollout (start with dev/test users)

**Week 11: Observability**
- [ ] Set up Pino structured logging
- [ ] Deploy Prometheus + Grafana
- [ ] Create initial dashboards
- [ ] Implement critical alerts (Slack/email)

**Week 12: Final Migration**
- [ ] Switch all reads to PostgreSQL
- [ ] Stop dual-write to MongoDB
- [ ] Decommission old Main Server (port 5001)
- [ ] Update documentation
- [ ] Archive old repositories

**Post-Launch: Continuous Improvement**
- Monitor performance and resource usage
- Gather user feedback
- Scale container pool based on load
- Implement additional features (auto-scaling, A/B testing strategies)

## Technology Recommendations

### Core Stack

**Monorepo:** NX (TypeScript-focused, excellent DX)

**Backend Framework:** 
- **NestJS** for new services (type-safe, scalable)
- Keep Express for quick migrations, refactor later

**Database:**
- **PostgreSQL 16** (primary database)
- **TimescaleDB** extension (time-series data)
- Keep SQLite per-bot initially, migrate gradually

**API Layer:**
- REST for CRUD operations
- Server-Sent Events (SSE) for real-time updates
- Consider GraphQL for complex queries later

**Container Orchestration:**
- Docker Compose (current VPS setup)
- Consider Kubernetes if scaling to multi-server

**Observability:**
- **Pino** (structured logging)
- **Prometheus + Grafana** (metrics)
- **Loki** (log aggregation - optional)

**Testing:**
- **Jest** (unit tests)
- **Supertest** (API integration tests)
- **k6** (load testing)

### DevOps

**CI/CD:** GitHub Actions (or GitLab CI)
```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npx nx run-many --target=build --all
      - run: npx nx run-many --target=test --all
      - name: Deploy to VPS
        run: |
          rsync -avz --delete ./dist/ user@vps:/root/crypto-trading-platform/
          ssh user@vps 'sudo systemctl restart bot-orchestrator api-gateway'
```

**Infrastructure as Code:** 
- Docker Compose files in `/infrastructure/docker/`
- Systemd service templates in `/infrastructure/systemd/`

**Secrets Management:**
- Use `.env` files (excluded from Git)
- Consider HashiCorp Vault for production

## Migration Risks & Mitigation

### High-Risk Areas

**1. Data Loss During Database Migration**
- **Risk:** Losing trade history or user data
- **Mitigation:**
  - Full backup before migration (MongoDB dump, SQLite copies)
  - Dual-write period (write to both databases)
  - Automated data consistency checks
  - Rollback plan with restore scripts

**2. Downtime During Service Migration**
- **Risk:** Users unable to access platform
- **Mitigation:**
  - Blue-green deployment (run both old and new in parallel)
  - Gradual traffic shifting (Nginx can route to both)
  - Maintenance window announcement
  - Feature flags to enable/disable new code paths

**3. Bot Container Failures**
- **Risk:** Bots stop trading during migration
- **Mitigation:**
  - Migrate one user at a time
  - Keep old containers running until new confirmed stable
  - Implement automatic rollback on error
  - 24/7 monitoring during migration period

**4. Performance Regression**
- **Risk:** New architecture slower than old
- **Mitigation:**
  - Load testing before production deployment
  - Performance benchmarks (latency, throughput)
  - Gradual rollout with canary deployment
  - Quick rollback capability

### Testing Strategy

**Pre-Deployment:**
- [ ] Unit tests (80%+ coverage)
- [ ] Integration tests (happy paths + edge cases)
- [ ] Load test with 50+ simulated bots
- [ ] Security audit (dependency vulnerabilities)
- [ ] Performance benchmarks vs current system

**During Deployment:**
- [ ] Deploy to staging environment first
- [ ] Smoke tests after each phase
- [ ] Monitor error rates and latency
- [ ] Run parallel systems for 1 week
- [ ] Compare data accuracy between old and new

**Post-Deployment:**
- [ ] Monitor for 48 hours continuously
- [ ] Check logs for unexpected errors
- [ ] Verify all bots trading correctly
- [ ] User acceptance testing
- [ ] Performance comparison report

## Cost-Benefit Analysis

### Resource Savings

**Container Consolidation:**
- Current: 50 bots = 50 containers × 500MB = 25GB RAM
- Proposed: 50 bots = 5 containers × 1GB = 5GB RAM
- **Savings:** 80% reduction in memory usage

**Development Efficiency:**
- Current: Duplicate code, separate repos, manual sync
- Proposed: Shared packages, single source of truth
- **Savings:** ~30% faster feature development

**Operational Costs:**
- Current: Manual strategy updates, no versioning
- Proposed: Git-based deployment, rollback capability
- **Savings:** ~50% reduction in support time

### Development Time Investment

**Initial Migration:** ~300-400 hours (3 months part-time)
- Monorepo setup: 40 hours
- Refactoring: 150 hours
- Database migration: 50 hours
- Testing: 60 hours
- Documentation: 20 hours
- Buffer: 80 hours

**Ongoing Maintenance:**
- Current: High (monolith changes risky, hard to test)
- Proposed: Low (modular, well-tested, documented)

**ROI:** Break-even at 6 months, positive thereafter

## Alternatives Considered

### Option 1: Keep Current Architecture (Do Nothing)

**Pros:**
- Zero migration effort
- No risk of breaking changes
- Team familiar with codebase

**Cons:**
- Can't scale beyond 30 bots
- Technical debt accumulating
- Hard to onboard new developers
- High operational costs

**Verdict:** ❌ Not recommended (scaling issues)

### Option 2: Minimal Refactor (Just Fix the Monolith)

**Changes:**
- Break bot-manager/index.js into modules
- Keep two repos
- Keep one-container-per-bot

**Pros:**
- Lower risk
- Faster to implement (1 month)
- Easier to test

**Cons:**
- Doesn't solve scaling problem
- Still have repository duplication
- Limited long-term benefits

**Verdict:** ⚠️ Consider as Phase 1 only

### Option 3: Full Rewrite with Modern Stack

**Changes:**
- Rewrite everything in NestJS + Next.js
- Use GraphQL + subscriptions
- Deploy on Kubernetes
- Microservices from day one

**Pros:**
- Greenfield, no technical debt
- Modern architecture
- Best practices from start

**Cons:**
- 6+ months development time
- High risk (all or nothing)
- Requires platform downtime
- May over-engineer for current scale

**Verdict:** ❌ Too risky for production platform

### Option 4: Incremental Refactor (Recommended)

**Changes:**
- Monorepo + shared packages (Phase 1)
- Refactor bot manager (Phase 2)
- Container optimization (Phase 3)
- Database migration (Phase 4)

**Pros:**
- Low risk (one phase at a time)
- Can pause/rollback anytime
- No downtime required
- Delivers value incrementally

**Cons:**
- Takes 3 months total
- Requires discipline to complete
- Some code duplication temporarily

**Verdict:** ✅ **Recommended approach**

**User preference: Option 4**

**Right now the frontend and backend are configured to work together and they do. Cnonfigure the monorepo to work with vercel and the backend. The backend should be deployed from the vps in production. The backend should be completely compatible with the frontend design**

**Also integrate Posthog**

## Questions for Further Discussion

1. **Monorepo tool preference?** NX vs Turborepo vs pnpm workspaces?
**A: NX**
2. **Backend framework?** Keep Express or adopt NestJS for better structure?
**A: NestJS**
3. **Database strategy?** Full PostgreSQL migration or hybrid SQLite + PostgreSQL?
**A: hybrid SQLite + PostgreSQL**
4. **Container approach?** Multi-bot containers or optimize current architecture?
**A: Multi-bot containers**
5. **Timeline flexibility?** Can we dedicate 3 months or need faster migration?
**A: need exponentially faster migration**
6. **Feature freeze?** Should we pause new features during migration?
**A: Yes, we should pause new features during migration**
7. **Testing requirements?** What's minimum acceptable test coverage?
**A: 80%+ coverage**
8. **Deployment automation?** Priority for CI/CD pipeline?
**A: Yes, priority for CI/CD pipeline**
9. **Monitoring budget?** Self-hosted Grafana or paid service (Datadog, New Relic)?
**A: Self-hosted Grafana/Free options (free options preferred over self-hosted grafana)**
10. **Team size?** Solo developer or multiple contributors?
**A: solo**

## Next Steps

1. **Review this plan** and provide feedback on proposed architecture
2. **Answer discussion questions** to finalize approach
3. **Set up monorepo** structure and migrate code
4. **Create proof-of-concept** for multi-bot container
5. **Establish testing standards** and CI pipeline
6. **Begin Phase 1 migration** (monorepo + shared packages)

---

**Prepared for:** Crypto Trading Platform Modernization
**Date:** January 2, 2026
**Status:** Proposal - Awaiting Approval
