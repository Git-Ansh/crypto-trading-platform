# Development & Deployment Safety Guide

## 🎯 Goal
Ensure all changes work in **BOTH** development and production environments without breaking anything.

---

## 📋 Pre-Commit Checklist

### Before Every Commit

Run these commands:

```bash
# 1. Validate environment configuration
node scripts/validate-env.js

# 2. Run pre-commit safety checks
node scripts/pre-commit-check.js

# 3. Check what you're committing
git status
git diff --cached

# 4. Verify no secrets are staged
git diff --cached | grep -E "(mongodb|JWT_SECRET|FIREBASE_PRIVATE_KEY|password)"
```

### Manual Verification

- [ ] **Environment Variables**: All required vars in both `.env.development` and `.env.production`
- [ ] **URL Configuration**: No hardcoded URLs (use `config` object)
- [ ] **Authentication**: Works with BOTH Firebase AND JWT
- [ ] **CORS**: Production origins correct, dev origins don't affect prod
- [ ] **Paths**: Use relative paths or environment-based absolute paths
- [ ] **No Secrets**: No credentials, API keys, or tokens in code

---

## 🔐 Environment Configuration Rules

### ✅ DO THIS

```javascript
// ✅ Use environment-based configuration
import { config } from '@/lib/config';
const response = await fetch(`${config.api.baseUrl}/endpoint`);

// ✅ Provide fallbacks for optional vars
const freqtradeUrl = import.meta.env.VITE_FREQTRADE_API_URL || 
  `${import.meta.env.VITE_API_URL}/api/freqtrade`;

// ✅ Use platform-agnostic paths
const BOT_BASE_DIR = path.resolve(process.env.BOT_BASE_DIR || './data/bot-instances');
```

### ❌ DON'T DO THIS

```javascript
// ❌ Hardcoded URLs
const response = await fetch('http://localhost:5001/api/endpoint');

// ❌ Production-specific URLs
const response = await fetch('https://api.crypto-pilot.dev/endpoint');

// ❌ No fallback (will crash if missing)
const apiUrl = required(import.meta.env.VITE_FREQTRADE_API_URL);

// ❌ Hardcoded credentials
const mongoUri = 'mongodb+srv://user:password@cluster...';
```

---

## 🔄 Authentication Best Practices

### Unified Token Function

Always use `getAuthTokenAsync()` which supports BOTH auth methods:

```typescript
// ✅ Works for Firebase AND JWT users
import { getAuthTokenAsync } from '@/lib/api';

const token = await getAuthTokenAsync();
if (!token) {
  // Handle not authenticated
  return;
}

const response = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` }
});
```

### How It Works

1. **Firebase Users**: Gets Firebase ID token (auto-refreshed by Firebase SDK)
2. **JWT Users**: Gets JWT from localStorage (auto-refreshed by our system every 13 minutes)

**Never** use Firebase-specific methods like `auth.currentUser.getIdToken()` directly!

---

## 📁 File Structure for Environment Safety

```
project/
├── apps/
│   ├── api-gateway/
│   │   ├── .env.development      # Dev config (local)
│   │   ├── .env.production       # Prod config (VPS)
│   │   └── .env                  # Symlink/copy of current env
│   ├── bot-orchestrator/
│   │   ├── .env.development      # Dev config
│   │   ├── .env.production       # Prod config
│   │   └── .env                  # Current env
│   └── web/
│       ├── .env                  # Dev config (committed as template)
│       ├── .env.production       # Prod config (committed)
│       └── src/
│           ├── env.ts            # Environment loader with fallbacks
│           └── lib/
│               └── config.ts     # Typed config object
└── scripts/
    ├── validate-env.js           # Validates env files
    └── pre-commit-check.js       # Checks before commit
```

### Important Files

- **`.env.development`**: Local development (MongoDB, JWT secrets, localhost URLs)
- **`.env.production`**: Production (production URLs, secrets on VPS)
- **`.env`**: Current environment (NOT committed for backend, committed for frontend)

---

## 🚀 Deployment Process

### Step 1: Development

```bash
# Make your changes
# Test locally with dev servers
npm run dev

# Validate configuration
node scripts/validate-env.js

