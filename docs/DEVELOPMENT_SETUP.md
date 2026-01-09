# Development Environment Setup Guide

This guide explains how to set up a local development environment that seamlessly deploys to production via the CI/CD pipeline.

## 🚀 Quick Start (TL;DR)

```bash
# 1. Clone and install
git clone https://github.com/Git-Ansh/crypto-trading-platform.git
cd crypto-trading-platform
npm install

# 2. Create .env files (see section 3 below for content)
touch apps/api-gateway/.env
touch apps/bot-orchestrator/.env
touch apps/web/.env

# 3. Get Firebase credentials (see section 7 below)
# Download serviceAccountKey.json to both api-gateway/ and bot-orchestrator/

# 4. Start all servers
chmod +x dev-servers.sh
./dev-servers.sh start

# 5. Check status
./dev-servers.sh status

# 6. Open browser
# Frontend: http://localhost:5173
# API: http://localhost:5001/api/health
# Bot Manager: http://localhost:5000/api/health
```

**Important:** Use **relative paths** in your `.env` files (e.g., `../../data/bot-instances`), NOT absolute paths!

---

## ⚠️ Critical: Code Portability

**Good News:** The codebase is already designed to be portable! All path handling follows this pattern:

```javascript
// ✅ SAFE - Code checks environment variable first, then fallback
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '../../data/bot-instances');
```

**How It Works:**

1. **Development**: Your `.env` has `BOT_BASE_DIR=../../data/bot-instances`
   - Code reads from env var ✅
   - Works on your machine at any location

2. **Production**: VPS `.env.production` has `BOT_BASE_DIR=/home/ubuntu/Workspace/crypto-trading-platform/data/bot-instances`
   - Code reads from env var ✅
   - Works on production server

3. **Fallback**: If no env var exists, code uses relative path from `__dirname`
   - This ensures it works even without `.env` file
   - Fallback is always relative, never hardcoded absolute paths

**Why You Can Push Without Worry:**

```javascript
// ALL paths in the code look like this:
const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '../../data/bot-instances');
const STRATEGIES_DIR = process.env.MAIN_STRATEGIES_SOURCE_DIR || path.join(__dirname, '../../data/strategies');
const SHARED_DATA_DIR = process.env.SHARED_DATA_DIR || path.join(__dirname, '../../data/shared-market-data');

// ✅ No hardcoded absolute paths like:
// const BOT_BASE_DIR = '/home/ubuntu/Workspace/...'  // ❌ Would break on dev machine
```

**The Rule:**
- **`.env` files** are gitignored (never committed) - contain machine-specific paths
- **Code** always uses env vars or relative fallbacks (committed) - works everywhere

**Result:** Push code freely! Paths are resolved at runtime based on each machine's `.env` file.

---

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

**IMPORTANT:** The code loads `.env` files (not `.env.local`). Create these files in each app directory:

#### Environment File Strategy

| File | Purpose | Git Status | When to Use |
|------|---------|------------|-------------|
| `.env` | **Your personal dev config** | ✅ Gitignored | Create this for local development |
| `.env.production` | Production config | ❌ Committed | Reference only, DON'T modify |
| `.env.systemd` | Production symlink | ✅ Gitignored | Production only, ignore this |
| `serviceAccountKey.json` | Firebase credentials | ✅ Gitignored | Get from Firebase Console |

**What to do:**
1. ✅ Create `.env` files (see examples below)
2. ✅ Get `serviceAccountKey.json` from Firebase Console
3. ❌ **Never commit** `.env` or `serviceAccountKey.json`
4. ❌ **Don't modify** `.env.production` files

---

#### `apps/api-gateway/.env`
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

# Strategy directory (RELATIVE PATH - works from any location)
MAIN_STRATEGIES_SOURCE_DIR=../../data/strategies
```

#### `apps/bot-orchestrator/.env`
```dotenv
# Local Development - Bot Orchestrator
NODE_ENV=development
PORT=5000

