# Bot Orchestrator Refactor Plan

## Overview
This document outlines the plan to refactor the 5,111-line monolithic `bot-manager/index.js` into a modular TypeScript/NestJS structure with multi-tenant container pooling.

---

## Current State Analysis

### Monolith Structure (index.js)
| Section | Lines (approx) | Responsibility |
|---------|----------------|----------------|
| Imports & Config | 1-150 | Environment, dependencies |
| Express Setup | 150-300 | Middleware, CORS, auth |
| Docker Helpers | 300-600 | Container management |
| Bot CRUD | 600-1200 | Provisioning, config |
| FreqTrade API Proxy | 1200-1800 | Forward requests to bots |
| Portfolio Aggregation | 1800-2500 | SSE streaming, calculations |
| Strategy Management | 2500-3000 | Strategy CRUD, validation |
| Sync Services | 3000-3500 | Turso, SQLite sync |
| Route Handlers | 3500-5111 | 50+ endpoints |

### Key Issues
1. **No separation of concerns** - Everything in one file
2. **Difficult to test** - No dependency injection
3. **One container per bot** - Resource explosion
4. **No type safety** - Plain JavaScript

---

## Target Architecture

### Modular Structure
```
apps/bot-orchestrator/
├── src/
│   ├── main.ts                    # Bootstrap
│   ├── app.module.ts              # Root module (NestJS)
│   │
│   ├── config/
│   │   ├── app.config.ts          # Environment config
│   │   └── docker.config.ts       # Docker settings
│   │
│   ├── modules/
│   │   ├── bots/
│   │   │   ├── bots.module.ts
│   │   │   ├── bots.controller.ts
│   │   │   ├── bots.service.ts
│   │   │   ├── bots.repository.ts
│   │   │   └── dto/
│   │   │       ├── create-bot.dto.ts
│   │   │       ├── update-bot.dto.ts
│   │   │       └── bot-response.dto.ts
│   │   │
│   │   ├── containers/
│   │   │   ├── containers.module.ts
│   │   │   ├── containers.service.ts
│   │   │   ├── container-pool.ts      # Multi-tenant pooling
│   │   │   └── health-monitor.ts
│   │   │
│   │   ├── portfolio/
│   │   │   ├── portfolio.module.ts
│   │   │   ├── portfolio.service.ts
│   │   │   ├── portfolio.controller.ts
│   │   │   └── streaming.service.ts   # SSE
│   │   │
│   │   ├── strategies/
│   │   │   ├── strategies.module.ts
│   │   │   ├── strategies.service.ts
│   │   │   └── strategies.controller.ts
│   │   │
│   │   ├── provisioning/
│   │   │   ├── provisioning.module.ts
│   │   │   ├── queue.service.ts
│   │   │   └── provisioner.service.ts
│   │   │
│   │   └── sync/
│   │       ├── sync.module.ts
│   │       ├── turso-sync.service.ts
│   │       └── sqlite-sync.service.ts
│   │
│   ├── common/
│   │   ├── middleware/
│   │   │   └── auth.middleware.ts
│   │   ├── guards/
│   │   │   └── jwt-auth.guard.ts
│   │   ├── decorators/
│   │   │   └── user.decorator.ts
│   │   └── filters/
│   │       └── http-exception.filter.ts
│   │
│   └── shared/
│       ├── freqtrade-client.ts
│       └── docker-client.ts
│
├── test/
│   ├── bots.service.spec.ts
│   ├── containers.service.spec.ts
│   └── e2e/
│
├── package.json
├── tsconfig.json
└── nest-cli.json
```

---

## Multi-Tenant Container Pooling

### Current Model (1 container per bot)
```
User A Bot 1 → Container 1 (500MB)
User A Bot 2 → Container 2 (500MB)
User B Bot 1 → Container 3 (500MB)
Total: 3 bots = 1.5GB RAM
```

### Proposed Model (N bots per container)
```
Container Pool 1 → [Bot 1, Bot 2, Bot 3, ...Bot 10] (600MB)
Container Pool 2 → [Bot 11, Bot 12, ...Bot 20] (600MB)
Total: 20 bots = 1.2GB RAM (vs 10GB)
```

### Container Pool Design

