# Wallet Sync Solution

## Problem
The system had multiple sources of truth that were out of sync:
1. **MongoDB User.botAllocations** - Wallet allocations in database
2. **Pool State File** (`.container-pool-state.json`) - Running containers state
3. **Docker Reality** - Actual running containers

When a bot was deleted, if any step failed, orphaned allocations remained in the database.

## Root Cause
- Bot deletion is a multi-step process across different systems
- If bot-orchestrator deletion fails, wallet cleanup might not happen
- If services restart, state files can be reset but database persists
- No automatic reconciliation between database and reality

## Solution Implemented

### 1. Improved Bot Deletion (`DELETE /api/freqtrade/bots/:instanceId`)
**Location**: `apps/api-gateway/routes/freqtrade-proxy.js`

**Changes**:
- Always attempts to clean up wallet allocation, even if orchestrator deletion fails
- Logs all steps for debugging
- Returns warnings if orchestrator cleanup failed but wallet was cleaned
- Ensures database stays in sync with reality

### 2. New Wallet Sync Endpoint (`POST /api/freqtrade/sync-wallet`)
**Location**: `apps/api-gateway/routes/freqtrade-proxy.js`

**Purpose**: Reconcile database allocations with actual running bots

**How it works**:
1. Fetches list of running bots from bot-orchestrator
2. Compares with bot allocations in user's database record
3. Identifies orphaned allocations (bots in database but not running)
4. Automatically returns funds to wallet for orphaned bots
5. Creates transaction records for audit trail

**Response**:
```json
{
  "success": true,
  "message": "Cleaned up N orphaned bot allocation(s)",
  "data": {
    "runningBots": ["bot-id-1", "bot-id-2"],
    "validAllocations": ["bot-id-1"],
    "cleanedBots": [
      {
        "botId": "anshjarvis2003-bot-1",
        "botName": "Bot 1",
        "returned": 1105.00,
        "pnl": 0
      }
    ],
    "totalReturned": 1105.00,
    "newWalletBalance": 18436.00
  }
}
```

### 3. Health Monitor Fix
**Location**: `apps/bot-orchestrator/lib/pool-health-monitor.js`

**Changes**:
- Health monitor now updates bot status from 'failed' to 'running' when it detects a bot is healthy
- Prevents bots from being stuck in 'failed' state due to transient provisioning errors

## How to Use

### For Users (Frontend)
Add a "Sync Wallet" button in the wallet/portfolio page that calls:
```typescript
POST /api/freqtrade/sync-wallet
Headers: { Authorization: `Bearer ${token}` }
```

### For Admins (Manual)
```bash
# Get auth token from browser localStorage
TOKEN="your-firebase-token"

# Call sync endpoint
curl -X POST https://api.crypto-pilot.dev/api/freqtrade/sync-wallet \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

## Testing the Fix

1. **Clean up current orphaned allocation**:
   - Call the sync endpoint to clean up `anshjarvis2003-bot-1`
   - Verify wallet balance increases by $1,105

2. **Test bot deletion**:
   - Provision a new bot
   - Delete it
   - Verify wallet is cleaned up even if container deletion fails

3. **Test sync endpoint**:
   - Manually create an allocation in database
   - Call sync endpoint
   - Verify orphaned allocation is cleaned up

## Next Steps

1. **Add frontend button** for wallet sync in portfolio page
2. **Add automatic sync** on page load (optional, could be expensive)
3. **Add periodic sync** job that runs every hour (optional)
4. **Add metrics** to track orphaned allocations over time

## Files Modified

1. `apps/api-gateway/routes/freqtrade-proxy.js` - Improved deletion + new sync endpoint
2. `apps/bot-orchestrator/lib/pool-health-monitor.js` - Auto-update bot status
3. `WALLET_SYNC_SOLUTION.md` - This documentation

## Prevention

To prevent this issue in the future:
1. Always use the sync endpoint after system restarts
2. Monitor for orphaned allocations
3. Consider adding database constraints
4. Add integration tests for deletion flow