# Bot Configuration (RELATIVE PATHS - work from any location)
BOT_BASE_DIR=../../data/bot-instances
FREQTRADE_IMAGE=freqtradeorg/freqtrade:stable
MAIN_STRATEGIES_SOURCE_DIR=../../data/strategies
SHARED_DATA_DIR=../../data/shared-market-data

# Security
JWT_SECRET=dev-secret-change-me-in-production

# Firebase
FIREBASE_PROJECT_ID=crypto-pilot-b2376

# CORS (local)
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5000

# Turso disabled locally
TURSO_ENABLED=false

# Pool Mode (enable if testing with Docker)
POOL_MODE_ENABLED=false
MAX_BOTS_PER_CONTAINER=3
POOL_BASE_PORT=9000
```

#### `apps/web/.env`
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

### 4. Get Firebase Service Account Keys

1. Go to [Firebase Console](https://console.firebase.google.com/) → Project Settings → Service Accounts
2. Click **"Generate new private key"**
3. Save the JSON file as:
   - `apps/api-gateway/serviceAccountKey.json`
   - `apps/bot-orchestrator/serviceAccountKey.json`

Both files are gitignored. **Never commit these files!**

---

### 5. Understanding Path Configuration

The codebase uses **relative paths** in development that resolve correctly regardless of where your project is cloned:

#### Path Strategy

```javascript
// ✅ CORRECT: Relative paths from app directory
BOT_BASE_DIR=../../data/bot-instances        // From apps/bot-orchestrator/
MAIN_STRATEGIES_SOURCE_DIR=../../data/strategies

// ❌ WRONG: Absolute paths (production-specific)
BOT_BASE_DIR=/home/ubuntu/Workspace/crypto-trading-platform/data/bot-instances

// 🔧 HOW IT WORKS:
// When running: cd apps/bot-orchestrator && node index.js
// The path ../../data/bot-instances resolves to:
//   apps/bot-orchestrator/../../data/bot-instances
//   = crypto-trading-platform/data/bot-instances ✅
```

#### Paths You Need to Set

All paths should be **relative to the app directory** where the service runs:

| Environment Variable | Value (from app dir) | Resolves To |
|---------------------|---------------------|-------------|
| `BOT_BASE_DIR` | `../../data/bot-instances` | `<project>/data/bot-instances` |
| `MAIN_STRATEGIES_SOURCE_DIR` | `../../data/strategies` | `<project>/data/strategies` |
| `SHARED_DATA_DIR` | `../../data/shared-market-data` | `<project>/data/shared-market-data` |

#### Why Relative Paths Work

```bash
# Developer on Mac:
/Users/jane/projects/crypto-trading-platform/

# Developer on Windows:
C:\Dev\crypto-trading-platform\

# Developer on Linux:
/home/john/workspace/crypto-trading-platform/

# ALL use same .env config:
BOT_BASE_DIR=../../data/bot-instances  # Works everywhere! 🎉
```

#### Production Uses Absolute Paths

On the VPS, systemd runs services from `/home/ubuntu/Workspace/crypto-trading-platform/apps/*`, so `.env.production` files use absolute paths. **Don't copy those to your `.env` files!**

---

### 6. Start Development Servers

Use the provided dev server control script:

```bash
# Make it executable (first time only)
chmod +x dev-servers.sh

# Start all servers
./dev-servers.sh start

# Check status
./dev-servers.sh status

# Stop all servers
./dev-servers.sh stop

# Restart all servers
./dev-servers.sh restart

# Control individual services
./dev-servers.sh start api       # Start API Gateway only
./dev-servers.sh stop web        # Stop frontend only
./dev-servers.sh restart bot     # Restart bot-orchestrator only

# View logs
./dev-servers.sh logs           # All services
./dev-servers.sh logs api       # API Gateway logs
```

**Or manually start each service:**

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

**Recommended:** Use the `dev-servers.sh` script for easier management.

---

## 🔍 Verify Your Setup is Portable

Run this quick check to ensure your code will work in production:

```bash
# 1. Check your .env files DON'T have absolute paths
cd crypto-trading-platform
grep -r "/home/\|/Users/\|C:\\\\" apps/*/.env && echo "❌ Found absolute paths!" || echo "✅ All paths are relative"

