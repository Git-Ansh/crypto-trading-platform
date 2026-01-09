# Production Deployment Guide

This guide contains critical information preventing common deployment issues.

## 1. Systemd Environment Configuration
**CRITICAL:** `systemd` EnvironmentFiles must **NOT** use quotes around values.
- **Bad:** `KEY="Value"` (Breaks systemd)
- **Good:** `KEY=Value`

Use the provided `.env.systemd.example` as a template:
```bash
cp .env.systemd.example .env.systemd
nano .env.systemd # Fill in your values
```

Update your service file (`/etc/systemd/system/bot-manager.service`) to use this file:
```ini
[Service]
EnvironmentFile=/home/ubuntu/Workspace/crypto-trading-platform/apps/bot-orchestrator/.env.systemd
```

## 2. Port Configuration
The Bot Manager runs on **Port 5000** in production.
- Ensure `.env.systemd` has `PORT=5000`.
- Ensure Nginx proxies to `http://localhost:5000`.

## 3. CORS & Nginx
**CRITICAL:** Do **NOT** add CORS headers in Nginx. The application handles CORS via the `cors` middleware.
Adding them in Nginx causes "Duplicate Header" errors.

### correct Nginx Configuration
Use this configuration for `/etc/nginx/sites-available/freqtrade.crypto-pilot.dev`:

```nginx
server {
    listen 80;
    server_name freqtrade.crypto-pilot.dev;
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name freqtrade.crypto-pilot.dev;
    
    # SSL Certificates
    ssl_certificate /etc/letsencrypt/live/freqtrade.crypto-pilot.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/freqtrade.crypto-pilot.dev/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # Security headers (NOT CORS - that's handled by the app)
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://localhost:5000;  # MUST match PORT in .env
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Origin $http_origin;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # SSE specific settings
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

## 4. Restart Services
After making changes:
```bash
# Reload systemd config
sudo systemctl daemon-reload

# Restart Bot Manager
sudo systemctl restart bot-manager

# Test and Reload Nginx
sudo nginx -t
sudo systemctl reload nginx
```
