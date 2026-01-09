#!/bin/bash
# Deployment script for Crypto Trading Platform monorepo (Production VPS)

set -e

# Get script directory and project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR"

echo "🚀 Deploying Crypto Trading Platform..."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}❌ Node.js version must be 20 or higher. Current: $(node --version)${NC}"
    echo -e "${YELLOW}Run: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Node.js version: $(node --version)${NC}"

# Change to project root
cd "$PROJECT_ROOT"
echo -e "${GREEN}✓ Working directory: $(pwd)${NC}"

# Stop services
echo -e "${YELLOW}Stopping services...${NC}"
sudo systemctl stop api-gateway bot-orchestrator 2>/dev/null || true
echo -e "${GREEN}✓ Services stopped${NC}"

# Install/update dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
npm ci --omit=dev
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Build shared packages
echo -e "${YELLOW}Building shared packages...${NC}"
npm run build:packages
echo -e "${GREEN}✓ Packages built${NC}"

# Copy systemd service files
echo -e "${YELLOW}Installing systemd services...${NC}"
sudo cp infrastructure/systemd/api-gateway.service /etc/systemd/system/
sudo cp infrastructure/systemd/bot-orchestrator.service /etc/systemd/system/
sudo systemctl daemon-reload
echo -e "${GREEN}✓ Systemd services installed${NC}"

# Enable services
echo -e "${YELLOW}Enabling services...${NC}"
sudo systemctl enable api-gateway
sudo systemctl enable bot-orchestrator
echo -e "${GREEN}✓ Services enabled${NC}"

# Start services
echo -e "${YELLOW}Starting services...${NC}"
sudo systemctl start api-gateway
sudo systemctl start bot-orchestrator
echo -e "${GREEN}✓ Services started${NC}"

# Wait a moment for services to start
sleep 5

# Check service status
echo -e "\n${YELLOW}Service Status:${NC}"
sudo systemctl status api-gateway --no-pager -l | head -15
echo ""
sudo systemctl status bot-orchestrator --no-pager -l | head -15

# Test endpoints
echo -e "\n${YELLOW}Testing endpoints...${NC}"

if curl -sf http://localhost:5001/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ API Gateway responding on port 5001${NC}"
else
    echo -e "${RED}✗ API Gateway not responding${NC}"
fi

if curl -sf http://localhost:5000/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Bot Orchestrator responding on port 5000${NC}"
else
    echo -e "${RED}✗ Bot Orchestrator not responding${NC}"
fi

echo -e "\n${GREEN}🎉 Deployment complete!${NC}"
echo -e "\nView logs:"
echo -e "  sudo journalctl -u api-gateway -f"
echo -e "  sudo journalctl -u bot-orchestrator -f"
echo -e "\nManage services:"
echo -e "  sudo systemctl restart api-gateway bot-orchestrator"
echo -e "  sudo systemctl status api-gateway bot-orchestrator"
echo -e "  sudo journalctl -u api-gateway -f"
echo -e "  sudo journalctl -u bot-orchestrator -f"
echo -e "\nManage services:"
echo -e "  sudo systemctl restart api-gateway bot-orchestrator"
echo -e "  sudo systemctl status api-gateway bot-orchestrator"