# 2. Check code doesn't have hardcoded paths (should return empty)
grep -r "const.*=.*['\"]/" apps/bot-orchestrator/*.js | grep -v "node_modules\|test\|//"

# 3. Verify environment variables are loaded
cd apps/bot-orchestrator && node -e "
require('dotenv').config({ path: '.env' });
console.log('BOT_BASE_DIR:', process.env.BOT_BASE_DIR);
console.log('Relative path?', !process.env.BOT_BASE_DIR.startsWith('/'));
"

# 4. Test path resolution
node -e "
const path = require('path');
console.log('From apps/bot-orchestrator:');
console.log('  ../../data/bot-instances resolves to:');
console.log('  ' + path.resolve(__dirname, '../../data/bot-instances'));
console.log('  ✅ This should be your project root + /data/bot-instances');
"
```

**Expected Results:**
- ✅ No absolute paths in `.env` files
- ✅ Code uses `process.env.BOT_BASE_DIR || path.join(__dirname, ...)`
- ✅ Paths resolve correctly to your project directory

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
| Path Type | **Relative** (`../../data/...`) | **Absolute** (`/home/ubuntu/Workspace/...`) |
| Path Prefix | From app directory | From system root |
| Pool Mode | Optional (false) | Enabled (true) |
| Turso Backup | Disabled | Optional |
| Env File | `.env` | `.env` (symlinked from `.env.production`) |

### Path Resolution Strategy

The code uses **environment variables** that work in both environments:

```javascript
// Development (.env): BOT_BASE_DIR=../../data/bot-instances
// Production (.env.production): BOT_BASE_DIR=/home/ubuntu/Workspace/crypto-trading-platform/data/bot-instances

const BOT_BASE_DIR = process.env.BOT_BASE_DIR || path.join(__dirname, '../../data/bot-instances');
//                   ↑ Reads from .env file      ↑ Fallback (same as relative path)
```

**How paths are resolved:**

```javascript
// When you run: cd apps/bot-orchestrator && node index.js
// Working directory: /path/to/your/project/apps/bot-orchestrator/
// __dirname:         /path/to/your/project/apps/bot-orchestrator/

// Relative path from .env:
BOT_BASE_DIR=../../data/bot-instances

// Node.js resolves:
path.resolve(__dirname, '../../data/bot-instances')
// = /path/to/your/project/data/bot-instances ✅
```

**Production:**
```javascript
// systemd runs from: /home/ubuntu/Workspace/crypto-trading-platform/apps/bot-orchestrator/
// .env.production has:
BOT_BASE_DIR=/home/ubuntu/Workspace/crypto-trading-platform/data/bot-instances

// Node.js uses the absolute path directly ✅
```

---

## 📁 File Structure for Environment Configs

```
apps/
├── api-gateway/
│   ├── .env                    # YOUR dev config (gitignored) ← CREATE THIS
│   ├── .env.production         # Production config (committed, reference only)
│   ├── .env.systemd            # Production symlink (ignore this)
│   └── serviceAccountKey.json  # Firebase credentials (gitignored) ← GET FROM FIREBASE
│
├── bot-orchestrator/
│   ├── .env                    # YOUR dev config (gitignored) ← CREATE THIS
│   ├── .env.production         # Production config (committed, reference only)
│   ├── .env.systemd            # Production symlink (ignore this)
│   └── serviceAccountKey.json  # Firebase credentials (gitignored) ← GET FROM FIREBASE
│
└── web/
    ├── .env                    # YOUR dev config (gitignored) ← CREATE THIS
    ├── .env.production         # Production (Vercel, committed, reference only)
    └── src/lib/config.ts       # Runtime config detection
```

**Files You Need to Create:**
1. `apps/api-gateway/.env` - Copy from section 3, customize for your machine
2. `apps/bot-orchestrator/.env` - Copy from section 3, customize for your machine  
3. `apps/web/.env` - Copy from section 3
4. `apps/api-gateway/serviceAccountKey.json` - Download from Firebase Console
5. `apps/bot-orchestrator/serviceAccountKey.json` - Download from Firebase Console

**Files to NEVER Modify:**
- `.env.production` - Production config, reference only
- `.env.systemd` - Production only, created by deployment

---

## 🔐 Firebase Setup

### Getting Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/) → Project Settings → Service Accounts
2. Click **"Generate new private key"**
3. Save as `serviceAccountKey.json` in:
   - `apps/api-gateway/serviceAccountKey.json`
   - `apps/bot-orchestrator/serviceAccountKey.json`

Both files are gitignored. **Never commit these files!**

### Alternative: Use Environment Variables

If you can't get the service account file, you can use environment variables in your `.env`:

```dotenv
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@crypto-pilot-b2376.iam.gserviceaccount.com"
FIREBASE_PROJECT_ID="crypto-pilot-b2376"
```

The code checks for `serviceAccountKey.json` first, then falls back to environment variables.

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
- Ensure `ALLOWED_ORIGINS` in your `.env` includes `http://localhost:5173`
- Check if you're hitting the right port (5001 for API, 5000 for Bot Orchestrator)
- Make sure all 3 servers are running: `./dev-servers.sh status`

### "Firebase app does not exist"
- Ensure `serviceAccountKey.json` exists in both `apps/api-gateway/` and `apps/bot-orchestrator/`
- The file must be valid JSON from Firebase Console
- Check file permissions: `ls -la apps/*/serviceAccountKey.json`

### "Cannot find module" or path errors
- Check your `.env` file has **relative paths**: `../../data/bot-instances`
- NOT absolute paths: `/home/ubuntu/Workspace/...` (that's production only)
- Ensure you're running from the correct directory: `cd apps/api-gateway && node index.js`

### "Docker: No such container"
- Pools are for production or local testing with `POOL_MODE_ENABLED=true`
- For simple dev, keep `POOL_MODE_ENABLED=false` in your `.env`
- If testing pools locally, build the image first: `cd apps/bot-orchestrator/docker/pool && ./build.sh`

### Changes not appearing in production
- Wait for Vercel to deploy (frontend ~2-3 min)
- Check GitHub Actions for backend deploy status
- Run `sudo systemctl restart api-gateway bot-orchestrator` manually if needed

### "Port already in use"
- Another process is using the port: `lsof -i :5000` or `lsof -i :5001` or `lsof -i :5173`
- Stop servers: `./dev-servers.sh stop`
- Or kill specific process: `kill -9 <PID>`

### Script says "Running" but server not responding
- Check logs: `./dev-servers.sh logs api` (or bot/web)
- The process may have crashed after starting
- Look for errors in the log file
- Check your `.env` file has correct values

### Permission denied when running script
- Make script executable: `chmod +x dev-servers.sh`
- Or run with bash: `bash dev-servers.sh start`

### Servers won't stop
- Force kill all: `./dev-servers.sh stop` (tries graceful, then force)
- Manual cleanup: `rm -rf .dev-pids/*`
- Kill by port: `lsof -ti :5000 | xargs kill -9` (repeat for 5001, 5173)

---

## 🛠️ Dev Server Control Script

The `dev-servers.sh` script provides easy management of all development servers. It handles:
- Starting/stopping services with proper working directories
- Checking service status (running/stopped)
- Viewing logs with color-coded output
- Managing individual or all services at once

**Features:**
- ✅ Uses relative paths (works on any machine)
- ✅ Proper background process management
- ✅ PID tracking for reliable stop/restart
- ✅ Color-coded output for easy reading
- ✅ Log viewing with real-time updates

**See the script for full documentation.**

---

## �️ Push Safety Checklist

**Before pushing code to `main`, verify:**

### Files You Should NEVER Commit:
- [ ] `.env` files (any without `.production` suffix)
- [ ] `serviceAccountKey.json` files  
- [ ] `.env.systemd` files
- [ ] `.dev-logs/` and `.dev-pids/` directories
- [ ] `node_modules/`

**These are already in `.gitignore` but double-check:**
```bash
# This should return nothing (or only .env.production files)
git status | grep "\.env\|serviceAccountKey"
```

### Code Safety:
- [ ] No hardcoded absolute paths in `.js` files
- [ ] All paths use `process.env.XYZ || path.join(__dirname, ...)` pattern
- [ ] No `/home/ubuntu/`, `/Users/`, or `C:\` in code
- [ ] `npm run build:packages` passes
- [ ] `npm run lint` passes (or close to it)

### Why This is Safe:

**The Golden Rule:** 
> **Config is environment-specific (.env files, gitignored)**  
> **Code is universal (committed, uses env vars)**

```
Developer Machine                Production Server
─────────────────               ─────────────────
.env (gitignored)    ──┐        .env.production (committed)
BOT_BASE_DIR=../../  ──┤        BOT_BASE_DIR=/home/ubuntu/...
                       │
Code (committed) ──────┴────────► Same code file
const X = process.env.BOT_BASE_DIR || path.join(...)
```

When you push:
- ✅ Code is committed (works everywhere with env vars)
- ✅ Your `.env` stays on your machine (gitignored)
- ✅ Production uses its own `.env.production` (already on server)
- ✅ Paths resolve correctly in both places

---

## �📝 Development Workflow Summary

```
1. Clone repo:                           git clone https://github.com/Git-Ansh/crypto-trading-platform.git
2. Install dependencies:                 npm install
3. Create .env files:                    See section 3 (use relative paths!)
4. Get Firebase keys:                    Download serviceAccountKey.json for both apps
5. Start servers:                        ./dev-servers.sh start
6. Check status:                         ./dev-servers.sh status
7. Make your changes locally
8. Test locally:                         Open http://localhost:5173
9. Build check:                          npm run build:packages
10. Commit:                              git add . && git commit -m "feat: ..."
11. Push to main:                        git push origin main
12. Watch:                               GitHub Actions (backend) + Vercel (frontend)
13. Verify:                              curl https://api.crypto-pilot.dev/api/health
```

---

## ✅ Quick Checklist for New Developers

**Before You Start Coding:**

- [ ] Node.js 20+ installed: `node -v`
- [ ] Repository cloned: `git clone ...`
- [ ] Dependencies installed: `npm install`
- [ ] Created `apps/api-gateway/.env` with **relative paths**
- [ ] Created `apps/bot-orchestrator/.env` with **relative paths**
- [ ] Created `apps/web/.env`
- [ ] Downloaded `serviceAccountKey.json` to both app directories
- [ ] MongoDB running (local) or have Atlas URI
- [ ] Can start all servers: `./dev-servers.sh start`
- [ ] Frontend loads: http://localhost:5173
- [ ] API responds: http://localhost:5001/api/health
- [ ] Bot Manager responds: http://localhost:5000/api/health

**When Pushing to Production:**

- [ ] Build packages pass: `npm run build:packages`
- [ ] No lint errors: `npm run lint`
- [ ] Frontend builds: `cd apps/web && npm run build`
- [ ] Committed to `main` branch: `git push origin main`
- [ ] GitHub Actions pass: Check Actions tab
- [ ] Vercel deploys: Check Vercel dashboard
- [ ] Production health check: `curl https://api.crypto-pilot.dev/api/health`

---

## 🎉 You're Ready!

With this setup:
- ✅ Code works locally with `.env` files (relative paths)
- ✅ Same code works in production with `.env.production` files (absolute paths)
- ✅ Push to `main` triggers auto-deployment
- ✅ No manual path or CORS changes needed between environments
- ✅ Easy server management with `dev-servers.sh` script

**Happy coding! 🚀**
