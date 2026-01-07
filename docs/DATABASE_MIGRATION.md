# Database Migration Playbook: Hybrid Mongo → PostgreSQL + Turso

## Overview
This playbook outlines the hybrid database migration strategy:
- **Keep SQLite** per-bot (FreqTrade native)
- **Add PostgreSQL** for aggregated queries and new data
- **Keep Turso** for cloud backup of SQLite databases
- **Gradually migrate MongoDB** data to PostgreSQL

---

## Phase 1: PostgreSQL Setup

### 1.1 Deploy PostgreSQL Container

```bash
# Create data directory
mkdir -p /root/crypto-trading-platform/data/postgres

# Run PostgreSQL 16
docker run -d \
  --name postgres \
  --restart unless-stopped \
  -e POSTGRES_PASSWORD=<secure_password> \
  -e POSTGRES_DB=crypto_trading \
  -e POSTGRES_USER=crypto_admin \
  -p 5432:5432 \
  -v /root/crypto-trading-platform/data/postgres:/var/lib/postgresql/data \
  postgres:16-alpine

# Verify it's running
docker logs postgres
```

### 1.2 Create Initial Schema

```bash
# Connect to PostgreSQL
docker exec -it postgres psql -U crypto_admin -d crypto_trading
```

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (mirrors MongoDB users collection)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  firebase_uid VARCHAR(255) UNIQUE,
  name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user',
  paper_balance NUMERIC(20, 2) DEFAULT 10000.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bot instances
CREATE TABLE bots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instance_id VARCHAR(255) UNIQUE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255),
  strategy_name VARCHAR(255) NOT NULL,
  trading_pairs JSONB DEFAULT '[]',
  config JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'inactive',
  container_id VARCHAR(255),
  api_port INTEGER,
  dry_run BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bots_user ON bots(user_id);
CREATE INDEX idx_bots_status ON bots(status);

-- Aggregated trades (synced from SQLite)
CREATE TABLE trades_aggregated (
  id BIGSERIAL PRIMARY KEY,
  bot_id UUID REFERENCES bots(id) ON DELETE CASCADE,
  trade_id INTEGER NOT NULL,
  pair VARCHAR(50) NOT NULL,
  is_open BOOLEAN DEFAULT true,
  open_rate NUMERIC(20, 10),
  close_rate NUMERIC(20, 10),
  amount NUMERIC(20, 10),
  stake_amount NUMERIC(20, 10),
  profit_abs NUMERIC(20, 10),
  profit_ratio NUMERIC(10, 6),
  fee_open NUMERIC(20, 10),
  fee_close NUMERIC(20, 10),
  open_date TIMESTAMPTZ,
  close_date TIMESTAMPTZ,
  strategy VARCHAR(255),
  timeframe VARCHAR(10),
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bot_id, trade_id)
);
CREATE INDEX idx_trades_bot_open ON trades_aggregated(bot_id, is_open);
CREATE INDEX idx_trades_open_date ON trades_aggregated(open_date);

-- Portfolio snapshots (for charts)
CREATE TABLE portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  total_value NUMERIC(20, 10) NOT NULL,
  cash_balance NUMERIC(20, 10),
  positions_value NUMERIC(20, 10),
  data JSONB,
  timeframe VARCHAR(20) DEFAULT 'adhoc',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_snapshots_user_time ON portfolio_snapshots(user_id, recorded_at);

-- Strategies registry
CREATE TABLE strategies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) UNIQUE NOT NULL,
  version VARCHAR(50) NOT NULL,
  description TEXT,
  risk_level VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  checksum VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.3 Add PostgreSQL to Backend

Add to `.env.production`:
```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=crypto_trading
POSTGRES_USER=crypto_admin
POSTGRES_PASSWORD=<secure_password>
```

---

## Phase 2: Dual-Write Pattern

### 2.1 Install PostgreSQL Client

```bash
cd /root/crypto-trading-platform
npm install pg --workspace=apps/api-gateway
```

### 2.2 Create Database Service

Create `apps/api-gateway/utils/postgres.js`:
```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'crypto_trading',
  user: process.env.POSTGRES_USER || 'crypto_admin',
  password: process.env.POSTGRES_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
```

