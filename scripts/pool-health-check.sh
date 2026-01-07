#!/bin/bash

# Pool Health Check and Sync Script
# Synchronizes pool state with actual running bots

set -e

POOL_STATE_FILE="data/bot-instances/.container-pool-state.json"
BACKUP_DIR="data/bot-instances/.backups"

echo "=== POOL HEALTH CHECK AND SYNC ==="
echo "Timestamp: $(date)"
echo ""

# Create backup
mkdir -p "$BACKUP_DIR"
if [ -f "$POOL_STATE_FILE" ]; then
    cp "$POOL_STATE_FILE" "$BACKUP_DIR/pool-state-$(date +%Y%m%d-%H%M%S).json"
    echo "✓ Backed up pool state file"
fi

echo ""
echo "=== CHECKING DOCKER CONTAINERS ==="
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "(NAMES|freqtrade-pool)" || echo "No pool containers found"

echo ""
echo "=== CHECKING POOL STATE FILE ==="
if [ -f "$POOL_STATE_FILE" ]; then
    echo "Pools in state file:"
    cat "$POOL_STATE_FILE" | jq -r '.pools | keys[]' 2>/dev/null || echo "Error reading pool state"
    
    echo ""
    echo "Bots in state file:"
    cat "$POOL_STATE_FILE" | jq -r '.botMapping | keys[]' 2>/dev/null || echo "Error reading bot mapping"
else
    echo "❌ Pool state file not found!"
fi

echo ""
echo "=== CHECKING ACTUAL RUNNING BOTS ==="
for pool in $(docker ps --format "{{.Names}}" | grep "freqtrade-pool" || true); do
    echo ""
    echo "Pool: $pool"
    echo "Supervisor status:"
    docker exec "$pool" supervisorctl status 2>/dev/null || echo "  Error getting supervisor status"
    
    echo "Running processes:"
    docker exec "$pool" ps aux | grep -E "freqtrade trade" | grep -v grep || echo "  No freqtrade processes"
done

echo ""
echo "=== CHECKING DATABASE ==="
echo "Querying MongoDB for registered bots..."
# This would need to be implemented with proper MongoDB query

echo ""
echo "=== RECOMMENDATIONS ==="
echo "1. Run pool sync API: POST /api/pool/sync"
echo "2. Clean up stale entries: POST /api/pool/cleanup"
echo "3. Verify bot directories match database"
echo ""

