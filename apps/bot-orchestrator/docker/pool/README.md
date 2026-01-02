# FreqTrade Pool Container

Custom Docker image that extends the official FreqTrade image with Supervisord support for the multi-tenant container pool architecture.

## Purpose

The pool system runs multiple FreqTrade bot processes inside a single container, managed by Supervisord. This reduces resource overhead compared to running one container per bot.

## Features

- Based on `freqtradeorg/freqtrade:stable`
- Supervisord for process management
- Support for up to 10 bots per container
- Dynamic bot configuration via supervisor conf.d
- Health check endpoint
- Proper logging and log rotation

## Building

```bash
cd apps/bot-orchestrator/docker/pool
./build.sh
```

Or with a specific tag:

```bash
./build.sh v1.0.0
```

## Usage

### Starting a Pool Container

```bash
docker run -d \
  --name freqtrade-pool-1 \
  -p 9000-9009:9000-9009 \
  -v /path/to/pool-data:/pool \
  -v /path/to/supervisor-conf:/etc/supervisor/conf.d \
  freqtrade-pool:latest
```

### Adding a Bot to the Pool

1. Create a supervisor program config file:

```ini
[program:bot-my-instance-id]
command=freqtrade trade --config /pool/bots/my-instance-id/config.json
directory=/pool/bots/my-instance-id
autostart=true
autorestart=true
startretries=3
stderr_logfile=/pool/logs/my-instance-id.err.log
stdout_logfile=/pool/logs/my-instance-id.out.log
user=ftuser
```

2. Signal supervisord to reload:

```bash
docker exec freqtrade-pool-1 supervisorctl reread
docker exec freqtrade-pool-1 supervisorctl update
docker exec freqtrade-pool-1 supervisorctl start bot-my-instance-id
```

### Managing Bots

```bash
# List all bots
docker exec freqtrade-pool-1 supervisorctl status

# Stop a specific bot
docker exec freqtrade-pool-1 supervisorctl stop bot-my-instance-id

# Start a specific bot
docker exec freqtrade-pool-1 supervisorctl start bot-my-instance-id

# Restart a bot
docker exec freqtrade-pool-1 supervisorctl restart bot-my-instance-id

# Remove a bot (stop first)
docker exec freqtrade-pool-1 supervisorctl stop bot-my-instance-id
docker exec freqtrade-pool-1 supervisorctl remove bot-my-instance-id
```

## Directory Structure

Inside the container:

```
/pool/
├── bots/               # Bot-specific directories
│   └── {instance-id}/  # Each bot's data
│       ├── config.json
│       ├── user_data/
│       └── tradesv3.sqlite
├── logs/               # Bot log files
│   ├── {instance-id}.out.log
│   └── {instance-id}.err.log
└── configs/            # Shared configurations

/etc/supervisor/
├── supervisord.conf    # Main supervisor config
└── conf.d/             # Bot program configs
    └── bot-{id}.conf
```

## Environment Variables

The container inherits FreqTrade's environment variables plus:

- `POOL_ID` - Identifier for this pool container
- `MAX_BOTS` - Maximum number of bots (default: 10)

## Health Check

The container includes a health check that verifies:
1. Supervisord is running
2. Supervisorctl can connect

Individual bot health is monitored by the bot-orchestrator's PoolHealthMonitor.