### 2.3 Implement Dual-Write for Users

```javascript
// In user creation route
const pg = require('../utils/postgres');

async function createUser(userData) {
  // Write to MongoDB (existing)
  const mongoUser = await User.create(userData);
  
  // Also write to PostgreSQL
  try {
    await pg.query(`
      INSERT INTO users (email, firebase_uid, name, role, paper_balance)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET
        firebase_uid = EXCLUDED.firebase_uid,
        name = EXCLUDED.name,
        updated_at = NOW()
    `, [userData.email, userData.firebaseUid, userData.name, userData.role, userData.paperBalance]);
  } catch (err) {
    console.error('PostgreSQL dual-write failed:', err);
    // Don't fail the request, just log
  }
  
  return mongoUser;
}
```

---

## Phase 3: SQLite → PostgreSQL Sync

### 3.1 Create Sync Script

Create `scripts/sync-sqlite-to-postgres.js`:
```javascript
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const BOT_INSTANCES_DIR = '/root/crypto-trading-platform/data/bot-instances';

async function syncBotTrades(botInstanceId, pgPool) {
  const dbPath = path.join(BOT_INSTANCES_DIR, botInstanceId, 'user_data', 'tradesv3.sqlite');
  
  if (!fs.existsSync(dbPath)) {
    console.log(`No SQLite DB for bot ${botInstanceId}`);
    return;
  }
  
  const sqlite = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  
  return new Promise((resolve, reject) => {
    sqlite.all('SELECT * FROM trades', async (err, trades) => {
      if (err) {
        reject(err);
        return;
      }
      
      const client = await pgPool.connect();
      try {
        for (const trade of trades) {
          await client.query(`
            INSERT INTO trades_aggregated (
              bot_id, trade_id, pair, is_open, open_rate, close_rate,
              amount, stake_amount, profit_abs, profit_ratio,
              open_date, close_date, strategy, timeframe, synced_at
            ) VALUES (
              (SELECT id FROM bots WHERE instance_id = $1),
              $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
            )
            ON CONFLICT (bot_id, trade_id) DO UPDATE SET
              is_open = EXCLUDED.is_open,
              close_rate = EXCLUDED.close_rate,
              profit_abs = EXCLUDED.profit_abs,
              profit_ratio = EXCLUDED.profit_ratio,
              close_date = EXCLUDED.close_date,
              synced_at = NOW()
          `, [
            botInstanceId, trade.id, trade.pair, trade.is_open,
            trade.open_rate, trade.close_rate, trade.amount, trade.stake_amount,
            trade.profit_abs, trade.profit_ratio,
            trade.open_date, trade.close_date, trade.strategy, trade.timeframe
          ]);
        }
        console.log(`Synced ${trades.length} trades for bot ${botInstanceId}`);
      } finally {
        client.release();
      }
      
      sqlite.close();
      resolve();
    });
  });
}

// Run sync for all bots
async function syncAll() {
  const pgPool = new Pool({ /* config */ });
  const botDirs = fs.readdirSync(BOT_INSTANCES_DIR);
  
  for (const dir of botDirs) {
    await syncBotTrades(dir, pgPool);
  }
  
  await pgPool.end();
}

syncAll().catch(console.error);
```

### 3.2 Schedule Sync via Cron

Add to systemd timer or crontab:
```bash
# Run every 5 minutes
*/5 * * * * cd /root/crypto-trading-platform && node scripts/sync-sqlite-to-postgres.js >> /var/log/sqlite-sync.log 2>&1
```

---

## Phase 4: MongoDB → PostgreSQL Migration

### 4.1 Export MongoDB Data

```bash
# Export users
mongoexport --uri="$MONGO_URI" --collection=users --out=users.json

# Export portfolio snapshots
mongoexport --uri="$MONGO_URI" --collection=portfoliosnapshots --out=snapshots.json
```

### 4.2 Import to PostgreSQL

