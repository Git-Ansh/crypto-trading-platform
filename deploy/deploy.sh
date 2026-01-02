#!/bin/bash
# Deploy script for VPS - crypto-trading-platform monorepo
# Usage: ./deploy.sh [api|bot|all|nginx|ssl]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

# Install dependencies
install_deps() {
    log_info "Installing dependencies..."
    cd "$REPO_ROOT"
    npm install --legacy-peer-deps
    
    log_info "Building shared packages..."
    npm run build:packages
}

# Deploy API Gateway
deploy_api() {
    log_info "Deploying API Gateway..."
    
    # Check for env file
    if [[ ! -f "$REPO_ROOT/apps/api-gateway/.env.systemd" ]]; then
        log_error "Missing .env.systemd file. Copy from .env.systemd.template and fill in values."
        exit 1
    fi
    
    # Install service
    cp "$SCRIPT_DIR/systemd/api-gateway.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable api-gateway
    systemctl restart api-gateway
    
    log_info "API Gateway deployed. Check status: systemctl status api-gateway"
}

# Deploy Bot Orchestrator
deploy_bot() {
    log_info "Deploying Bot Orchestrator..."
    
    # Check for env file
    if [[ ! -f "$REPO_ROOT/apps/bot-orchestrator/.env.systemd" ]]; then
        log_error "Missing .env.systemd file. Copy from .env.systemd.template and fill in values."
        exit 1
    fi
    
    # Ensure bot directories exist
    mkdir -p "$REPO_ROOT/freqtrade-instances"
    
    # Install service
    cp "$SCRIPT_DIR/systemd/bot-orchestrator.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable bot-orchestrator
    systemctl restart bot-orchestrator
    
    log_info "Bot Orchestrator deployed. Check status: systemctl status bot-orchestrator"
}

# Deploy Nginx configs
deploy_nginx() {
    log_info "Deploying Nginx configs..."
    
    # Copy configs
    cp "$SCRIPT_DIR/nginx/api.crypto-pilot.dev" /etc/nginx/sites-available/
    
    # Enable site if not already
    if [[ ! -L /etc/nginx/sites-enabled/api.crypto-pilot.dev ]]; then
        ln -s /etc/nginx/sites-available/api.crypto-pilot.dev /etc/nginx/sites-enabled/
    fi
    
    # Test and reload
    nginx -t
    systemctl reload nginx
    
    log_info "Nginx configs deployed"
}

# Setup SSL with certbot
setup_ssl() {
    log_info "Setting up SSL for api.crypto-pilot.dev..."
    
    # Check if cert already exists
    if [[ -d /etc/letsencrypt/live/api.crypto-pilot.dev ]]; then
        log_warn "Certificate already exists. Skipping..."
        return
    fi
    
    # Create temp nginx config without SSL for certbot
    cat > /etc/nginx/sites-available/api.crypto-pilot.dev.temp << 'EOF'
server {
    listen 80;
    server_name api.crypto-pilot.dev;
    
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    
    location / {
        return 301 https://$host$request_uri;
    }
}
EOF
    
    ln -sf /etc/nginx/sites-available/api.crypto-pilot.dev.temp /etc/nginx/sites-enabled/api.crypto-pilot.dev
    nginx -t && systemctl reload nginx
    
    # Run certbot
    certbot certonly --webroot -w /var/www/html -d api.crypto-pilot.dev
    
    # Restore full config
    ln -sf /etc/nginx/sites-available/api.crypto-pilot.dev /etc/nginx/sites-enabled/api.crypto-pilot.dev
    rm /etc/nginx/sites-available/api.crypto-pilot.dev.temp
    nginx -t && systemctl reload nginx
    
    log_info "SSL certificate installed"
}

# Show status
show_status() {
    echo ""
    log_info "Service Status:"
    echo "----------------------------------------"
    systemctl status api-gateway --no-pager -l 2>/dev/null || echo "api-gateway: not installed"
    echo ""
    systemctl status bot-orchestrator --no-pager -l 2>/dev/null || echo "bot-orchestrator: not installed"
    echo "----------------------------------------"
}

# Main
main() {
    check_root
    
    case "${1:-all}" in
        api)
            install_deps
            deploy_api
            ;;
        bot)
            install_deps
            deploy_bot
            ;;
        nginx)
            deploy_nginx
            ;;
        ssl)
            setup_ssl
            ;;
        all)
            install_deps
            deploy_api
            deploy_bot
            deploy_nginx
            ;;
        status)
            show_status
            ;;
        *)
            echo "Usage: $0 [api|bot|nginx|ssl|all|status]"
            exit 1
            ;;
    esac
    
    show_status
}

main "$@"
