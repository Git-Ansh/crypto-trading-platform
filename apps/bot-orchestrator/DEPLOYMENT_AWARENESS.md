/**
 * PRODUCTION DEPLOYMENT CHECKLIST & TROUBLESHOOTING
 * 
 * Use this guide when deploying the bot-manager to production.
 * 
 * 1. .env Files
 *    - DO NOT use quotes for values in .env files meant for systemd.
 *    - Example (GOOD): MAIN_STRATEGIES_SOURCE_DIR=/root/Admin Strategies
 *    - Example (BAD):  MAIN_STRATEGIES_SOURCE_DIR="/root/Admin Strategies"
 *    - Spaces should be unescaped or use .env.systemd without quotes.
 * 
 * 2. Port Configuration
 *    - Bot Manager runs on port 5000 by default (PORT=5000).
 *    - Nginx 'proxy_pass' must match this port.
 *    - Example: proxy_pass http://localhost:5000;
 * 
 * 3. CORS Configuration
 *    - CORS is strictly handled by the Bot Manager Node.js app (using the 'cors' middleware).
 *    - DO NOT add CORS headers (Access-Control-Allow-Origin, etc.) in Nginx configuration.
 *    - Adding them in Nginx will cause "Duplicate Headers" errors in browsers.
 *    - The Nginx config should just be a transparent reverse proxy.
 * 
 * 4. Nginx Configuration Reference
 *    server {
 *        listen 443 ssl http2;
 *        server_name freqtrade.crypto-pilot.dev;
 *        # ... SSL Certs ...
 * 
 *        # Security Headers (OK to keep)
 *        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
 *        add_header X-Content-Type-Options nosniff always;
 * 
 *        # CORS Headers - DELETE THESE IF PRESENT IN NGINX
 *        # add_header 'Access-Control-Allow-Origin' ... (REMOVE)
 *        # add_header 'Access-Control-Allow-Credentials' ... (REMOVE)
 * 
 *        location / {
 *            proxy_pass http://localhost:5000;
 *            proxy_set_header Host $host;
 *            # ... standard proxy headers ...
 *            
 *            # SSE and WebSocket Support
 *            proxy_http_version 1.1;
 *            proxy_set_header Upgrade $http_upgrade;
 *            proxy_set_header Connection "upgrade";
 *            proxy_buffering off;
 *            proxy_cache off;
 *        }
 *    }
 */
