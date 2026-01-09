# Crypto Trading Platform — AI Coding Instructions

Purpose: make AI agents immediately productive by documenting the actual architecture, workflows, and project-specific conventions in this monorepo.

## Big Picture
- Monorepo (Nx + npm workspaces) with three services: web (Vercel), api-gateway (5001), bot-orchestrator (5000).
- Data flow: Browser → API Gateway → Bot Orchestrator → FreqTrade Docker (8100+). See [apps/api-gateway/index.js](apps/api-gateway/index.js) and [apps/bot-orchestrator/index.js](apps/bot-orchestrator/index.js).
- Shared packages: [packages/shared-types](packages/shared-types), [packages/shared-config](packages/shared-config), [packages/shared-auth](packages/shared-auth), [packages/shared-utils](packages/shared-utils). Build first when running services.

## Production Workflow
- Deploy: push to `main` branch triggers GitHub Actions workflow (`.github/workflows/deploy.yml`).
- Manual deploy: run `./deploy.sh` on VPS (builds packages, restarts systemd services).
- Logs: `sudo journalctl -u api-gateway -f`, `sudo journalctl -u bot-orchestrator -f`.
- Service management: `sudo systemctl restart api-gateway bot-orchestrator`.

## Conventions That Matter
- Auth: Primary Firebase (`firebase-admin`) with JWKS fallback; bot routes use `authenticateToken`, `authorize(['admin'])`, and `checkInstanceOwnership` (see [apps/bot-orchestrator/auth.js](apps/bot-orchestrator/auth.js)).
- CORS: Allowed origins defined in `.env` (`ALLOWED_ORIGINS`), production-only domains.
- Rate limiting: Strict in production via middleware.
- Env files: `.env.systemd` / `.env.production` in each app folder (symlinked to `.env`).
- Required env: `FIREBASE_PROJECT_ID`, `JWT_SECRET`, `MONGO_URI`. Optional: `POOL_MODE_ENABLED`.

## Bot Pool System
- Multi-tenant FreqTrade container pool under [apps/bot-orchestrator/lib](apps/bot-orchestrator/lib): `pool-integration.js`, `container-pool.js`, `bot-container-mapper.js`, `pool-health-monitor.js`.
- Enable via `POOL_MODE_ENABLED=true`. Health checks: [scripts/pool-health-check.sh](scripts/pool-health-check.sh).

## Cross-Component Patterns
- API Gateway proxies/coordinates requests and applies CORS, auth verification, and rate limits.
- Bot Orchestrator handles bot lifecycle, strategy sync, and proxies authenticated calls to FreqTrade.
- Web app (Vercel) consumes gateway endpoints with axios token interceptors.

## Production Deploy
- Use [deploy.sh](deploy.sh): enforces Node 20+, runs `npm ci`, builds packages, restarts systemd services.
- Service definitions in [infrastructure/systemd](infrastructure/systemd). Ports: 5001 (gateway), 5000 (bot).
- GitHub Actions auto-deploys on push to main.

## Pitfalls & Fixes
- Shared types not found → run `npm run build:packages` before build.
- Firebase auth failures → ensure `serviceAccountKey.json` exists in service folders.
- CORS blocked → verify `ALLOWED_ORIGINS` in `.env` for production domains.
- Bot not responding → check pool health; see [apps/bot-orchestrator/lib/POOL_SYSTEM_README.md](apps/bot-orchestrator/lib/POOL_SYSTEM_README.md).

## Example (Auth in Bot Orchestrator)
```js
// In routes: always gate with authenticateToken
app.get('/api/endpoint', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  // business logic
  res.json({ ok: true });
});
```
