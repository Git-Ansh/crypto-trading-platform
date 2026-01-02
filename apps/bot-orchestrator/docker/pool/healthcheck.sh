#!/bin/bash
# Health check script for FreqTrade Pool Container
# Verifies supervisord is running and at least responds

set -e

# Check if supervisord is running
if ! pgrep -x "supervisord" > /dev/null; then
    echo "supervisord is not running"
    exit 1
fi

# Check if supervisorctl can connect
if ! supervisorctl status > /dev/null 2>&1; then
    echo "Cannot connect to supervisord"
    exit 1
fi

# Get count of running programs
RUNNING=$(supervisorctl status 2>/dev/null | grep -c "RUNNING" || echo "0")
TOTAL=$(supervisorctl status 2>/dev/null | wc -l || echo "0")

echo "Health check: $RUNNING/$TOTAL programs running"

# Container is healthy if supervisord is running
# Individual bot health is monitored separately
exit 0
