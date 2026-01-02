# Universal Settings System

## Overview

The Universal Settings system provides per-user bot configuration that persists across restarts and is managed independently from git version control.

## File Structure

```
bot-manager/
├── universal-settings-global.json          # DEFAULT TEMPLATE (tracked in git)
├── universal-settings-{userId}.json        # Per-user settings (NOT tracked in git)
└── universal-risk-manager.js               # Implementation
```

## How It Works

### 1. Default Template
**File**: `universal-settings-global.json`
- **Purpose**: Default settings for newly provisioned bots
- **Git Status**: ✅ Tracked in git (part of codebase)
- **Contains**:
  ```json
  {
    "riskLevel": 50,
    "autoRebalance": true,
    "dcaEnabled": true,
    "enabled": true
  }
  ```

### 2. Per-User Settings
**Pattern**: `universal-settings-{userId}.json`
- **Purpose**: User-specific configuration for their bots
- **Git Status**: ❌ NOT tracked in git (gitignored)
- **Created**: Automatically when user modifies settings
- **Example**: `universal-settings-Js1Gaz4sMPPiDNgFbmAgDFLe4je2.json`

## Settings Parameters

| Parameter | Type | Range | Description |
|-----------|------|-------|-------------|
| `riskLevel` | number | 0-100 | Controls position sizing, stop loss, DCA levels |
| `autoRebalance` | boolean | true/false | Enable/disable portfolio rebalancing |
| `dcaEnabled` | boolean | true/false | Enable/disable Dollar Cost Averaging |
| `enabled` | boolean | true/false | Master switch for universal risk management |

## Risk Level Impact

The `riskLevel` (0-100) dynamically adjusts:

| Risk Level | Max Drawdown | Risk Per Trade | Position Size | Stop Loss | DCA Orders |
|------------|--------------|----------------|---------------|-----------|------------|
| 0% (Conservative) | 5% | 1% | 5% | -4% | 2 |
| 50% (Balanced) | 15% | 2% | 10% | -8% | 3-4 |
| 100% (Aggressive) | 25% | 3% | 15% | -12% | 5 |

## API Endpoints

### Get Universal Settings
```http
GET /api/universal-settings
Authorization: Bearer {jwt_token}
```

**Response**:
```json
{
  "success": true,
  "bots": [
    {
      "instanceId": "bot-1",
      "settings": {
        "riskLevel": 65,
        "autoRebalance": true,
        "dcaEnabled": false,
        "enabled": true
      }
    }
  ]
}
```

### Update Bot Settings
```http
PUT /api/universal-settings/:instanceId
Authorization: Bearer {jwt_token}
Content-Type: application/json

{
  "riskLevel": 75,
  "autoRebalance": false
}
```

**Response**:
```json
{
  "success": true,
  "message": "Settings updated",
  "settings": {
    "riskLevel": 75,
    "autoRebalance": false,
    "dcaEnabled": true,
    "enabled": true
  }
}
```

## Development Guidelines

### ✅ DO:
- Commit changes to `universal-settings-global.json` (default template)
- Update default values carefully (affects new bots)
- Test changes with different risk levels
- Document new settings in this README

### ❌ DON'T:
- Commit user-specific settings files (`universal-settings-*.json`)
- Modify user settings files directly (use API)
- Hard-code user IDs in settings logic
- Bypass the UniversalRiskManager class

## Git Configuration

The `.gitignore` is configured to:
```gitignore
# Ignore user-specific settings
bot-manager/universal-settings-*.json

# BUT track the global template
!bot-manager/universal-settings-global.json

# Ignore user directories
bot-manager/*/
```

## Testing Settings

### Test Default Template
```bash
# View current defaults
cat bot-manager/universal-settings-global.json

# Test with new bot provisioning
curl -X POST http://localhost:5000/api/provision \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"strategy": "EmaRsiStrategy"}'
```

### Test User Settings Update
```bash
# Update settings for a bot
curl -X PUT http://localhost:5000/api/universal-settings/bot-1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"riskLevel": 80, "dcaEnabled": false}'

# Verify settings persisted
ls -la bot-manager/universal-settings-*.json
```

## Troubleshooting

### Settings Not Persisting
1. Check file permissions: `ls -la bot-manager/universal-settings-*.json`
2. Verify bot-manager has write access
3. Check logs for save errors: `journalctl -u bot-manager -n 50`

### Default Values Not Applied
1. Verify `universal-settings-global.json` exists
2. Check JSON syntax is valid: `cat bot-manager/universal-settings-global.json | jq .`
3. Restart bot-manager service

### Settings Showing in Git
1. Verify `.gitignore` patterns are correct
2. Remove from tracking: `git rm --cached bot-manager/universal-settings-{userId}.json`
3. Confirm ignored: `git check-ignore -v bot-manager/universal-settings-{userId}.json`

## Architecture Notes

### Why Per-User Files?
- **Performance**: No database queries for frequently-accessed settings
- **Simplicity**: JSON files are human-readable and easy to debug
- **Portability**: Settings travel with the bot-manager service
- **Backup**: Easy to backup/restore user configurations

### Why Not Database?
- Settings are read on every trade decision (hot path)
- File system cache is faster than DB for frequently-accessed data
- Simpler deployment (no migrations needed)
- Still uses Turso DB for trade history and analytics

## Future Enhancements

See [UNIVERSAL_FEATURES_PROPOSAL.md](./UNIVERSAL_FEATURES_PROPOSAL.md) for planned additions:
- Multiple take profit levels
- Advanced trailing stops
- Max daily loss circuit breaker
- Trading schedule/hours
- Volatility-based position sizing
- And more...

---

**Last Updated**: December 30, 2025  
**Maintainer**: Crypto-Pilot Team
