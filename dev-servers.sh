#!/bin/bash

#===============================================================================
# Development Server Control Script
#===============================================================================
# 
# Purpose: Manage all development servers (API Gateway, Bot Orchestrator, Web)
# Usage:   ./dev-servers.sh [command] [service]
#
# Commands:
#   start [service]   - Start all servers or specific service
#   stop [service]    - Stop all servers or specific service
#   restart [service] - Restart all servers or specific service
#   status [service]  - Check status of all servers or specific service
#   logs [service]    - View logs (tail -f) for all or specific service
#
# Services:
#   api  - API Gateway (port 5001)
#   bot  - Bot Orchestrator (port 5000)
#   web  - Frontend (Vite dev server, port 5173)
#
# Examples:
#   ./dev-servers.sh start          # Start all 3 servers
#   ./dev-servers.sh stop api       # Stop API Gateway only
#   ./dev-servers.sh restart bot    # Restart Bot Orchestrator only
#   ./dev-servers.sh status         # Check status of all servers
#   ./dev-servers.sh logs web       # View frontend logs
#
# Features:
#   - Uses relative paths (works on any machine)
#   - PID tracking for reliable process management
#   - Color-coded output for easy reading
#   - Proper background process management
#   - Log files with timestamps
#
#===============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get script directory (works with symlinks)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Service directories (relative to script directory)
API_DIR="${SCRIPT_DIR}/apps/api-gateway"
BOT_DIR="${SCRIPT_DIR}/apps/bot-orchestrator"
WEB_DIR="${SCRIPT_DIR}/apps/web"

# PID files (stored in project root)
PID_DIR="${SCRIPT_DIR}/.dev-pids"
mkdir -p "${PID_DIR}"

API_PID="${PID_DIR}/api-gateway.pid"
BOT_PID="${PID_DIR}/bot-orchestrator.pid"
WEB_PID="${PID_DIR}/web.pid"

# Log files
LOG_DIR="${SCRIPT_DIR}/.dev-logs"
mkdir -p "${LOG_DIR}"

API_LOG="${LOG_DIR}/api-gateway.log"
BOT_LOG="${LOG_DIR}/bot-orchestrator.log"
WEB_LOG="${LOG_DIR}/web.log"

#===============================================================================
# Helper Functions
#===============================================================================

print_header() {
    echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Check if a process is running by PID file
is_running() {
    local pid_file="$1"
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0  # Running
        fi
    fi
    return 1  # Not running
}

# Get port for a service
get_port() {
    case "$1" in
        api) echo "5001" ;;
        bot) echo "5000" ;;
        web) echo "5173" ;;
    esac
}

# Check if port is in use
is_port_in_use() {
    local port="$1"
    if lsof -i ":$port" > /dev/null 2>&1; then
        return 0  # Port in use
    fi
    return 1  # Port free
}

#===============================================================================
# Start Functions
#===============================================================================

start_api() {
    print_info "Starting API Gateway..."
    
    if is_running "$API_PID"; then
        print_warning "API Gateway is already running (PID: $(cat $API_PID))"
        return 0
    fi
    
    cd "$API_DIR"
    
    # Check if .env exists
    if [ ! -f ".env" ]; then
        print_error ".env file not found in $API_DIR"
        print_info "Create apps/api-gateway/.env (see DEVELOPMENT_SETUP.md)"
        return 1
    fi
    
    # Start the server
    node index.js > "$API_LOG" 2>&1 &
    local pid=$!
    echo $pid > "$API_PID"
    
    sleep 2
    
    if is_running "$API_PID"; then
        print_success "API Gateway started (PID: $pid, Port: 5001)"
        print_info "Logs: $API_LOG"
    else
        print_error "API Gateway failed to start. Check logs: $API_LOG"
        return 1
    fi
}

