# Phase 2: Multi-Tenant Container Pool Architecture

## Summary

This PR implements the container pooling architecture as described in Phase 2 of the Implementation Plan. It replaces the one-container-per-bot architecture with a pooled container strategy, reducing memory usage by approximately 88%.

## Resource Savings

| Bots | Legacy Mode | Pool Mode | Savings |
|------|------------|-----------|---------|
| 10 | 10 × 500MB = 5GB | 1 × 600MB = 0.6GB | 88% |
| 30 | 30 × 500MB = 15GB | 3 × 600MB = 1.8GB | 88% |
| 50 | 50 × 500MB = 25GB | 5 × 600MB = 3GB | 88% |
| 100 | 100 × 500MB = 50GB | 10 × 600MB = 6GB | 88% |

## Changes

### New Files

| File | Description |
|------|-------------|
| `lib/container-pool.js` | Container pool management - creates, allocates, starts, stops pool containers |
| `lib/bot-container-mapper.js` | Maps bots to containers, supports both pooled and legacy modes |
| `lib/pool-health-monitor.js` | Monitors pool and bot health, auto-recovers failed bots |
| `lib/pool-integration.js` | Main integration module providing clean API |
| `lib/migrate-to-pool.js` | Migration script for transitioning existing bots |
| `lib/POOL_SYSTEM_README.md` | Comprehensive documentation |

### Modified Files

| File | Changes |
|------|---------|
| `index.js` | Pool system initialization, shutdown, API endpoints, pool-aware routing |
| `.env.systemd.template` | Added pool configuration variables |

## New API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pool/status` | GET | Get pool system status (admin only) |
| `/api/pool/health-check` | POST | Trigger manual health check (admin only) |
| `/api/pool/cleanup` | POST | Clean up empty pool containers (admin only) |
| `/api/pool/bot/:instanceId` | GET | Get specific bot's pool assignment |

## Configuration

New environment variables (all optional with defaults):

```bash
POOL_MODE_ENABLED=true          # Enable/disable pool mode
MAX_BOTS_PER_CONTAINER=10       # Max bots per pool container
POOL_BASE_PORT=9000             # Starting port for pools
HEALTH_CHECK_INTERVAL=30000     # Health check interval (ms)
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Pool Container 1                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                     Supervisord                         │ │
│  ├────────────────────────────────────────────────────────┤ │
│  │ FreqTrade Bot 1 │ Bot 2 │ Bot 3 │ ... │ Bot 10        │ │
│  │ (port 9000)     │(9001) │(9002) │     │(9009)          │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Backward Compatibility

- **Pool mode can be disabled** by setting `POOL_MODE_ENABLED=false`
- **Existing legacy bots continue working** without modification
- **Migration is optional** - new bots use pools, old bots stay in legacy
- **Automatic fallback** to legacy mode on pool errors

## Testing Checklist

- [ ] Pool container creation
- [ ] Bot provisioning in pool mode
- [ ] Bot start/stop in pool
- [ ] Bot deletion from pool
- [ ] Health monitoring and auto-recovery
- [ ] API endpoint responses
- [ ] Legacy mode fallback
- [ ] Migration script dry-run
- [ ] Pool cleanup

## Deployment Notes

1. After merging, restart the bot-orchestrator service
2. New bots will automatically use pool mode
3. Existing bots can be migrated using `node lib/migrate-to-pool.js --execute`
4. Monitor pool status via `/api/pool/status` endpoint

## Related Issues

Implements Phase 2 of the Architecture Modernization Plan.
