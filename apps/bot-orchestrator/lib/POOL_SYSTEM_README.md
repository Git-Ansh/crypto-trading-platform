# Phase 2: Multi-Tenant Container Pool System

## Overview

The Container Pool System replaces the one-container-per-bot architecture with a pooled container strategy, reducing memory usage by approximately 80%.

### Resource Savings

| Bots | Legacy Mode | Pool Mode | Savings |
|------|------------|-----------|---------|
| 10 | 10 × 500MB = 5GB | 1 × 600MB = 0.6GB | 88% |
| 30 | 30 × 500MB = 15GB | 3 × 600MB = 1.8GB | 88% |
| 50 | 50 × 500MB = 25GB | 5 × 600MB = 3GB | 88% |
| 100 | 100 × 500MB = 50GB | 10 × 600MB = 6GB | 88% |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Container Pool System                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────────────┐  ┌───────────────────────┐           │
│  │   Pool Container 1    │  │   Pool Container 2    │    ...    │
│  │  (freqtrade-pool-1)   │  │  (freqtrade-pool-2)   │           │
│  ├───────────────────────┤  ├───────────────────────┤           │
│  │  ┌─────────────────┐  │  │  ┌─────────────────┐  │           │
│  │  │ Supervisord     │  │  │  │ Supervisord     │  │           │
│  │  ├─────────────────┤  │  │  ├─────────────────┤  │           │
│  │  │ Bot 1 (port 9000)│  │  │  │ Bot 11(port 9010)│ │           │
│  │  │ Bot 2 (port 9001)│  │  │  │ Bot 12(port 9011)│ │           │
│  │  │ ...              │  │  │  │ ...              │ │           │
│  │  │ Bot 10(port 9009)│  │  │  │ Bot 20(port 9019)│ │           │
│  │  └─────────────────┘  │  │  └─────────────────┘  │           │
│  └───────────────────────┘  └───────────────────────┘           │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. ContainerPoolManager (`lib/container-pool.js`)

Manages the pool of Docker containers. Each container can handle up to 10 bots (configurable).

**Key Features:**
- Automatic pool container creation when capacity is needed
- Load balancing across pools
- State persistence to disk
- Metrics collection

### 2. BotContainerMapper (`lib/bot-container-mapper.js`)

Maps bot instances to their container assignments. Supports both pooled and legacy modes.

**Key Features:**
- Automatic fallback to legacy mode for non-pooled bots
- Connection info caching
- User bot discovery

### 3. PoolHealthMonitor (`lib/pool-health-monitor.js`)

Monitors the health of pool containers and individual bots.

**Key Features:**
- Periodic health checks (every 30s by default)
- Automatic restart of failed bots
- Container failure detection and recovery
- Event emission for monitoring integration

### 4. Pool Integration (`lib/pool-integration.js`)

Main integration module that ties everything together.

**Key Features:**
- Clean API for provisioning, starting, stopping, and deleting bots
- Pool-aware URL resolution for API proxying
- System-wide statistics

## Configuration

Add these environment variables to your `.env` file:

```bash
# Enable pool mode (default: true)
POOL_MODE_ENABLED=true

# Max bots per container (default: 10)
MAX_BOTS_PER_CONTAINER=10

# Starting port for pools (default: 9000)
POOL_BASE_PORT=9000

# Health check interval (default: 30000ms)
HEALTH_CHECK_INTERVAL=30000

# Bot ping timeout (default: 5000ms)
BOT_PING_TIMEOUT=5000

# Max restart attempts before cooldown (default: 3)
MAX_RESTART_ATTEMPTS=3

# Restart cooldown (default: 60000ms)
RESTART_COOLDOWN=60000
```

## API Endpoints

### Get Pool Status (Admin only)
```
GET /api/pool/status
Authorization: Bearer <token>

Response:
{
  "success": true,
  "poolMode": true,
  "totalPools": 2,
  "totalBots": 15,
  "pools": [
    {
      "id": "pool-1",
      "containerName": "freqtrade-pool-pool-1",
      "status": "running",
      "botsCount": 10,
      "capacity": 10,
      "utilizationPercent": 100,
      "bots": ["bot-1", "bot-2", ...]
    }
  ],
  "health": {
    "status": "healthy",
    "pools": { "total": 2, "healthy": 2, ... },
    "bots": { "total": 15, "healthy": 15, ... }
  }
}
```

### Trigger Health Check (Admin only)
```
POST /api/pool/health-check
Authorization: Bearer <token>

Response:
{
  "success": true,
  "timestamp": "2024-01-02T...",
  "pools": [...],
  "bots": [...],
  "issues": [],
  "recoveryActions": [],
  "durationMs": 1234
}
```

### Cleanup Empty Pools (Admin only)
```
POST /api/pool/cleanup
Authorization: Bearer <token>

Response:
{
  "success": true,
  "removedPools": 1,
  "message": "Cleaned up 1 empty pool containers"
}
```

