# Development Environment Setup Guide

This guide explains how to set up a local development environment that seamlessly deploys to production via the CI/CD pipeline.

## 🎯 Goal

Work locally on your machine, push to `main` branch, and changes automatically deploy to production VPS without any manual path/env adjustments.

---

## 📋 Prerequisites

1. **Node.js 20+** - `nvm install 20 && nvm use 20`
2. **Git** - Configured with access to the repository
3. **Docker** (optional) - For testing FreqTrade containers locally
4. **MongoDB** - Atlas account or local MongoDB instance

---

## 🚀 Local Development Setup

### 1. Clone the Repository

```bash
git clone https://github.com/Git-Ansh/crypto-trading-platform.git
cd crypto-trading-platform
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create Local Environment Files

Create these files for local development (they're gitignored):

#### `apps/api-gateway/.env.local`
```dotenv
# Local Development - API Gateway
NODE_ENV=development
PORT=5001

# MongoDB (use your own Atlas URI or local MongoDB)
MONGO_URI=mongodb://localhost:27017/crypto-pilot-dev

# JWT Secret (any random string for dev)
JWT_SECRET=dev-secret-change-me-in-production
ENCRYPTION_KEY=dev-encryption-key-change-me

# Firebase (copy from Firebase Console)
FIREBASE_PROJECT_ID=crypto-pilot-b2376
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@crypto-pilot-b2376.iam.gserviceaccount.com
# Use the serviceAccountKey.json file instead of env var for private key

# Bot Manager URL (local)
BOT_MANAGER_URL=http://localhost:5000

# CORS - allow localhost for dev
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5000

# Strategy directory
MAIN_STRATEGIES_SOURCE_DIR=./data/strategies
```

#### `apps/bot-orchestrator/.env.local`
```dotenv
# Local Development - Bot Orchestrator
NODE_ENV=development
PORT=5000

# Bot Configuration (relative paths work locally)
BOT_BASE_DIR=./data/bot-instances
FREQTRADE_IMAGE=freqtradeorg/freqtrade:stable
MAIN_STRATEGIES_SOURCE_DIR=./data/strategies
SHARED_DATA_DIR=./data/shared-market-data

# Security
JWT_SECRET=dev-secret-change-me-in-production

# Firebase
FIREBASE_PROJECT_ID=crypto-pilot-b2376

# CORS (local)
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5000

# Turso disabled locally
TURSO_ENABLED=false

# Pool Mode (disable for simpler local dev)
POOL_MODE_ENABLED=false
```

#### `apps/web/.env.local`
```dotenv
# Local Development - Frontend
VITE_API_URL=http://localhost:5001
VITE_CLIENT_URL=http://localhost:5173

# Firebase (same as production)
VITE_FIREBASE_API_KEY=AIzaSyBll_aSAVxUI8zTgAYnJNKBdakbsmLL5Tw
VITE_FIREBASE_AUTH_DOMAIN=crypto-pilot-b2376.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=crypto-pilot-b2376
VITE_FIREBASE_STORAGE_BUCKET=crypto-pilot-b2376.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=848560759066
VITE_FIREBASE_APP_ID=1:848560759066:web:090ad2af07851554774ca3
```

### 4. Start Development Servers

```bash
# Terminal 1: Start API Gateway
cd apps/api-gateway && node index.js

# Terminal 2: Start Bot Orchestrator  
cd apps/bot-orchestrator && node index.js

# Terminal 3: Start Frontend (Vite)
cd apps/web && npm run dev
```

Or use the npm scripts:
```bash
# From root directory
npm run dev:web      # Frontend on :5173
npm run dev:api      # API Gateway on :5001  
npm run dev:bot      # Bot Orchestrator on :5000
```

---

## 🔄 CI/CD Workflow

### How It Works

1. **You push to `main`** branch
2. **GitHub Actions** triggers the deploy workflow
3. **VPS receives** the changes via SSH
4. **Services restart** automatically
5. **Vercel deploys** the frontend (separately)

### Required GitHub Secrets

Go to: `https://github.com/Git-Ansh/crypto-trading-platform/settings/secrets/actions`

Add these secrets:
| Secret | Value |
|--------|-------|
| `VPS_HOST` | `158.69.217.249` |
| `VPS_USER` | `ubuntu` |
| `VPS_SSH_KEY` | Your SSH private key content |
| `VPS_SSH_PORT` | `22` (optional) |

### Testing Before Push

```bash
# Build packages to catch type errors
npm run build:packages

# Run linting
npm run lint

# Test the frontend build
cd apps/web && npm run build
```

---

## 🏗️ Architecture: Dev vs Production

### Environment Detection

The codebase automatically detects the environment:

