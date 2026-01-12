# Crypto Trading Platform — AI Coding Instructions

Purpose: Enable AI agents to be immediately productive by documenting the actual architecture, developer workflows, and project-specific patterns that differ from common practices.

## Architecture Overview

**Nx monorepo** (Node 20+) with npm workspaces containing:
- **web**: React 19 + Vite frontend (Vercel-deployed, port 5173 dev)
- **api-gateway**: Express.js reverse proxy (port 5001)
- **bot-orchestrator**: Bot lifecycle manager (port 5000)
- **packages**: Shared types, auth, config, utils (published internally)

**Data flow**: Browser → API Gateway (auth, CORS, routing) → Bot Orchestrator (stateless bot commands) → FreqTrade pool containers (8100+)

## Critical Architecture: Multi-Tenant Container Pool System

**Why this matters**: Baseline was 500MB+ per bot (one container each). Pool system reduces to ~100MB/bot by running up to 10 bots per Docker container.

**Key files**: [lib/container-pool.js](apps/bot-orchestrator/lib/container-pool.js), [lib/pool-integration.js](apps/bot-orchestrator/lib/pool-integration.js), [lib/bot-container-mapper.js](apps/bot-orchestrator/lib/bot-container-mapper.js)

**How it works**:
- Each user owns isolated pool containers named `{userId}-pool-N` (e.g., `Js1Gaz4s...2-pool-1`)
- Stored in `data/bot-instances/{userId}/{userId}-pool-N/` with Supervisor process manager inside
- Each bot gets its own FreqTrade process, SQLite DB, port (e.g., 8100, 8101, 8102 in one container)
- Bots are isolated by process; container is just the resource boundary

**Integration in code** (inside bot-orchestrator routes):
```javascript
// Get connection URL (handles pool or legacy mode)
const url = await getPoolAwareBotUrl(instanceId);

// Check if pooled
if (isInstancePooled(instanceId)) { /* use pool URL */ }

// Provision bot to pool
const slot = await poolProvisioner.allocateBotSlot(instanceId, userId, config);
```

**Graceful fallback**: If `POOL_MODE_ENABLED=false` or pool initialization fails, system auto-falls back to legacy one-container-per-bot mode. No code changes needed.

## Authentication Pattern: Firebase → JWT

**Two-step flow** (cross-service stateless design):
1. Frontend sends Firebase ID token in `Authorization: Bearer {firebaseToken}`
2. API Gateway verifies token with Firebase Admin SDK, extracts `user.id`, issues JWT
3. Bot Orchestrator validates JWT (no Firebase call needed) to get user context

**Key files**: [apps/api-gateway/middleware/auth.js](apps/api-gateway/middleware/auth.js)

**Bot Orchestrator routes always follow this pattern**:
```javascript
app.get('/api/endpoint/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  const userId = req.user.id;      // Extracted from JWT
  const instanceDir = req.instanceDir; // Middleware sets this
  // ... logic
});
```

**Important**: Bot Orchestrator has **no MongoDB connection** (intentionally stateless). API Gateway holds user data.

## Universal Features: Dynamic Per-Bot Enhancements

**What it is**: Runtime feature system that intercepts FreqTrade API calls to apply take-profit, trailing-stop, position-limits, correlation-hedging without modifying the bot's actual strategy.

**Key files**: [universal-features.js](apps/bot-orchestrator/universal-features.js), [active-trade-monitor.js](apps/bot-orchestrator/active-trade-monitor.js), [freqtrade-api-interceptor.js](apps/bot-orchestrator/freqtrade-api-interceptor.js)

**How to extend**: Features stored in `{instanceDir}/user_data/universal_features/` as JSON. The interceptor reads config and patches trade requests/responses on-the-fly. Add new feature to `DEFAULT_FEATURES` in [universal-features.js](apps/bot-orchestrator/universal-features.js) and hook into `apiInterceptor.interceptResponse()`.

## Development Workflow

**One-time setup**:
```bash
npm ci && npm run build:packages   # Shared packages must be built first
```

**Start all services** (uses tmux for session management):
```bash
./dev-servers.sh start            # Starts web, api-gateway, bot-orchestrator
./dev-servers.sh status           # Check if all running
./dev-servers.sh logs bot         # Tail bot-orchestrator logs
./dev-servers.sh stop             # Stop all services
```

**Or start individually**:
```bash
npm run dev:web                   # Port 5174 (Vite)
npm run dev:api                   # Port 5001
npm run dev:bot                   # Port 5000
```

### Running in WSL (Windows Subsystem for Linux)