```javascript
// scripts/migrate-mongo-to-postgres.js
const fs = require('fs');
const { Pool } = require('pg');

const pgPool = new Pool({ /* config */ });

async function migrateUsers() {
  const users = JSON.parse(fs.readFileSync('users.json', 'utf-8'));
  
  for (const user of users) {
    await pgPool.query(`
      INSERT INTO users (email, firebase_uid, name, role, paper_balance, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO NOTHING
    `, [
      user.email,
      user.firebaseUid || user.firebase_uid,
      user.name,
      user.role || 'user',
      user.paperBalance || 10000,
      user.createdAt || new Date()
    ]);
  }
  
  console.log(`Migrated ${users.length} users`);
}

async function migrateSnapshots() {
  const snapshots = JSON.parse(fs.readFileSync('snapshots.json', 'utf-8'));
  
  for (const snap of snapshots) {
    await pgPool.query(`
      INSERT INTO portfolio_snapshots (user_id, total_value, data, timeframe, recorded_at)
      VALUES (
        (SELECT id FROM users WHERE firebase_uid = $1),
        $2, $3, $4, $5
      )
    `, [
      snap.userId,
      snap.totalValue || snap.equity,
      JSON.stringify(snap.data || snap),
      snap.timeframe || 'adhoc',
      snap.timestamp || snap.createdAt
    ]);
  }
  
  console.log(`Migrated ${snapshots.length} snapshots`);
}

migrateUsers()
  .then(migrateSnapshots)
  .then(() => pgPool.end())
  .catch(console.error);
```

---

## Phase 5: Turso Activation

### 5.1 Install Turso CLI

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
```

### 5.2 Create Turso Database per Bot

```bash
# Create a database for a bot
turso db create bot-<user_id>-<instance_id> --group default

# Get connection URL
turso db show bot-<user_id>-<instance_id> --url

# Create auth token
turso db tokens create bot-<user_id>-<instance_id>
```

### 5.3 Configure Sync

Add to bot config or `.env`:
```bash
TURSO_API_KEY=<your-turso-api-key>
TURSO_ORG=<your-turso-org>
```

The existing `local-to-turso-sync-optimized.py` script handles:
- Incremental sync using MD5 hashes
- Table-specific sync order
- Metadata tracking in `.sync_metadata` files

### 5.4 Enable Sync per Bot

```bash
# Create sync config for bot
cat > /root/crypto-trading-platform/data/bot-instances/<instance_id>/sync-config.json << EOF
{
  "tursoUrl": "libsql://bot-<user_id>-<instance_id>-<org>.turso.io",
  "tursoToken": "<token>",
  "enabled": true,
  "lastSync": null
}
EOF
```

---

## Phase 6: Cutover Checklist

### Before Cutover
- [ ] All MongoDB data exported and imported to PostgreSQL
- [ ] Dual-write running for 1+ week with no errors
- [ ] Data consistency verified (counts match)
- [ ] Read queries tested against PostgreSQL
- [ ] Turso sync active for all bots
- [ ] Backup of MongoDB taken

### Cutover Steps
1. Stop API services: `sudo systemctl stop api-gateway bot-orchestrator`
2. Final MongoDB export
3. Import any new data to PostgreSQL
4. Update API to read from PostgreSQL
5. Remove dual-write (optional, can keep as fallback)
6. Restart services
7. Monitor for errors

### Rollback Plan
If issues occur:
1. Revert API code to read from MongoDB
2. Restart services
3. Investigate PostgreSQL issues
4. Re-sync data if needed

---

## Monitoring

### PostgreSQL Health Check
```sql
-- Check connection count
SELECT count(*) FROM pg_stat_activity;

-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Check sync lag
SELECT bot_id, MAX(synced_at) as last_sync
FROM trades_aggregated
GROUP BY bot_id;
```

### Add to Health Endpoint
```javascript
app.get('/health', async (req, res) => {
  const pgHealth = await pg.query('SELECT 1').then(() => 'ok').catch(() => 'error');
  const mongoHealth = await mongoose.connection.db.admin().ping().then(() => 'ok').catch(() => 'error');
  
  res.json({
    status: 'ok',
    postgres: pgHealth,
    mongodb: mongoHealth,
    timestamp: new Date().toISOString()
  });
});
```
