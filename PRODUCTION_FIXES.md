# Production Deployment - January 9, 2026

## Issues Fixed

### 1. Service Crashes Due to Path Issues
**Problem**: Services were crashing because `.env` files contained `/root/crypto-trading-platform/` paths but the actual location is `/home/ubuntu/Workspace/crypto-trading-platform/`.

**Fixed**:
- Updated all `.env` files in `apps/api-gateway` and `apps/bot-orchestrator`
- Fixed hardcoded fallback paths in 8 JS files to use relative paths
- Updated systemd service files in `infrastructure/systemd/`

### 2. Firebase Authentication Failure
**Problem**: Firebase Admin SDK was not initializing because:
- `.env.systemd` didn't have `FIREBASE_PRIVATE_KEY` 
- Systemd environment files can't handle multi-line values properly

**Fixed**:
- Modified `apps/api-gateway/index.js` to load from `serviceAccountKey.json` first (production)
- Falls back to environment variables for Vercel/other platforms
- Removed complex multi-line private key from `.env.systemd`

### 3. Development Artifacts in Production
**Removed**:
- `dev-servers.sh` (dev-only script)
- `test-integration.sh` (referenced dev paths)
- `.env.development` files
- `.env.systemd.template` files with wrong paths
- `localhost` origins from `ALLOWED_ORIGINS`
- `ALLOW_DEV_ORIGINS=true` flag

## Current Status

✅ **api-gateway**: Running on port 5001, Firebase authenticated
✅ **bot-orchestrator**: Running on port 5000
✅ **Frontend**: Deployed on Vercel, should now authenticate successfully

## GitHub Actions Auto-Deploy

Workflow created at `.github/workflows/deploy.yml`:
- Triggers on push to `main` branch
- SSH into VPS, pulls latest code
- Installs dependencies and builds packages
- Restarts systemd services
- Verifies health endpoints

**Required GitHub Secrets**:
```
VPS_HOST=<your-vps-ip>
VPS_USER=ubuntu
VPS_SSH_KEY=<private-ssh-key>
VPS_SSH_PORT=22
```

## Manual Deployment

```bash
# On VPS
cd /home/ubuntu/Workspace/crypto-trading-platform
./deploy.sh
```

## Service Management

```bash
# View logs
sudo journalctl -u api-gateway -f
sudo journalctl -u bot-orchestrator -f

# Restart services
sudo systemctl restart api-gateway bot-orchestrator

# Check status
sudo systemctl status api-gateway bot-orchestrator
```

## Health Checks

```bash
curl http://localhost:5001/api/health
curl http://localhost:5000/api/health
```