**Key difference**: When running in WSL, dev servers bind to WSL's localhost, not Windows. To access from your Windows browser:

1. **Get WSL's IP address**:
   ```bash
   hostname -I | awk '{print $1}'  # Example: 192.168.52.65
   ```

2. **Access services via WSL IP** (instead of localhost):
   - Frontend: `http://192.168.52.65:5174` (Vite dev server, not 5173)
   - API Gateway: `http://192.168.52.65:5001`
   - Bot Orchestrator: `http://192.168.52.65:5000`

3. **CORS is already configured**: Development mode allows all origins, so no additional config needed. The API Gateway will accept requests from the Windows browser.

**Environment files** (loaded from repo root or `.env.{NODE_ENV}`):
- `.env.development` → used when `NODE_ENV=development`
- `.env.production` → used when `NODE_ENV=production` (fallback to `.env`)
- **Required**: `FIREBASE_PROJECT_ID`, `JWT_SECRET`, `MONGO_URI` (API Gateway only)
- **Optional**: `POOL_MODE_ENABLED=true`, `TURSO_API_KEY`, `ALLOWED_ORIGINS`

## Production Deployment

**Via script** (runs on VPS):
```bash
./deploy.sh                       # Checks Node 20+, runs npm ci, builds packages, restarts systemd
```

**Via GitHub Actions**: Push to `main` triggers automated deployment.

**Service management**:
```bash
sudo systemctl restart api-gateway bot-orchestrator
sudo journalctl -u bot-orchestrator -f              # Stream logs
sudo systemctl status api-gateway                   # Check status
```

**Service definitions**: [infrastructure/systemd](infrastructure/systemd)

## Code Organization Principles

**Shared packages pattern** (must be built before services run):
- All cross-service code lives in [packages/](packages/) and published as `@crypto-trading-platform/*`
- Reference in code: `require('@crypto-trading-platform/shared-types')`, `require('@crypto-trading-platform/shared-config')`
- When shared code changes, rebuild: `npm run build:packages`

**Instance ownership middleware** (every route with `:instanceId` must use):
```javascript
async function checkInstanceOwnership(req, res, next) {
  const { instanceId } = req.params;
  const userId = req.user.id;
  const instanceDir = path.join(BOT_BASE_DIR, userId, instanceId);
  // Verify path exists and belongs to user
  if (!await fs.pathExists(instanceDir)) return res.status(403).json({ error: 'forbidden' });
  req.instanceDir = instanceDir; // Middleware sets this for route handler
  next();
}
```

**Error handling** (no catch-alls):
- Firebase verification failures → `401 Unauthorized`
- Instance ownership check failures → `403 Forbidden`
- Pool system errors → catch and fall back to legacy mode (don't crash service)
- Validate input with `express-validator` before business logic

## Integration Points & External Dependencies

| Component | Purpose | Location |
|-----------|---------|----------|
| **FreqTrade containers** | Trading bot instances | Docker, ports 8100+ (pooled) |
| **Firebase Admin SDK** | Auth token verification | API Gateway |
| **MongoDB/Mongoose** | User profiles, configs | API Gateway only |
| **Supervisor** (in pool container) | Multi-bot process manager | Inside FreqTrade pool image |
| **PostHog** | Optional analytics | Enabled if `POSTHOG_API_KEY` env var set |

## Common Pitfalls & Fixes

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Module not found `@crypto-trading-platform/*` | Shared packages not built | Run `npm run build:packages` before dev/build |
| Pool container fails to start | Pool mode incompatibility or Docker issue | Check `POOL_MODE_ENABLED` env; system auto-falls back to legacy mode |
| Instance ownership check fails in logs | JWT `user.id` doesn't match bot directory | Verify bot was created by same Firebase user; check JWT payload |
| FreqTrade API returns 500 | Bot not running or connection stale | Check pool/container status: `docker ps`, `docker exec {name} supervisorctl status` |
| CORS errors in frontend console | Browser origin not in `ALLOWED_ORIGINS` | Verify `ALLOWED_ORIGINS` env var matches dev/prod domain |
| Shared types out of sync after pull | Build artifact not updated | Rebuild: `npm run build:packages` |
| Pool health monitor spam in logs | Health check interval too aggressive | Check [lib/pool-health-monitor.js](apps/bot-orchestrator/lib/pool-health-monitor.js) `CHECK_INTERVAL` constant |

## Testing & Validation

```bash
npm run test                              # Run all tests
npm run precommit:check                   # Pre-commit validation (env + types)
npm run safety:check                      # Both env validation and precommit check
./scripts/pool-health-check.sh            # Check FreqTrade pool container health
```
