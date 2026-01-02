# Deployment Checklist (Vercel + VPS)

## Frontend (Vercel)
- Project root: monorepo root (`/root/crypto-trading-platform`)
- Build command: `npm run build --prefix apps/web`
- Output directory: `apps/web/dist`
- Install command: `npm install`
- Framework: `vite`
- Environment variables (Vercel):
  - `VITE_API_URL` = `https://<your-backend-domain>` (portless HTTPS)
  - `VITE_FREQTRADE_API_URL` = `https://<your-backend-domain>` (or 5000 if exposed)
  - `VITE_CLIENT_URL` = `https://<your-frontend-domain>`
  - `VITE_PUBLIC_POSTHOG_KEY` = `<posthog-public-key>`
  - `VITE_PUBLIC_POSTHOG_HOST` = `https://app.posthog.com` (or self-hosted)
  - Firebase keys as currently in `.env.development`
- Preview deployments: add preview URLs to backend `ALLOWED_ORIGINS`.

## Backend (VPS via systemd)
- Env file: `.env.production` at repo root, symlinked by `deploy.sh` to apps.
- CORS: set `ALLOWED_ORIGINS="https://<frontend-domain> https://<vercel-preview> http://localhost:5173"`.
- PostHog (optional): `POSTHOG_API_KEY`, `POSTHOG_HOST`.
- Services: `api-gateway` on 5001, `bot-orchestrator` on 5000.
- Deploy: `./deploy.sh` (installs deps, copies systemd units, restarts services).
- Logs: `sudo journalctl -u api-gateway -f`, `sudo journalctl -u bot-orchestrator -f`.

## Migrating to a new VPS
1) Copy repo to new host (`git clone` or rsync). 
2) Install Node 20+, Docker, Mongo/Postgres (as needed), and systemd enabled.
3) Place `.env.production` in repo root; run `./deploy.sh`.
4) Update DNS to point backend domain to new IP; update `ALLOWED_ORIGINS` if domains change.
5) Verify health: `curl http://localhost:5001/health`, `curl http://localhost:5000/health`.

## PostHog Integration
- Frontend: uses `VITE_PUBLIC_POSTHOG_KEY`/`VITE_PUBLIC_POSTHOG_HOST` (see `apps/web/src/main.tsx`).
- Backend: optional telemetry via `POSTHOG_API_KEY`/`POSTHOG_HOST`; set `ALLOWED_ORIGINS` for CORS.
- Disable by omitting `POSTHOG_API_KEY`.
