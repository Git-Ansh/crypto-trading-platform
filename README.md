# Crypto Trading Platform - Monorepo

Multi-bot cryptocurrency trading platform with FreqTrade integration, real-time portfolio monitoring, and centralized strategy management.

## 🏗️ Architecture

```
crypto-trading-platform/
├── apps/
│   ├── web/                    # React frontend (Vite + TypeScript) - PORT 5173
│   ├── api-gateway/            # Express.js main server - PORT 5001
│   └── bot-orchestrator/       # Bot manager service - PORT 5000
├── packages/
│   ├── shared-types/           # TypeScript interfaces
│   ├── shared-auth/            # Unified authentication logic
│   ├── shared-config/          # Environment configuration
│   ├── shared-utils/           # Common utilities
│   └── freqtrade-client/       # Bot API client library
├── infrastructure/
│   ├── docker/                 # Docker Compose files
│   ├── nginx/                  # Nginx configurations
│   └── systemd/                # Systemd service definitions
└── data/
    ├── strategies/             # Centralized strategy files
    ├── bot-instances/          # Per-user bot data
    ├── shared-market-data/     # Shared exchange data
    └── postgres/               # PostgreSQL data
```

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development
npx nx serve web                # Frontend on 5173
npx nx serve api-gateway        # API on 5001  
npx nx serve bot-orchestrator   # Bots on 5000

# Build for production
npx nx run-many --target=build --all
```

## 📦 Key Commands

```bash
# Build specific app
npx nx build web
npx nx build api-gateway

# View dependency graph
npx nx graph

# Run tests
npx nx test <app-name>

# Lint all
npx nx run-many --target=lint --all
```

## 🎯 Deployment

**Frontend**: Vercel (automated from monorepo)
**Backend**: VPS via systemd services

See [infrastructure/DEPLOYMENT.md](infrastructure/DEPLOYMENT.md) for details.

## 📚 Documentation

- [Architecture Plan](/plan-architectureModernization.prompt.md)
- [API Configuration](Crypto/API_CONFIGURATION.md) 
- [Quick Reference](Crypto-Pilot-Freqtrade/QUICK_REFERENCE.md)

---

**Phase 1 Status**: ✅ Monorepo Setup Complete
**Next Phase**: Shared Packages & NestJS Refactoring