# Test with both auth methods
# - Firebase (social login)
# - JWT (email/password)
```

### Step 2: Pre-Commit

```bash
# Run all checks
node scripts/pre-commit-check.js

# Review what you're committing
git status
git diff --cached

# Make sure no secrets
git diff --cached | grep -i "secret\|password\|key"
```

### Step 3: Commit

```bash
# If all checks pass
git add .
git commit -m "feat: your feature

- What changed
- Why it changed
- Tested on: dev/prod, Firebase/JWT
"
```

### Step 4: Pre-Push Verification

```bash
# Final validation
node scripts/validate-env.js

# Verify production config exists
cat apps/web/.env.production | grep VITE_FREQTRADE_API_URL
```

### Step 5: Push & Deploy

```bash
git push origin main

# On production server:
# 1. Pull changes
# 2. Environment variables already configured
# 3. Restart services
# 4. Verify both auth methods work
```

---

## 🐛 Common Issues & Solutions

### Issue: "Missing VITE_FREQTRADE_API_URL"

**Solution**: Add to `.env.production`:
```bash
VITE_FREQTRADE_API_URL=https://api.crypto-pilot.dev/api/freqtrade
```

And ensure `env.ts` has fallback:
```typescript
freqtradeApiUrl: import.meta.env.VITE_FREQTRADE_API_URL || 
  `${required(import.meta.env.VITE_API_URL)}/api/freqtrade`
```

### Issue: "Social login works but email/password doesn't"

**Solution**: Ensure using `getAuthTokenAsync()` everywhere, not Firebase-specific methods.

### Issue: "Works in dev but 404 in production"

**Solution**: Check URL construction. Likely hardcoded `localhost` or missing base URL:
```typescript
// ❌ Wrong
fetch('http://localhost:5001/api/bots')

// ✅ Right
fetch(`${config.botManager.baseUrl}/bots`)
```

### Issue: "CORS error in production"

**Solution**: Verify `ALLOWED_ORIGINS` in production `.env`:
```bash
# Production (VPS)
ALLOWED_ORIGINS=https://crypto-pilot.dev,https://www.crypto-pilot.dev
```

### Issue: "Path not found on Windows/Linux"

**Solution**: Use `path.resolve()` for absolute paths:
```javascript
// ❌ Relative (may break)
const dir = './data/bot-instances';

// ✅ Absolute (cross-platform)
const dir = path.resolve(__dirname, '../../data/bot-instances');
```

---

## 🧪 Testing Matrix

Before pushing, verify:

| Environment | Auth Method | Status |
|-------------|-------------|--------|
| Dev (Windows) | Firebase | ✅ Tested |
| Dev (Windows) | Email/Password | ✅ Tested |
| Prod (Linux) | Firebase | ⚠️ Verify after deploy |
| Prod (Linux) | Email/Password | ⚠️ Verify after deploy |

---

## 📝 Quick Reference Commands

```bash
# Validate environments
node scripts/validate-env.js

# Pre-commit checks
node scripts/pre-commit-check.js

# Check staged files
git diff --cached --name-only

# Unstage sensitive file
git restore --staged apps/api-gateway/.env

# View environment template
cat apps/web/.env.production

# Test local servers
npm run dev
# or
./dev-servers.sh start  # Linux/Mac
.\dev-servers.ps1 start # Windows
```

---

## ✅ Success Criteria

A change is **safe to push** when:

1. ✅ `node scripts/validate-env.js` passes
2. ✅ `node scripts/pre-commit-check.js` passes
3. ✅ No `.env` files (except templates) in `git status`
4. ✅ Works with Firebase auth
5. ✅ Works with JWT auth
6. ✅ No hardcoded URLs/IPs in code
7. ✅ No credentials in code
8. ✅ Configuration uses environment variables
9. ✅ Tests pass locally
10. ✅ Can explain what changed and why

---

## 🆘 Need Help?

If validation fails:
1. Read the error message carefully
2. Check this guide for the specific issue
3. Run `git diff --cached` to see what changed
4. Verify both `.env.development` and `.env.production` are correct
5. Test locally before committing

**Remember**: If it breaks dev, it will break prod. If it breaks prod, rollback immediately.