### Get Bot Pool Info
```
GET /api/pool/bot/:instanceId
Authorization: Bearer <token>

Response:
{
  "success": true,
  "instanceId": "user-bot-1",
  "isPooled": true,
  "mode": "pooled",
  "connection": {
    "host": "freqtrade-pool-pool-1",
    "port": 9003,
    "url": "http://freqtrade-pool-pool-1:9003"
  }
}
```

## Migration

### From Legacy to Pool Mode

Use the migration script to migrate existing bots:

```bash
# Preview migration (no changes)
node lib/migrate-to-pool.js --dry-run

# Execute migration
node lib/migrate-to-pool.js --execute

# Check migration status
node lib/migrate-to-pool.js --status

# Rollback a specific bot
node lib/migrate-to-pool.js --rollback=bot-id

# Verbose output
node lib/migrate-to-pool.js --dry-run --verbose
```

### Migration Process

1. **Backup**: Creates backup of bot config
2. **Stop**: Stops legacy container if running
3. **Allocate**: Assigns bot to a pool container
4. **Start**: Starts bot in pool via supervisord
5. **Verify**: Pings bot API to confirm health
6. **Cleanup**: Removes legacy container

### Rollback

If a bot fails health check after migration, it automatically rolls back to the legacy container.

Manual rollback:
```bash
node lib/migrate-to-pool.js --rollback=bot-id
```

## How It Works

### Bot Provisioning Flow (Pool Mode)

1. User requests new bot via `/api/provision-enhanced`
2. `poolProvisioner.provisionBot()` is called
3. Bot directory structure is created (same as legacy)
4. Strategies are copied to bot directory
5. `poolManager.allocateBotSlot()` finds or creates a pool with capacity
6. Bot config is written with pool-specific paths
7. `poolManager.startBotInPool()` creates supervisord program config
8. Supervisord starts the FreqTrade process
9. Health monitor adds bot to monitoring queue

### API Request Routing (Pool Mode)

1. Request comes to `/api/bots/:instanceId/balance`
2. `getBotUrlByInstanceId()` is called
3. If pool mode enabled, checks `isInstancePooled(instanceId)`
4. If pooled, gets connection info from `getPoolAwareBotUrl()`
5. Proxies request to `http://pool-container:bot-port/api/v1/balance`

### Health Monitoring

1. Health monitor runs every 30 seconds
2. For each pool container:
   - Checks Docker container status
   - Checks supervisord status
   - Collects memory/CPU metrics
3. For each bot in pool:
   - Checks supervisor process status
   - Pings bot API
4. If unhealthy:
   - Attempts automatic restart via supervisord
   - Respects max restart attempts and cooldown
5. Emits health events for external monitoring

## Troubleshooting

### Bot Not Starting in Pool

1. Check supervisor logs:
   ```bash
   docker exec freqtrade-pool-pool-1 cat /var/log/supervisor/bot-<instanceId>.log
   ```

2. Check supervisor status:
   ```bash
   docker exec freqtrade-pool-pool-1 supervisorctl status
   ```

3. Verify bot config:
   ```bash
   docker exec freqtrade-pool-pool-1 cat /pool/bots/<instanceId>/config.json
   ```

### Pool Container Not Starting

1. Check Docker logs:
   ```bash
   docker logs freqtrade-pool-pool-1
   ```

2. Check compose file:
   ```bash
   cat /root/crypto-trading-platform/freqtrade-instances/.pools/pool-1/docker-compose.yml
   ```

### Health Check Failures

1. Check health summary:
   ```bash
   curl -H "Authorization: Bearer <token>" http://localhost:5000/api/pool/status
   ```

2. Trigger manual health check:
   ```bash
   curl -X POST -H "Authorization: Bearer <token>" http://localhost:5000/api/pool/health-check
   ```

## Disabling Pool Mode

To revert to legacy mode (one container per bot):

1. Set `POOL_MODE_ENABLED=false` in environment
2. Restart bot-orchestrator service
3. New bots will be provisioned in legacy mode
4. Existing pooled bots continue working

To fully migrate back to legacy:
```bash
# For each pooled bot:
node lib/migrate-to-pool.js --rollback=<bot-id>
```

## State Files

Pool system state is persisted to:
- Pool state: `$BOT_BASE_DIR/.container-pool-state.json`
- Migration log: `$BOT_BASE_DIR/.migration-log.json`

## Monitoring Integration

Health events can be consumed by adding listeners:

```javascript
const { getHealthMonitor } = require('./lib/pool-health-monitor');
const monitor = getHealthMonitor();

monitor.addListener((event) => {
  if (event.type === 'health_check_complete') {
    console.log(`Health check: ${event.issues.length} issues found`);
    // Send to monitoring system (Prometheus, Datadog, etc.)
  }
});
```
