# Testing & Development Guide

## ⚠️ Current Issue: Node.js Version

The VPS is running **Node.js v18.20.4**, but the latest dependencies require **Node.js 20.19+**.

### Solutions:

**Option 1: Upgrade Node.js on VPS (Recommended)**
```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version  # Should show v20.x.x
```

**Option 2: Use the Old Repositories for Now**
```bash
# Frontend
cd /root/Crypto/Client
npm run dev  # Port 5173

# API Gateway  
cd /root/Crypto/server
npm start  # Port 5001

# Bot Orchestrator
cd /root/Crypto-Pilot-Freqtrade/bot-manager
node index.js  # Port 5000
```

## 🚀 After Node.js Upgrade - Testing Monorepo

### Development Mode (Localhost)

**Terminal 1 - Frontend:**
```bash
cd /root/crypto-trading-platform/apps/web
npm run dev
# Runs on http://localhost:5173
# Uses .env.development (API at localhost:5001, Bot Manager at localhost:5000)
```

**Terminal 2 - API Gateway:**
```bash
cd /root/crypto-trading-platform/apps/api-gateway
node index.js
# Runs on http://localhost:5001
# Uses .env.development (MongoDB, local bot manager)
```

**Terminal 3 - Bot Orchestrator:**
```bash
cd /root/crypto-trading-platform/apps/bot-orchestrator
node index.js
# Runs on http://localhost:5000
# Uses .env.development (Local SQLite, Turso disabled)
```

### Production Mode (Systemd Services)

```bash
# Switch to production environment
cd /root/crypto-trading-platform
ln -sf .env.production apps/api-gateway/.env
ln -sf .env.production apps/bot-orchestrator/.env

# Restart systemd services
sudo systemctl restart api-gateway bot-orchestrator

# Check status
sudo systemctl status api-gateway bot-orchestrator

# View logs
sudo journalctl -u api-gateway -f
sudo journalctl -u bot-orchestrator -f
```

## 🔄 Switching Between Dev and Prod

**Switch to Development:**
```bash
cd /root/crypto-trading-platform
ln -sf .env.development apps/api-gateway/.env
ln -sf .env.development apps/bot-orchestrator/.env
```

**Switch to Production:**
```bash
cd /root/crypto-trading-platform
ln -sf .env.production apps/api-gateway/.env
ln -sf .env.production apps/bot-orchestrator/.env
sudo systemctl restart api-gateway bot-orchestrator
```

## 🌐 Environment Variables Summary

| Environment | Frontend URL | API URL | Bot Manager URL | Database |
|-------------|-------------|---------|-----------------|----------|
| **Development** | localhost:5173 | localhost:5001 | localhost:5000 | Local MongoDB / SQLite |
| **Production** | crypto-pilot.dev | api.crypto-pilot.dev | freqtrade.crypto-pilot.dev | MongoDB Atlas / SQLite + Turso |

## ✅ Testing Checklist

- [ ] Node.js upgraded to v20+
- [ ] Frontend starts on localhost:5173
- [ ] API Gateway connects to MongoDB
- [ ] Bot Orchestrator starts without errors
- [ ] Frontend can authenticate via Firebase
- [ ] API requests reach backend
- [ ] Bot provisioning works
- [ ] SSE streaming functions
- [ ] Systemd services run in production mode

## 📝 Next Steps

1. Upgrade Node.js to v20+
2. Test all three services locally
3. Update systemd services (see infrastructure/systemd/)
4. Deploy frontend to Vercel
5. Verify production deployment