start_bot() {
    print_info "Starting Bot Orchestrator..."
    
    if is_running "$BOT_PID"; then
        print_warning "Bot Orchestrator is already running (PID: $(cat $BOT_PID))"
        return 0
    fi
    
    cd "$BOT_DIR"
    
    # Check if .env exists
    if [ ! -f ".env" ]; then
        print_error ".env file not found in $BOT_DIR"
        print_info "Create apps/bot-orchestrator/.env (see DEVELOPMENT_SETUP.md)"
        return 1
    fi
    
    # Start the server
    node index.js > "$BOT_LOG" 2>&1 &
    local pid=$!
    echo $pid > "$BOT_PID"
    
    sleep 2
    
    if is_running "$BOT_PID"; then
        print_success "Bot Orchestrator started (PID: $pid, Port: 5000)"
        print_info "Logs: $BOT_LOG"
    else
        print_error "Bot Orchestrator failed to start. Check logs: $BOT_LOG"
        return 1
    fi
}

start_web() {
    print_info "Starting Web Frontend..."
    
    if is_running "$WEB_PID"; then
        print_warning "Web Frontend is already running (PID: $(cat $WEB_PID))"
        return 0
    fi
    
    cd "$WEB_DIR"
    
    # Check if .env exists
    if [ ! -f ".env" ]; then
        print_error ".env file not found in $WEB_DIR"
        print_info "Create apps/web/.env (see DEVELOPMENT_SETUP.md)"
        return 1
    fi
    
    # Start Vite dev server
    npm run dev > "$WEB_LOG" 2>&1 &
    local pid=$!
    echo $pid > "$WEB_PID"
    
    sleep 3
    
    if is_running "$WEB_PID"; then
        print_success "Web Frontend started (PID: $pid, Port: 5173)"
        print_info "Logs: $WEB_LOG"
        print_info "Open: http://localhost:5173"
    else
        print_error "Web Frontend failed to start. Check logs: $WEB_LOG"
        return 1
    fi
}

#===============================================================================
# Stop Functions
#===============================================================================

stop_api() {
    print_info "Stopping API Gateway..."
    
    if is_running "$API_PID"; then
        local pid=$(cat "$API_PID")
        kill $pid 2>/dev/null || true
        sleep 1
        
        # Force kill if still running
        if ps -p $pid > /dev/null 2>&1; then
            kill -9 $pid 2>/dev/null || true
        fi
        
        rm -f "$API_PID"
        print_success "API Gateway stopped"
    else
        print_warning "API Gateway is not running"
    fi
}

stop_bot() {
    print_info "Stopping Bot Orchestrator..."
    
    if is_running "$BOT_PID"; then
        local pid=$(cat "$BOT_PID")
        kill $pid 2>/dev/null || true
        sleep 1
        
        # Force kill if still running
        if ps -p $pid > /dev/null 2>&1; then
            kill -9 $pid 2>/dev/null || true
        fi
        
        rm -f "$BOT_PID"
        print_success "Bot Orchestrator stopped"
    else
        print_warning "Bot Orchestrator is not running"
    fi
}

stop_web() {
    print_info "Stopping Web Frontend..."
    
    if is_running "$WEB_PID"; then
        local pid=$(cat "$WEB_PID")
        
        # Kill the entire process group (Vite spawns child processes)
        pkill -P $pid 2>/dev/null || true
        kill $pid 2>/dev/null || true
        sleep 1
        
        # Force kill if still running
        if ps -p $pid > /dev/null 2>&1; then
            kill -9 $pid 2>/dev/null || true
        fi
        
        rm -f "$WEB_PID"
        print_success "Web Frontend stopped"
    else
        print_warning "Web Frontend is not running"
    fi
}

#===============================================================================
# Status Function
#===============================================================================

show_status() {
    local service="$1"
    
    print_header "Development Servers Status"
    
    if [ "$service" = "api" ] || [ -z "$service" ]; then
        echo -n "API Gateway (5001):       "
        if is_running "$API_PID"; then
            local pid=$(cat "$API_PID")
            if is_port_in_use 5001; then
                print_success "Running (PID: $pid) ✓"
            else
                print_warning "Process running but port 5001 not listening (PID: $pid)"
            fi
        else
            print_error "Stopped"
        fi
    fi
    
    if [ "$service" = "bot" ] || [ -z "$service" ]; then
        echo -n "Bot Orchestrator (5000):  "
        if is_running "$BOT_PID"; then
            local pid=$(cat "$BOT_PID")
            if is_port_in_use 5000; then
                print_success "Running (PID: $pid) ✓"
            else
                print_warning "Process running but port 5000 not listening (PID: $pid)"
            fi
        else
            print_error "Stopped"
        fi
    fi
    
    if [ "$service" = "web" ] || [ -z "$service" ]; then
        echo -n "Web Frontend (5173):      "
        if is_running "$WEB_PID"; then
            local pid=$(cat "$WEB_PID")
            if is_port_in_use 5173; then
                print_success "Running (PID: $pid) ✓"
            else
                print_warning "Process running but port 5173 not listening (PID: $pid)"
            fi
        else
            print_error "Stopped"
        fi
    fi
    
    echo ""
    print_info "Logs directory: $LOG_DIR"
    print_info "PID directory: $PID_DIR"
}

