# Crypto Trading Platform

Multi-bot cryptocurrency trading platform with FreqTrade integration, real-time portfolio monitoring, and centralized strategy management.

## Architecture

Nx monorepo with npm workspaces, three core services, and shared packages.

```
crypto-trading-platform/
├── apps/
│   ├── web/                    # React 19 + Vite + TypeScript (PORT 5173)
│   ├── api-gateway/            # Express.js main API (PORT 5001)
│   └── bot-orchestrator/       # Bot lifecycle manager (PORT 5000)
├── packages/
│   ├── shared-types/           # TypeScript interfaces (dual ESM/CJS)
│   ├── shared-auth/            # Firebase authentication helpers
│   ├── shared-config/          # Environment configuration loader
│   └── shared-utils/           # Common utilities
├── infrastructure/
│   ├── systemd/                # Service definitions for VPS
│   └── nginx/                  # Reverse proxy configs
├── data/
│   ├── strategies/             # Shared FreqTrade strategies
│   └── bot-instances/          # Per-user bot data directories
├── docs/                       # Project documentation
└── scripts/                    # Utility scripts (health checks, sync tools)
```

**Data Flow**: Browser → API Gateway (5001) → Bot Orchestrator (5000) → FreqTrade Containers (8100+)

## Quick Start

```bash
# Install dependencies
npm install

# Build shared packages (required before running services)
npm run build:packages

# Start all services with tmux
./dev-servers.sh start

# Or start services individually
npm run dev:web         # Frontend on 5173
npm run dev:api         # API Gateway on 5001
npm run dev:bot         # Bot Orchestrator on 5000

# Check service status
./dev-servers.sh status

# Stop all services
./dev-servers.sh stop
```

## Key Commands

```bash
# Development
npm run build:packages          # Build shared-types and shared-config
npm run build:web              # Build frontend for production
npm run build                  # Build packages + web

# Testing
./test-integration.sh          # Run integration tests
./scripts/pool-health-check.sh # Check FreqTrade container pool

# Deployment
./deploy.sh                    # Deploy to VPS (systemd services)
```

## Environment Setup

- Development: `.env.development` at repo root
- Production: `.env.production` (symlinked by deploy.sh)
- Required vars: `FIREBASE_PROJECT_ID`, `JWT_SECRET`, `MONGO_URI`
- Optional: `TURSO_API_KEY`, `TURSO_ORG`, `POOL_MODE_ENABLED`

## Deployment

- **Frontend**: Vercel (automated from `apps/web`)
- **Backend**: VPS with systemd services
- **Containers**: Docker for FreqTrade instances

Service management:
```bash
sudo systemctl status api-gateway
sudo systemctl status bot-orchestrator
sudo journalctl -u api-gateway -f
sudo journalctl -u bot-orchestrator -f
```

## Documentation

- [AI Coding Instructions](.github/copilot-instructions.md)
- [Development Status](docs/DEVELOPMENT_STATUS.md)
- [Deployment Checklist](docs/DEPLOYMENT_CHECKLIST.md)
- [Pool System](apps/bot-orchestrator/lib/POOL_SYSTEM_README.md)

## Project Status

Phase 1 complete: Monorepo migration, shared packages, and multi-tenant container pool system operational.
