# Vercel Migration Guide: Deploying from the Monorepo

## Overview
This guide explains how to switch your Vercel deployment from the old `Crypto/Client` repo to the new monorepo at `crypto-trading-platform/apps/web`.

---

## Step 1: Prepare the Monorepo for Vercel

The monorepo is already configured with:
- [apps/web/vercel.json](apps/web/vercel.json) - Build settings
- [apps/web/src/env.ts](apps/web/src/env.ts) - Typed environment helper
- Root `package.json` with workspace configuration

---

## Step 2: Update Vercel Project Settings

### Option A: Link New Project (Recommended for Fresh Start)

1. **Go to Vercel Dashboard** → [vercel.com/dashboard](https://vercel.com/dashboard)
2. **Create New Project** → "Add New..." → "Project"
3. **Import Git Repository**:
   - If using GitHub: Connect your `crypto-trading-platform` repo
   - If using manual deploy: Skip to Option B
4. **Configure Project**:
   - **Root Directory**: `apps/web`
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Install Command**: `npm install`
5. **Environment Variables** (add all of these):
   ```
   VITE_API_URL=https://api.crypto-pilot.dev
   VITE_FREQTRADE_API_URL=https://freqtrade.crypto-pilot.dev
   VITE_CLIENT_URL=https://crypto-pilot.dev
   VITE_PUBLIC_POSTHOG_KEY=<your-posthog-key>
   VITE_PUBLIC_POSTHOG_HOST=https://app.posthog.com
   VITE_FIREBASE_API_KEY=<your-firebase-api-key>
   VITE_FIREBASE_AUTH_DOMAIN=crypto-pilot-b2376.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=crypto-pilot-b2376
   VITE_FIREBASE_STORAGE_BUCKET=crypto-pilot-b2376.firebasestorage.app
   VITE_FIREBASE_MESSAGING_SENDER_ID=<your-sender-id>
   VITE_FIREBASE_APP_ID=<your-app-id>
   VITE_FIREBASE_MEASUREMENT_ID=<your-measurement-id>
   ```
6. **Deploy**

### Option B: Update Existing Project

1. **Go to Vercel Dashboard** → Select your existing project
2. **Settings** → **General**:
   - **Root Directory**: Change to `apps/web`
3. **Settings** → **Build & Development Settings**:
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build` (or leave as default)
   - **Output Directory**: `dist`
   - **Install Command**: `npm install`
4. **Settings** → **Git**:
   - Update repository if switching to a new repo
   - Set production branch to `main`
5. **Redeploy** from the Deployments tab

---

## Step 3: Domain Configuration

### If Keeping Same Domain (crypto-pilot.dev)
No changes needed. Vercel will continue serving from the same domain.

### If Changing Domains
1. **Vercel Dashboard** → Project → **Settings** → **Domains**
2. **Add Domain**: Enter your new domain
3. **Configure DNS**:
   - Add CNAME record: `www` → `cname.vercel-dns.com`
   - Add A record: `@` → `76.76.19.19` (Vercel IP)
4. **Update Backend CORS**:
   In `.env.production` on VPS:
   ```bash
   ALLOWED_ORIGINS=https://your-new-domain.com https://www.your-new-domain.com https://crypto-pilot.dev
   ```
5. **Update Frontend Config**:
   In Vercel environment variables:
   ```
   VITE_CLIENT_URL=https://your-new-domain.com
   ```

---

## Step 4: Manual Deploy via CLI (Alternative)

If you prefer deploying from VPS directly:

```bash
# Install Vercel CLI (once)
npm i -g vercel

# Login to Vercel
vercel login

# Navigate to web app
cd /root/crypto-trading-platform/apps/web

# Deploy to production
vercel --prod

# Or deploy preview
vercel
```

---

## Step 5: Preview Deployments

Vercel creates preview URLs for each PR/branch. Add these to backend CORS:

```bash
# .env.production on VPS
ALLOWED_ORIGINS=https://crypto-pilot.dev https://*.vercel.app
```

Note: Wildcard patterns may not work. Add specific preview URLs as needed, or use a more permissive check in development.

---

## Step 6: Verify Deployment

After deploying:

1. **Check Build Logs**: Vercel Dashboard → Deployments → Latest → View Logs
2. **Test the App**:
   - Open your domain
   - Check browser console for errors
   - Verify API calls work (Network tab)
   - Test authentication flow
3. **Check CORS**:
   - If you see CORS errors, update `ALLOWED_ORIGINS` on VPS and restart:
     ```bash
     sudo systemctl restart api-gateway bot-orchestrator
     ```

---

## Troubleshooting

### Build Fails: "Cannot find module"
- Ensure `package.json` in `apps/web` has all dependencies
- Run `npm install` locally first to verify

### API Calls Fail with CORS Error
- Check `ALLOWED_ORIGINS` in backend `.env.production`
- Verify the origin URL matches exactly (including https://)
- Restart backend services after env changes

### Environment Variables Not Working
- Vercel env vars must start with `VITE_` for Vite to expose them
- Redeploy after adding new env vars
- Check they're set for the correct environment (Production/Preview/Development)

### Old Deployment Still Serving
- Clear Vercel cache: Settings → Functions → Purge Cache
- Check that the correct branch is set as production

---

## Quick Reference

| Setting | Value |
|---------|-------|
| Root Directory | `.` (monorepo root) |
| Framework | Other (or leave empty) |
| Build Command | `npm run build --prefix apps/web` |
| Output Directory | `apps/web/dist` |
| Install Command | `npm install` |
| Node Version | 20.x |

**Alternative: Set Root Directory to `apps/web`**
| Setting | Value |
|---------|-------|
| Root Directory | `apps/web` |
| Framework | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

---

## Rollback to Old Repo (Emergency)

If you need to rollback:
1. Vercel Dashboard → Settings → Git
2. Change repository back to old `Crypto` repo
3. Set Root Directory to `Client`
4. Redeploy

The old repo should still work as a fallback.