#===============================================================================
# Logs Function
#===============================================================================

show_logs() {
    local service="$1"
    
    case "$service" in
        api)
            print_header "API Gateway Logs (Ctrl+C to exit)"
            tail -f "$API_LOG" 2>/dev/null || print_error "Log file not found: $API_LOG"
            ;;
        bot)
            print_header "Bot Orchestrator Logs (Ctrl+C to exit)"
            tail -f "$BOT_LOG" 2>/dev/null || print_error "Log file not found: $BOT_LOG"
            ;;
        web)
            print_header "Web Frontend Logs (Ctrl+C to exit)"
            tail -f "$WEB_LOG" 2>/dev/null || print_error "Log file not found: $WEB_LOG"
            ;;
        *)
            print_header "All Logs (Ctrl+C to exit)"
            print_info "API Gateway: $API_LOG"
            print_info "Bot Orchestrator: $BOT_LOG"
            print_info "Web Frontend: $WEB_LOG"
            echo ""
            tail -f "$API_LOG" "$BOT_LOG" "$WEB_LOG" 2>/dev/null || print_error "No log files found"
            ;;
    esac
}

#===============================================================================
# Main Command Handler
#===============================================================================

case "${1:-}" in
    start)
        service="${2:-all}"
        print_header "Starting Development Servers"
        
        case "$service" in
            api)
                start_api
                ;;
            bot)
                start_bot
                ;;
            web)
                start_web
                ;;
            all|*)
                start_api
                start_bot
                start_web
                ;;
        esac
        
        echo ""
        show_status "$service"
        ;;
        
    stop)
        service="${2:-all}"
        print_header "Stopping Development Servers"
        
        case "$service" in
            api)
                stop_api
                ;;
            bot)
                stop_bot
                ;;
            web)
                stop_web
                ;;
            all|*)
                stop_web
                stop_bot
                stop_api
                ;;
        esac
        
        echo ""
        show_status "$service"
        ;;
        
    restart)
        service="${2:-all}"
        print_header "Restarting Development Servers"
        
        case "$service" in
            api)
                stop_api
                sleep 1
                start_api
                ;;
            bot)
                stop_bot
                sleep 1
                start_bot
                ;;
            web)
                stop_web
                sleep 1
                start_web
                ;;
            all|*)
                stop_web
                stop_bot
                stop_api
                sleep 1
                start_api
                start_bot
                start_web
                ;;
        esac
        
        echo ""
        show_status "$service"
        ;;
        
    status)
        show_status "${2:-}"
        ;;
        
    logs)
        show_logs "${2:-all}"
        ;;
        
    *)
        echo "Usage: $0 {start|stop|restart|status|logs} [service]"
        echo ""
        echo "Commands:"
        echo "  start [service]   - Start all servers or specific service"
        echo "  stop [service]    - Stop all servers or specific service"
        echo "  restart [service] - Restart all servers or specific service"
        echo "  status [service]  - Check status of all servers or specific service"
        echo "  logs [service]    - View logs for all or specific service"
        echo ""
        echo "Services:"
        echo "  api  - API Gateway (port 5001)"
        echo "  bot  - Bot Orchestrator (port 5000)"
        echo "  web  - Web Frontend (port 5173)"
        echo ""
        echo "Examples:"
        echo "  $0 start          # Start all 3 servers"
        echo "  $0 stop api       # Stop API Gateway only"
        echo "  $0 restart bot    # Restart Bot Orchestrator only"
        echo "  $0 status         # Check status of all servers"
        echo "  $0 logs web       # View frontend logs"
        exit 1
        ;;
esac
