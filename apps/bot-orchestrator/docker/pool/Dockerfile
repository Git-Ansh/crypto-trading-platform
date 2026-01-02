# FreqTrade Pool Container with Supervisord
# This image extends the official FreqTrade image to support multiple bot processes
# managed by Supervisord for the multi-tenant container pool architecture.

FROM freqtradeorg/freqtrade:stable

# Switch to root for installing packages
USER root

# Install supervisord and required utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    supervisor \
    procps \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create directories for supervisord
RUN mkdir -p /var/log/supervisor \
    && mkdir -p /etc/supervisor/conf.d \
    && mkdir -p /pool/bots \
    && mkdir -p /pool/logs \
    && mkdir -p /pool/configs

# Create base supervisord configuration
COPY supervisord.conf /etc/supervisor/supervisord.conf

# Create healthcheck script
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/healthcheck.sh

# Create entrypoint script for pool container
COPY pool-entrypoint.sh /usr/local/bin/pool-entrypoint.sh
RUN chmod +x /usr/local/bin/pool-entrypoint.sh

# Create placeholder config
RUN echo "; Placeholder - bot configs will be added dynamically" > /etc/supervisor/conf.d/placeholder.conf

# Set proper permissions for pool directories and supervisor
RUN chown -R ftuser:ftuser /pool \
    && chown -R ftuser:ftuser /var/log/supervisor \
    && chown -R ftuser:ftuser /etc/supervisor/conf.d \
    && chmod -R 755 /pool \
    && chmod -R 755 /etc/supervisor/conf.d

# Expose a range of ports for multiple bots (9000-9019)
EXPOSE 9000-9019

# Switch back to ftuser for running FreqTrade processes
USER ftuser

# Health check - verify supervisord is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD /usr/local/bin/healthcheck.sh || exit 1

# Use custom entrypoint
ENTRYPOINT ["/usr/local/bin/pool-entrypoint.sh"]
CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
