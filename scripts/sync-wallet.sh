#!/bin/bash

# Wallet Sync Script
# This script calls the wallet sync endpoint to clean up orphaned bot allocations

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Wallet Sync Script ===${NC}"
echo ""

# Check if token is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Firebase auth token required${NC}"
  echo "Usage: $0 <firebase-token>"
  echo ""
  echo "To get your token:"
  echo "1. Open browser console on crypto-pilot.dev"
  echo "2. Run: localStorage.getItem('firebaseToken')"
  echo "3. Copy the token (without quotes)"
  exit 1
fi

TOKEN="$1"
API_URL="https://api.crypto-pilot.dev/api/freqtrade/sync-wallet"

echo -e "${YELLOW}Calling sync endpoint...${NC}"
echo "URL: $API_URL"
echo ""

# Call the sync endpoint
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json")

# Check if curl succeeded
if [ $? -ne 0 ]; then
  echo -e "${RED}Error: Failed to call API${NC}"
  exit 1
fi

# Pretty print the response
echo -e "${GREEN}Response:${NC}"
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"

# Check if successful
SUCCESS=$(echo "$RESPONSE" | jq -r '.success' 2>/dev/null)
if [ "$SUCCESS" = "true" ]; then
  echo ""
  echo -e "${GREEN}✓ Wallet sync completed successfully${NC}"
  
  # Show summary
  CLEANED=$(echo "$RESPONSE" | jq -r '.data.cleanedBots | length' 2>/dev/null)
  RETURNED=$(echo "$RESPONSE" | jq -r '.data.totalReturned' 2>/dev/null)
  NEW_BALANCE=$(echo "$RESPONSE" | jq -r '.data.newWalletBalance' 2>/dev/null)
  
  if [ "$CLEANED" != "null" ] && [ "$CLEANED" != "0" ]; then
    echo -e "${YELLOW}Summary:${NC}"
    echo "  - Cleaned bots: $CLEANED"
    echo "  - Total returned: \$$RETURNED"
    echo "  - New wallet balance: \$$NEW_BALANCE"
  fi
else
  echo ""
  echo -e "${RED}✗ Wallet sync failed${NC}"
  MESSAGE=$(echo "$RESPONSE" | jq -r '.message' 2>/dev/null)
  echo "Error: $MESSAGE"
  exit 1
fi

