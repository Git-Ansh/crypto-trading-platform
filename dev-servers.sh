#!/bin/bash

# Dev Servers Management Script
# Manages Frontend, API Gateway, and Bot Orchestrator in separate tmux sessions

set -e

PROJECT_ROOT="/root/crypto-trading-platform"
FRONTEND_DIR="$PROJECT_ROOT/apps/web"
API_GATEWAY_DIR="$PROJECT_ROOT/apps/api-gateway"
BOT_ORCHESTRATOR_DIR="$PROJECT_ROOT/apps/bot-orchestrator"

FRONTEND_PORT=5173
API_PORT=5001
BOT_PORT=5000

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

print_header() {
    echo -e "\n${BLUE}=== $1 ===${NC}\n"
}

print_status() {
    local service=$1
    local port=$2
    local status=$3
    
    if [ "$status" = "running" ]; then
        echo -e "${GREEN}✓${NC} $service (port $port): ${GREEN}RUNNING${NC}"
    else
        echo -e "${RED}✗${NC} $service (port $port): ${RED}STOPPED${NC}"
    fi
}

check_port() {
    local port=$1
    if netstat -tlnp 2>/dev/null | grep -q ":$port\s"; then
        echo "running"
    else
        echo "stopped"
    fi
}

port_in_use() {
    local port=$1
    netstat -tlnp 2>/dev/null | grep -q ":$port\s"
}

# ============================================================================
# STATUS COMMAND
# ============================================================================

status_cmd() {
    print_header "Dev Servers Status"
    
    local frontend_status=$(check_port $FRONTEND_PORT)
    local api_status=$(check_port $API_PORT)
    local bot_status=$(check_port $BOT_PORT)
    
    print_status "Frontend (Vite)" $FRONTEND_PORT $frontend_status
    print_status "API Gateway" $API_PORT $api_status
    print_status "Bot Orchestrator" $BOT_PORT $bot_status
    
    echo ""
    
    # Show URLs
    if [ "$frontend_status" = "running" ]; then
        echo -e "${YELLOW}Frontend URLs:${NC}"
        echo "  Local: http://localhost:$FRONTEND_PORT"
        echo "  Network: http://$(hostname -I | awk '{print $1}'):$FRONTEND_PORT"
        echo ""
    fi
    
    if [ "$api_status" = "running" ]; then
        echo -e "${YELLOW}API Gateway URLs:${NC}"
        echo "  http://localhost:$API_PORT"
        echo "  Health check: http://localhost:$API_PORT/api/health"
        echo ""
    fi
    
    if [ "$bot_status" = "running" ]; then
        echo -e "${YELLOW}Bot Orchestrator URLs:${NC}"
        echo "  http://localhost:$BOT_PORT"
        echo "  Health check: http://localhost:$BOT_PORT/health"
        echo ""
    fi
}

# ============================================================================
# START COMMANDS
# ============================================================================

start_frontend() {
    print_header "Starting Frontend Dev Server"
    
    if port_in_use $FRONTEND_PORT; then
        echo -e "${RED}Port $FRONTEND_PORT is already in use!${NC}"
        echo "Kill existing process with: pkill -f 'npm run dev' or lsof -ti:$FRONTEND_PORT | xargs kill -9"
        exit 1
    fi
    
    if ! command -v tmux &> /dev/null; then
        echo -e "${YELLOW}tmux not found, starting in background...${NC}"
        cd "$FRONTEND_DIR"
        npm run dev > /tmp/frontend.log 2>&1 &
        echo -e "${GREEN}Frontend started in background (PID: $!)${NC}"
        echo "Logs: tail -f /tmp/frontend.log"
        return
    fi
    
    # Use tmux if available
    if tmux has-session -t frontend 2>/dev/null; then
        tmux kill-session -t frontend
    fi
    
    tmux new-session -d -s frontend -c "$FRONTEND_DIR" "npm run dev"
    echo -e "${GREEN}Frontend started in tmux session 'frontend'${NC}"
    echo -e "Attach with: ${YELLOW}tmux attach -t frontend${NC}"
    sleep 2
}

