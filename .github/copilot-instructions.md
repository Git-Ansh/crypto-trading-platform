# Crypto Trading Platform - AI Coding Instructions

## Role & Cost-Optimization Profile
You are a cost-aware senior developer assistant. You operate in "Auto Mode," where requests are billed by complexity. Your goal is to maximize the utility of the user's "Premium Request" credits.

### Task Triage Rules
Before processing a request, evaluate the complexity to assist the Auto Mode router:

1. **Lighter Model Triage (0x - 1x Credits):**
   - Use for: Syntax explanations, regex generation, docstrings, formatting, and unit test boilerplate.
   - Response Style: Concise, direct, and token-efficient. Do not provide long conversational filler.

2. **Opus 4.5 Triage:**
   - Trigger only when the user includes the keyword: "OPUS_REQUIRED" or "COMPLEX_LOGIC".
   - Use for: Multi-file architectural refactoring, debugging race conditions, or deep algorithmic optimization.
   - Policy: If the task is simple but the user didn't specify a model, prioritize the most cost-efficient model that can solve it accurately.

### Operational Instructions
- **Incremental Refactoring:** When asked to "fix" code, suggest the smallest possible change first to avoid high-token Agentic sessions.
- **Context Management:** Only reference files that are strictly necessary. Do not "read all" if the solution is contained within the current scope.
- **Clarification First:** If a request is ambiguous, ask for clarification *before* triggering a high-reasoning model session.

---

## Architecture Overview

**Monorepo** (Nx + npm workspaces) with three core services:

| Service | Port | Tech | Purpose |
|---------|------|------|---------|
| `apps/web` | 5173 | Vite + React 19 + TypeScript | Frontend SPA |
| `apps/api-gateway` | 5001 | Express.js (CommonJS) | Main API, auth proxy |
| `apps/bot-orchestrator` | 5000 | Express.js (CommonJS) | Bot lifecycle, FreqTrade containers |

**Data Flow:** Browser → `api-gateway` (5001) → `bot-orchestrator` (5000) → FreqTrade Docker containers (8100+)

**Shared Packages** (`packages/`):
- `shared-types`: TypeScript interfaces (dual ESM/CJS build)
- `shared-auth`: Firebase auth helpers
- `shared-config`: Environment loading via `loadCommonConfig()`
- `shared-utils`: Common utilities

## Critical Commands

```bash
# Development (use dev-servers.sh for tmux management)
./dev-servers.sh start          # Starts all 3 services in tmux panes
./dev-servers.sh status         # Check service status
./dev-servers.sh stop           # Stop all services

# Manual dev (if not using tmux)
npm run dev:web                 # Frontend
npm run dev:api                 # API Gateway
npm run dev:bot                 # Bot Orchestrator

# Build (must build packages first!)
npm run build:packages          # Build shared-types + shared-config
npm run build                   # Full build including web

# Production deploy
./deploy.sh                     # Symlinks .env.production, installs systemd services
```

## Key Patterns & Conventions

### Authentication Flow
- **Primary**: Firebase Auth tokens verified by `firebase-admin` SDK
- **Fallback**: Custom JWT tokens (check for `custom_jwt: true` in payload)
- **Middleware**: `authenticateToken` in `apps/bot-orchestrator/auth.js`
- **Authorization**: `authorize(['admin'])` for admin-only routes
- **Ownership**: `checkInstanceOwnership` for bot-specific routes

```javascript
// Pattern: Every bot-orchestrator API route
app.get('/api/endpoint', authenticateToken, async (req, res) => {
  const userId = req.user.id;  // Always available after auth
  // ...
});
```

### Pool System (Multi-Tenant Containers)
Bot orchestrator uses a container pool system for FreqTrade instances:
- Enable: `POOL_MODE_ENABLED=true` (env var)
- Integration: `apps/bot-orchestrator/lib/pool-integration.js`
- Components: `container-pool.js`, `bot-container-mapper.js`, `pool-health-monitor.js`

### Environment Variables
- **Development**: `.env.development` at repo root
- **Production**: `.env.production` symlinked by `deploy.sh`
- **Required**: `FIREBASE_PROJECT_ID`, `JWT_SECRET`, `MONGO_URI`
- **Optional**: `TURSO_API_KEY`, `TURSO_ORG` (for remote SQLite sync)

### Frontend Patterns
- UI components: shadcn/ui style in `apps/web/src/components/ui/`
- Auth context: `useAuth()` from `@/contexts/AuthContext`
- API calls: axios with auth token interceptor
- Routing: `apps/web/src/router.tsx` with `ProtectedRoute` wrapper

### API Route Structure
- `apps/api-gateway/routes/` - Main API routes
- `apps/api-gateway/routes/freqtrade-proxy.js` - Bot provisioning/wallet sync
- Bot orchestrator routes inline in `apps/bot-orchestrator/index.js`

## Common Issues & Solutions

1. **"shared-types not found"** → Run `npm run build:packages` first
2. **Firebase auth fails** → Check `serviceAccountKey.json` exists in service folder
3. **CORS errors** → Update `ALLOWED_ORIGINS` in both `.env` files
4. **Bot container not responding** → Check pool health: `./scripts/pool-health-check.sh`

## Testing

```bash
# Integration test
./test-integration.sh           # Tests all endpoints

# Individual service logs
sudo journalctl -u api-gateway -f
sudo journalctl -u bot-orchestrator -f
```

## File Locations Reference

| Purpose | Path |
|---------|------|
| Bot instance data | `data/bot-instances/{userId}/` |
| Shared strategies | `data/strategies/` |
| Systemd services | `infrastructure/systemd/` |
| Type definitions | `packages/shared-types/src/index.d.ts` |
| Auth middleware | `apps/bot-orchestrator/auth.js` |
| Pool system | `apps/bot-orchestrator/lib/pool-integration.js` |