```typescript
// src/modules/containers/container-pool.ts

interface ContainerSlot {
  containerId: string;
  botId: string;
  port: number;
  status: 'active' | 'idle' | 'error';
  assignedAt: Date;
}

interface PooledContainer {
  id: string;
  dockerId: string;
  basePort: number;
  maxBots: number;
  slots: ContainerSlot[];
  status: 'running' | 'starting' | 'stopped';
  createdAt: Date;
}

export class ContainerPool {
  private containers: Map<string, PooledContainer> = new Map();
  private readonly MAX_BOTS_PER_CONTAINER = 10;
  private readonly BASE_PORT = 8100;

  async assignBot(botId: string, config: BotConfig): Promise<ContainerSlot> {
    // Find container with available slot
    let container = this.findAvailableContainer();
    
    if (!container) {
      // Create new pooled container
      container = await this.createPooledContainer();
    }
    
    // Assign bot to slot
    const slot = await this.assignSlot(container, botId, config);
    return slot;
  }

  async removeBot(botId: string): Promise<void> {
    const container = this.findContainerByBot(botId);
    if (!container) return;
    
    // Remove bot from slot
    await this.releaseSlot(container, botId);
    
    // If container empty, consider destroying
    if (container.slots.length === 0) {
      await this.destroyContainer(container.id);
    }
  }

  private async createPooledContainer(): Promise<PooledContainer> {
    const containerId = `pool-${Date.now()}`;
    const basePort = this.getNextBasePort();
    
    // Start container with multi-bot configuration
    const dockerId = await this.docker.createContainer({
      Image: 'freqtradeorg/freqtrade:stable',
      name: containerId,
      Env: [
        `POOL_MODE=true`,
        `MAX_BOTS=${this.MAX_BOTS_PER_CONTAINER}`,
        `BASE_PORT=${basePort}`,
      ],
      PortBindings: this.generatePortBindings(basePort),
      Volumes: {
        '/freqtrade/user_data/strategies': { bind: '/data/strategies:ro' },
        '/freqtrade/pool_data': { bind: `/data/pool/${containerId}` },
      },
    });
    
    const container: PooledContainer = {
      id: containerId,
      dockerId,
      basePort,
      maxBots: this.MAX_BOTS_PER_CONTAINER,
      slots: [],
      status: 'running',
      createdAt: new Date(),
    };
    
    this.containers.set(containerId, container);
    return container;
  }

  private async assignSlot(
    container: PooledContainer,
    botId: string,
    config: BotConfig
  ): Promise<ContainerSlot> {
    const slotIndex = container.slots.length;
    const port = container.basePort + slotIndex;
    
    // Configure bot within container
    await this.configureBotInContainer(container.dockerId, botId, config, slotIndex);
    
    const slot: ContainerSlot = {
      containerId: container.id,
      botId,
      port,
      status: 'active',
      assignedAt: new Date(),
    };
    
    container.slots.push(slot);
    return slot;
  }

  getStats(): PoolStats {
    let totalBots = 0;
    let totalContainers = 0;
    
    for (const container of this.containers.values()) {
      totalContainers++;
      totalBots += container.slots.length;
    }
    
    return {
      totalContainers,
      totalBots,
      avgBotsPerContainer: totalBots / totalContainers || 0,
      estimatedMemoryMB: totalContainers * 600,
    };
  }
}
```

### Bot-to-Container Routing