start_api_gateway() {
    print_header "Starting API Gateway"
    
    if port_in_use $API_PORT; then
        echo -e "${RED}Port $API_PORT is already in use!${NC}"
        echo "Kill existing process with: lsof -ti:$API_PORT | xargs kill -9"
        exit 1
    fi
    
    if ! command -v tmux &> /dev/null; then
        echo -e "${YELLOW}tmux not found, starting in background...${NC}"
        cd "$API_GATEWAY_DIR"
        NODE_ENV=development node index.js > /tmp/api-gateway.log 2>&1 &
        echo -e "${GREEN}API Gateway started in background (PID: $!)${NC}"
        echo "Logs: tail -f /tmp/api-gateway.log"
        return
    fi
    
    # Use tmux if available
    if tmux has-session -t api-gateway 2>/dev/null; then
        tmux kill-session -t api-gateway
    fi
    
    tmux new-session -d -s api-gateway -c "$API_GATEWAY_DIR" "NODE_ENV=development node index.js"
    echo -e "${GREEN}API Gateway started in tmux session 'api-gateway'${NC}"
    echo -e "Attach with: ${YELLOW}tmux attach -t api-gateway${NC}"
    sleep 2
}

start_bot_orchestrator() {
    print_header "Starting Bot Orchestrator"
    
    if port_in_use $BOT_PORT; then
        echo -e "${RED}Port $BOT_PORT is already in use!${NC}"
        echo "Kill existing process with: lsof -ti:$BOT_PORT | xargs kill -9"
        exit 1
    fi
    
    if ! command -v tmux &> /dev/null; then
        echo -e "${YELLOW}tmux not found, starting in background...${NC}"
        cd "$BOT_ORCHESTRATOR_DIR"
        node index.js > /tmp/bot-orchestrator.log 2>&1 &
        echo -e "${GREEN}Bot Orchestrator started in background (PID: $!)${NC}"
        echo "Logs: tail -f /tmp/bot-orchestrator.log"
        return
    fi
    
    # Use tmux if available
    if tmux has-session -t bot-orchestrator 2>/dev/null; then
        tmux kill-session -t bot-orchestrator
    fi
    
    tmux new-session -d -s bot-orchestrator -c "$BOT_ORCHESTRATOR_DIR" "node index.js"
    echo -e "${GREEN}Bot Orchestrator started in tmux session 'bot-orchestrator'${NC}"
    echo -e "Attach with: ${YELLOW}tmux attach -t bot-orchestrator${NC}"
    sleep 2
}

# ============================================================================
# STOP COMMANDS
# ============================================================================

stop_frontend() {
    print_header "Stopping Frontend"
    
    if tmux has-session -t frontend 2>/dev/null; then
        tmux kill-session -t frontend
        echo -e "${GREEN}Frontend tmux session killed${NC}"
    else
        pkill -f "npm run dev" || true
        echo -e "${GREEN}Frontend process killed${NC}"
    fi
}

stop_api_gateway() {
    print_header "Stopping API Gateway"
    
    if tmux has-session -t api-gateway 2>/dev/null; then
        tmux kill-session -t api-gateway
        echo -e "${GREEN}API Gateway tmux session killed${NC}"
    else
        pkill -f "node.*api-gateway" || true
        echo -e "${GREEN}API Gateway process killed${NC}"
    fi
}

stop_bot_orchestrator() {
    print_header "Stopping Bot Orchestrator"
    
    if tmux has-session -t bot-orchestrator 2>/dev/null; then
        tmux kill-session -t bot-orchestrator
        echo -e "${GREEN}Bot Orchestrator tmux session killed${NC}"
    else
        pkill -f "node.*bot-orchestrator" || true
        echo -e "${GREEN}Bot Orchestrator process killed${NC}"
    fi
}

