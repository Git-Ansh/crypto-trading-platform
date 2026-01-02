#!/bin/bash
# Pool Container Entrypoint Script
# Initializes the pool container environment and starts supervisord

set -e

echo "========================================"
echo " FreqTrade Pool Container Starting"
echo "========================================"
echo " Pool Base Dir: /pool"
echo " Supervisor Config: /etc/supervisor/supervisord.conf"
echo " Bot Configs: /etc/supervisor/conf.d/"
echo "========================================"

# Ensure directories exist with proper permissions
mkdir -p /pool/bots
mkdir -p /pool/logs
mkdir -p /pool/configs
mkdir -p /var/log/supervisor

# Note: /etc/supervisor/conf.d/ and placeholder.conf are created in Dockerfile

echo "[Entrypoint] Pool container initialized"
echo "[Entrypoint] Starting supervisord..."

# Execute the command passed to the container
exec "$@"