```typescript
// src/modules/bots/bots.service.ts

export class BotsService {
  constructor(
    private containerPool: ContainerPool,
    private freqtradeClient: FreqtradeClient,
  ) {}

  async proxyRequest(botId: string, endpoint: string, method: string, data?: any) {
    // Get the container slot for this bot
    const slot = this.containerPool.getSlot(botId);
    if (!slot) {
      throw new NotFoundException(`Bot ${botId} not found in any container`);
    }
    
    // Route request to correct port
    const url = `http://localhost:${slot.port}/api/v1/${endpoint}`;
    return this.freqtradeClient.request(url, method, data);
  }

  async getBotStatus(botId: string) {
    return this.proxyRequest(botId, 'status', 'GET');
  }

  async startBot(botId: string) {
    return this.proxyRequest(botId, 'start', 'POST');
  }

  async stopBot(botId: string) {
    return this.proxyRequest(botId, 'stop', 'POST');
  }
}
```

---

## Migration Strategy

### Phase 1: Parallel NestJS Setup (Week 1)

1. **Initialize NestJS app**
   ```bash
   cd apps/bot-orchestrator
   npx @nestjs/cli new . --package-manager npm
   ```

2. **Create module structure** (empty modules)

3. **Run on port 5002** alongside existing service

4. **Migrate `/health` endpoint first**

### Phase 2: Migrate Core Modules (Week 2)

1. **Migrate Bots Module**
   - Move bot CRUD logic to `bots.service.ts`
   - Add DTOs with class-validator
   - Keep Docker logic in old service initially

2. **Migrate Strategies Module**
   - Move strategy listing/validation
   - Add proper error handling

3. **Update Nginx to route new endpoints to 5002**

### Phase 3: Container Pooling (Week 3)

1. **Implement ContainerPool class**

2. **Create pool management endpoints**
   ```
   GET  /api/pool/stats        # Pool statistics
   POST /api/pool/containers   # Create new pool container
   DELETE /api/pool/containers/:id
   ```

3. **Modify bot provisioning to use pool**

4. **Test with 5 bots in single container**

### Phase 4: Full Migration (Week 4)

1. **Migrate remaining endpoints**

2. **Add SSE streaming with NestJS**

3. **Switch traffic from 5000 to new service**

4. **Decommission old service**

---

## NestJS Quick Start

### Install Dependencies
```bash
cd apps/bot-orchestrator
npm install @nestjs/core @nestjs/common @nestjs/platform-express
npm install @nestjs/config @nestjs/swagger
npm install class-validator class-transformer
npm install dockerode  # Docker client
npm install -D @nestjs/cli @nestjs/testing
```

### Basic Module Template

```typescript
// src/modules/bots/bots.module.ts
import { Module } from '@nestjs/common';
import { BotsController } from './bots.controller';
import { BotsService } from './bots.service';
import { ContainersModule } from '../containers/containers.module';

@Module({
  imports: [ContainersModule],
  controllers: [BotsController],
  providers: [BotsService],
  exports: [BotsService],
})
export class BotsModule {}
```

```typescript
// src/modules/bots/bots.controller.ts
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { BotsService } from './bots.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '../../common/decorators/user.decorator';

@Controller('api/bots')
@UseGuards(JwtAuthGuard)
export class BotsController {
  constructor(private readonly botsService: BotsService) {}

  @Get()
  async listBots(@User() user: UserIdentity) {
    return this.botsService.findByUser(user.id);
  }

  @Post()
  async createBot(@User() user: UserIdentity, @Body() dto: CreateBotDto) {
    return this.botsService.create(user.id, dto);
  }

  @Get(':id/status')
  async getBotStatus(@Param('id') id: string, @User() user: UserIdentity) {
    return this.botsService.getStatus(id, user.id);
  }
}
```

---

## Testing Strategy

### Unit Tests
```typescript
// test/bots.service.spec.ts
describe('BotsService', () => {
  let service: BotsService;
  let containerPool: jest.Mocked<ContainerPool>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        BotsService,
        { provide: ContainerPool, useValue: createMock<ContainerPool>() },
      ],
    }).compile();

    service = module.get(BotsService);
    containerPool = module.get(ContainerPool);
  });

  it('should assign bot to container pool', async () => {
    containerPool.assignBot.mockResolvedValue({ port: 8100, containerId: 'pool-1' });
    
    const result = await service.create('user-1', { strategy: 'DCA', pairs: ['BTC/USDT'] });
    
    expect(containerPool.assignBot).toHaveBeenCalled();
    expect(result.port).toBe(8100);
  });
});
```

### E2E Tests
```typescript
// test/e2e/bots.e2e-spec.ts
describe('Bots (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  it('/api/bots (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/bots')
      .set('Authorization', 'Bearer test-token')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
      });
  });
});
```

---

## Rollback Plan

If issues arise:

1. **Nginx Rollback**: Point traffic back to old service (port 5000)
2. **Data Preserved**: Both services read/write same data directories
3. **Container Compatibility**: Old service still works with existing containers

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Container count (50 bots) | 50 | 5 |
| Memory usage (50 bots) | 25GB | 3GB |
| Cold start time | N/A | <5s |
| Test coverage | 0% | 80%+ |
| Lines per file | 5111 | <500 |