```javascript
// Frontend (Vite)
const isProduction = import.meta.env.PROD;  // true in production build

// Backend (Node.js)
const isProduction = process.env.NODE_ENV === 'production';
```

### Key Differences

| Feature | Development | Production |
|---------|-------------|------------|
| API URL | `localhost:5001` | `api.crypto-pilot.dev` |
| WebSocket | `ws://localhost:5000` | `wss://api.crypto-pilot.dev` |
| CORS Origins | `localhost:*` | `crypto-pilot.dev,www.crypto-pilot.dev` |
| Path Prefix | `./data/...` (relative) | `/home/ubuntu/Workspace/...` (absolute) |
| Pool Mode | Disabled | Enabled |
| Turso Backup | Disabled | Optional |

### Path Resolution Strategy

The code uses environment variables with fallbacks that work in both environments:

```javascript
// In production: BOT_BASE_DIR is set to absolute path via .env.production
// In development: Uses relative path fallback
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || './data/bot-instances';
```

---

## 📁 File Structure for Environment Configs

```
apps/
├── api-gateway/
│   ├── .env                    # Loaded in production (systemd)
│   ├── .env.production         # Production config (committed)
│   ├── .env.systemd            # Systemd-specific (symlink from .env)
│   ├── .env.local              # YOUR local config (gitignored)
│   └── serviceAccountKey.json  # Firebase credentials
│
├── bot-orchestrator/
│   ├── .env                    # Loaded in production
│   ├── .env.production         # Production config (committed)
│   ├── .env.local              # YOUR local config (gitignored)
│   └── serviceAccountKey.json  # Firebase credentials
│
└── web/
    ├── .env.production         # Production (Vercel)
    ├── .env.local              # YOUR local config (gitignored)
    └── src/lib/config.ts       # Runtime config detection
```

---

## 🔐 Firebase Setup

### Getting Service Account Key

1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Save as `serviceAccountKey.json` in:
   - `apps/api-gateway/serviceAccountKey.json`
   - `apps/bot-orchestrator/serviceAccountKey.json`

Both files are gitignored and already exist on the VPS.

---

## 🐳 Docker (Optional for Local Dev)

If you want to test FreqTrade pools locally:

```bash
# Build the pool image
cd apps/bot-orchestrator/docker/pool
./build.sh

# Enable pool mode in .env.local
POOL_MODE_ENABLED=true
POOL_IMAGE=freqtrade-pool:latest
MAX_BOTS_PER_CONTAINER=3
```

---

## 🧪 Testing Your Changes

### Before Committing

1. **Lint check:**
   ```bash
   npm run lint
   ```

2. **Type check (packages):**
   ```bash
   npm run build:packages
   ```

3. **Frontend build test:**
   ```bash
   cd apps/web && npm run build
   ```

### After Pushing to Main

1. Check GitHub Actions: `https://github.com/Git-Ansh/crypto-trading-platform/actions`
2. Verify VPS services:
   ```bash
   ssh ubuntu@158.69.217.249
   sudo systemctl status api-gateway bot-orchestrator
   ```
3. Check production health:
   ```bash
   curl https://api.crypto-pilot.dev/api/health
   ```

---

## 🚨 Common Issues

### "CORS blocked" in development
- Ensure `ALLOWED_ORIGINS` includes `http://localhost:5173`
- Check if you're hitting the right port (5001 for API, 5000 for Bot Orchestrator)

### "Firebase app does not exist"
- Ensure `serviceAccountKey.json` exists in the app directory
- The file must be valid JSON from Firebase Console

### "Docker: No such container"
- Pools may need to be recreated: restart bot-orchestrator
- Check `docker ps` to see running containers

### Changes not appearing in production
- Wait for Vercel to deploy (frontend ~2-3 min)
- Check GitHub Actions for backend deploy status
- Run `sudo systemctl restart api-gateway bot-orchestrator` manually if needed

---

## 📝 Development Workflow Summary

```
1. Create feature branch (optional):     git checkout -b feature/my-change
2. Make your changes locally
3. Test locally:                         npm run dev:web (etc.)
4. Build check:                          npm run build:packages
5. Commit:                               git add . && git commit -m "feat: ..."
6. Push to main:                         git push origin main
7. Watch:                                - GitHub Actions (backend)
                                         - Vercel Dashboard (frontend)
8. Verify:                               curl https://api.crypto-pilot.dev/api/health
```

---

## 🎉 You're Ready!

With this setup:
- ✅ Code works locally with `.env.local` files
- ✅ Same code works in production with `.env.production` files  
- ✅ Push to `main` triggers auto-deployment
- ✅ No manual path or CORS changes needed between environments