# ============================================================================
# COMBINED COMMANDS
# ============================================================================

start_all() {
    print_header "Starting All Dev Servers"
    
    if tmux has-session -t crypto-trading 2>/dev/null; then
        echo -e "${YELLOW}Session 'crypto-trading' already exists. Use 'stop-all' first.${NC}"
        exit 1
    fi
    
    # Create main session with 3 windows
    tmux new-session -d -s crypto-trading -c "$FRONTEND_DIR"
    tmux rename-window -t crypto-trading frontend
    
    # Window 1: Frontend
    tmux send-keys -t crypto-trading:frontend "cd $FRONTEND_DIR && npm run dev" Enter
    
    # Window 2: API Gateway
    tmux new-window -t crypto-trading -n api-gateway -c "$API_GATEWAY_DIR"
    tmux send-keys -t crypto-trading:api-gateway "NODE_ENV=development node index.js" Enter
    
    # Window 3: Bot Orchestrator
    tmux new-window -t crypto-trading -n bot-orchestrator -c "$BOT_ORCHESTRATOR_DIR"
    tmux send-keys -t crypto-trading:bot-orchestrator "node index.js" Enter
    
    echo -e "${GREEN}All dev servers started in tmux session 'crypto-trading'${NC}"
    echo ""
    echo -e "Windows:"
    echo -e "  ${YELLOW}0: frontend${NC}        - npm run dev"
    echo -e "  ${YELLOW}1: api-gateway${NC}     - node index.js"
    echo -e "  ${YELLOW}2: bot-orchestrator${NC} - node index.js"
    echo ""
    echo -e "Attach with: ${YELLOW}tmux attach -t crypto-trading${NC}"
    echo -e "Switch windows: ${YELLOW}Ctrl+b [0|1|2]${NC}"
    echo ""
    
    sleep 3
    status_cmd
}

stop_all() {
    print_header "Stopping All Dev Servers"
    
    if tmux has-session -t crypto-trading 2>/dev/null; then
        tmux kill-session -t crypto-trading
        echo -e "${GREEN}All tmux sessions killed${NC}"
    else
        pkill -f "npm run dev" || true
        pkill -f "node.*api-gateway" || true
        pkill -f "node.*bot-orchestrator" || true
        echo -e "${GREEN}All processes killed${NC}"
    fi
}

restart_all() {
    stop_all
    sleep 2
    start_all
}

# ============================================================================
# TMUX HELPERS
# ============================================================================

list_sessions() {
    print_header "Active TMux Sessions"
    
    if ! command -v tmux &> /dev/null; then
        echo -e "${YELLOW}tmux not installed${NC}"
        return
    fi
    
    tmux list-sessions 2>/dev/null || echo -e "${YELLOW}No active tmux sessions${NC}"
}

attach() {
    if ! command -v tmux &> /dev/null; then
        echo -e "${RED}tmux not installed${NC}"
        exit 1
    fi
    
    if [ -z "$1" ]; then
        echo -e "${YELLOW}Usage: $0 attach [frontend|api-gateway|bot-orchestrator|crypto-trading]${NC}"
        echo ""
        echo "Active sessions:"
        tmux list-sessions 2>/dev/null || echo "No sessions"
        exit 1
    fi
    
    tmux attach -t "$1"
}

# ============================================================================
# LOGS
# ============================================================================

logs() {
    local service=$1
    
    case $service in
        frontend)
            if [ -f /tmp/frontend.log ]; then
                tail -f /tmp/frontend.log
            else
                echo "No log file found for frontend"
            fi
            ;;
        api|api-gateway)
            if [ -f /tmp/api-gateway.log ]; then
                tail -f /tmp/api-gateway.log
            else
                echo "No log file found for API Gateway"
            fi
            ;;
        bot|bot-orchestrator)
            if [ -f /tmp/bot-orchestrator.log ]; then
                tail -f /tmp/bot-orchestrator.log
            else
                echo "No log file found for Bot Orchestrator"
            fi
            ;;
        *)
            echo -e "${YELLOW}Usage: $0 logs [frontend|api-gateway|bot-orchestrator]${NC}"
            exit 1
            ;;
    esac
}

