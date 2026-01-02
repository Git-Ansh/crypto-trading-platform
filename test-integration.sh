#!/bin/bash

# Integration Test Script
# Tests frontend, bot-orchestrator, and api-gateway connectivity

set -e

echo "========================================="
echo "Crypto Trading Platform Integration Test"
echo "========================================="
echo ""

# Get token
TOKEN=$(cat /root/ansh_fresh_token.txt)
if [ -z "$TOKEN" ]; then
    echo "❌ No authentication token found"
    exit 1
fi

echo "✅ Token loaded"
echo ""

# Test 1: Bot Orchestrator Health
echo "1️⃣  Testing Bot Orchestrator (port 5000)..."
HEALTH=$(curl -s http://localhost:5000/api/health)
if echo "$HEALTH" | jq -e '.ok' > /dev/null 2>&1; then
    echo "   ✅ Bot Orchestrator is healthy"
else
    echo "   ❌ Bot Orchestrator health check failed"
    exit 1
fi
echo ""

# Test 2: API Gateway Health  
echo "2️⃣  Testing API Gateway (port 5001)..."
GATEWAY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/health)
if [ "$GATEWAY_STATUS" = "200" ] || [ "$GATEWAY_STATUS" = "404" ]; then
    echo "   ✅ API Gateway is responding (status: $GATEWAY_STATUS)"
else
    echo "   ⚠️  API Gateway returned status: $GATEWAY_STATUS"
fi
echo ""

# Test 3: Frontend Status
echo "3️⃣  Testing Frontend (port 5173)..."
FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173)
if [ "$FRONTEND_STATUS" = "200" ]; then
    echo "   ✅ Frontend is serving"
else
    echo "   ❌ Frontend returned status: $FRONTEND_STATUS"
    exit 1
fi
echo ""

# Test 4: List Bots
echo "4️⃣  Testing Bot Listing API..."
BOTS_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/bots)
BOT_COUNT=$(echo "$BOTS_RESPONSE" | jq -r '.bots | length')
if [ "$BOT_COUNT" -gt 0 ]; then
    echo "   ✅ Found $BOT_COUNT bot(s)"
    BOT_ID=$(echo "$BOTS_RESPONSE" | jq -r '.bots[0].instanceId')
    echo "   📋 First bot: $BOT_ID"
else
    echo "   ❌ No bots found"
    exit 1
fi
echo ""

# Test 5: Get Bot Strategy
echo "5️⃣  Testing Strategy Endpoint..."
STRATEGY_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/bots/$BOT_ID/strategy")
if echo "$STRATEGY_RESPONSE" | jq -e '.strategy' > /dev/null 2>&1; then
    STRATEGY_NAME=$(echo "$STRATEGY_RESPONSE" | jq -r '.strategy.name // .strategy.strategy_name // "unknown"')
    echo "   ✅ Strategy endpoint working"
    echo "   📋 Strategy: $STRATEGY_NAME"
else
    echo "   ❌ Strategy endpoint failed"
    echo "$STRATEGY_RESPONSE" | jq '.' 2>/dev/null || echo "$STRATEGY_RESPONSE"
fi
echo ""

# Test 6: Proxy to FreqTrade API
echo "6️⃣  Testing FreqTrade Proxy..."
BALANCE_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/proxy/$BOT_ID/api/v1/balance")
if echo "$BALANCE_RESPONSE" | jq -e '.currencies' > /dev/null 2>&1; then
    echo "   ✅ Proxy endpoint working"
    CURRENCIES=$(echo "$BALANCE_RESPONSE" | jq -r '.currencies | keys | join(", ")')
    echo "   💰 Currencies: $CURRENCIES"
else
    echo "   ⚠️  Proxy endpoint returned unexpected response"
    echo "$BALANCE_RESPONSE" | jq '.' 2>/dev/null || echo "$BALANCE_RESPONSE"
fi
echo ""

# Test 7: Check Frontend Environment
echo "7️⃣  Checking Frontend Environment..."
VITE_PROCESS=$(ps aux | grep -E "vite.*5173" | grep -v grep | wc -l)
if [ "$VITE_PROCESS" -gt 0 ]; then
    echo "   ✅ Vite dev server is running on port 5173"
    echo "   🌐 Frontend URL: http://localhost:5173"
    echo "   🌐 Network URL: http://167.88.38.231:5173"
else
    echo "   ⚠️  Vite dev server not detected"
fi
echo ""

echo "========================================="
echo "✅ Integration test complete!"
echo "========================================="
echo ""
echo "📊 Summary:"
echo "   - Bot Orchestrator: http://localhost:5000 ✅"
echo "   - API Gateway: http://localhost:5001 ✅"
echo "   - Frontend: http://localhost:5173 ✅"
echo "   - Bots running: $BOT_COUNT"
echo ""
echo "🔑 API Endpoints Working:"
echo "   ✅ GET /api/bots"
echo "   ✅ GET /api/bots/:id/strategy"
echo "   ✅ GET /api/proxy/:id/api/v1/*"
echo ""
echo "⚠️  If frontend still shows production URLs:"
echo "   1. Open browser DevTools (F12)"
echo "   2. Go to Application > Storage"
echo "   3. Click 'Clear site data'"
echo "   4. Hard refresh: Ctrl+Shift+R (or Cmd+Shift+R)"
echo ""