# ============================================================================
# HELP
# ============================================================================

show_help() {
    cat << EOF
${BLUE}Crypto Trading Platform - Dev Servers Manager${NC}

${YELLOW}Usage:${NC}
  $0 [COMMAND] [OPTIONS]

${YELLOW}Commands:${NC}
  ${GREEN}status${NC}                  - Show status of all dev servers
  
  ${GREEN}start${NC}                   - Start specific dev server
    start frontend              - Start Vite frontend dev server
    start api-gateway           - Start API Gateway
    start bot-orchestrator      - Start Bot Orchestrator
    
  ${GREEN}start-all${NC}                - Start all 3 dev servers in separate tmux windows
  
  ${GREEN}stop${NC}                    - Stop specific dev server
    stop frontend
    stop api-gateway
    stop bot-orchestrator
    
  ${GREEN}stop-all${NC}                - Stop all dev servers and tmux sessions
  
  ${GREEN}restart-all${NC}             - Restart all dev servers
  
  ${GREEN}attach${NC}                  - Attach to tmux session
    attach frontend
    attach api-gateway
    attach bot-orchestrator
    attach crypto-trading       - Main session with all 3 windows
    
  ${GREEN}sessions${NC}                - List active tmux sessions
  
  ${GREEN}logs${NC}                    - Tail logs from background process
    logs frontend
    logs api-gateway
    logs bot-orchestrator

${YELLOW}Examples:${NC}
  # Start all servers in tmux with 3 windows
  $0 start-all

  # Check status
  $0 status

  # Attach to main session
  $0 attach crypto-trading

  # Start just the API gateway
  $0 start api-gateway

  # Stop everything
  $0 stop-all

${YELLOW}Ports:${NC}
  Frontend (Vite):     http://localhost:5173
  API Gateway:         http://localhost:5001
  Bot Orchestrator:    http://localhost:5000

${YELLOW}Requirements:${NC}
  - tmux (optional, for separate terminals)
  - Node.js 20.19+
  - npm

EOF
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    case "$1" in
        status)
            status_cmd
            ;;
        start)
            case "$2" in
                frontend)
                    start_frontend
                    status_cmd
                    ;;
                api-gateway|api)
                    start_api_gateway
                    status_cmd
                    ;;
                bot-orchestrator|bot)
                    start_bot_orchestrator
                    status_cmd
                    ;;
                *)
                    echo -e "${RED}Unknown service: $2${NC}"
                    echo -e "${YELLOW}Use: $0 start [frontend|api-gateway|bot-orchestrator]${NC}"
                    exit 1
                    ;;
            esac
            ;;
        stop)
            case "$2" in
                frontend)
                    stop_frontend
                    ;;
                api-gateway|api)
                    stop_api_gateway
                    ;;
                bot-orchestrator|bot)
                    stop_bot_orchestrator
                    ;;
                *)
                    echo -e "${RED}Unknown service: $2${NC}"
                    echo -e "${YELLOW}Use: $0 stop [frontend|api-gateway|bot-orchestrator]${NC}"
                    exit 1
                    ;;
            esac
            ;;
        start-all)
            start_all
            ;;
        stop-all)
            stop_all
            ;;
        restart-all)
            restart_all
            ;;
        attach)
            attach "$2"
            ;;
        sessions)
            list_sessions
            ;;
        logs)
            logs "$2"
            ;;
        help|--help|-h)
            show_help
            ;;
        "")
            show_help
            ;;
        *)
            echo -e "${RED}Unknown command: $1${NC}"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
