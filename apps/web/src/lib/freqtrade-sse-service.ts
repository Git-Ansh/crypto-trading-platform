/**
 * FreqTrade SSE Service - Server-Sent Events Integration
 * Based on the FreqTrade Bot Manager API Documentation
 */

import { getAuthToken } from '@/lib/api';
import { config, env } from '@/lib/config';

// API Configuration - use config to support both dev and prod
// For regular API calls, use the main server's proxy endpoint to avoid CORS issues
const FREQTRADE_API_BASE = config.api.baseUrl;
const FREQTRADE_PROXY_ENDPOINT = '/api/freqtrade';

// For SSE specifically:
// - Production: Connect directly to bot-manager (Vercel can't handle long-lived SSE connections)
// - Development: Use the local proxy (main-server can handle SSE)
const getSSEUrl = (token: string): string => {
  if (env.isProduction) {
    // In production, connect directly to bot-manager which has proper CORS headers
    return `${config.botManager.baseUrl}/api/stream?token=${encodeURIComponent(token)}`;
  } else {
    // In development, use the local proxy
    return `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/stream?token=${encodeURIComponent(token)}`;
  }
};

// Types based on API documentation
export interface PortfolioData {
  timestamp: string;
  portfolioValue: number;
  totalPnL: number;
  profitLossPercentage: number;
  pnlPercentage?: number; // Keep for backward compatibility
  activeBots: number;
  botCount: number;
  totalBalance: number;
  startingBalance: number;
  bots: BotData[];
}

export interface BotData {
  instanceId: string;
  status: string;
  balance: number;
  pnl: number;
  strategy: string;
  lastUpdate: string;
}

export interface TradeData {
  tradeId: string;
  pair: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  timestamp: string;
  openDate: string;
  profit?: number;
}

export interface PositionData {
  botId: string;
  pair: string;
  side: 'buy' | 'sell';
  amount: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  mode: string;
  lastUpdate: string;
}

export interface ChartDataPoint {
  timestamp: string;
  portfolioValue: number;
  totalPnL: number;
  activeBots: number;
  botCount: number;
  isLive?: boolean; // Optional flag to mark live vs historical data points
}

export interface ChartResponse {
  success: boolean;
  interval: string;
  data: ChartDataPoint[];
  metadata: {
    totalPoints: number;
    timeRange: {
      start: string;
      end: string;
    };
    aggregationWindow: string;
  };
}

export interface HealthResponse {
  ok: boolean;
  status: string;
  service: string;
  uptime: number;
  timestamp: string;
}

export class FreqTradeSSEService {
  private eventSource: EventSource | null = null;
  private listeners: Map<string, Set<Function>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isConnected = false;
  private lastConnectionAttempt = 0;
  private connectionCooldown = 3000; // Minimum 3 seconds between connection attempts

  constructor() {
  }

  // Event listener management
  on(event: string, callback: Function): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error);
      }
    });
  }

  // Connect to SSE stream
  async connect(): Promise<void> {
    // Check connection cooldown to prevent rapid successive attempts
    const now = Date.now();
    const timeSinceLastAttempt = now - this.lastConnectionAttempt;
    if (timeSinceLastAttempt < this.connectionCooldown) {
      const waitTime = this.connectionCooldown - timeSinceLastAttempt;

      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastConnectionAttempt = Date.now();

    const token = getAuthToken();

    if (!token) {
      console.error('🔌 No authentication token available for SSE connection');
      throw new Error('No authentication token available for SSE connection');
    }

    if (this.eventSource && this.eventSource.readyState === EventSource.OPEN) {
      return;
    }

    // Prevent multiple simultaneous connection attempts
    if (this.eventSource && this.eventSource.readyState === EventSource.CONNECTING) {
      return;
    }

    // Close any existing connection before creating new one
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    try {
      // Skip health check to avoid rate limiting issues

      // Get the appropriate SSE URL based on environment
      // Production: direct to bot-manager (Vercel can't handle SSE)
      // Development: through proxy
      const sseUrlWithQuery = getSSEUrl(token);
      
      console.log(`[SSE] Connecting to: ${env.isProduction ? 'bot-manager (direct)' : 'proxy'}`);

      this.eventSource = new EventSource(sseUrlWithQuery);

      // Listen for specific SSE event types
      this.eventSource?.addEventListener('portfolio', (event: any) => {
        try {
          const data = JSON.parse(event.data);
          this.handlePortfolioUpdate(data);
        } catch (error) {
          console.error('❌ Failed to parse portfolio event:', error);
        }
      });

      this.eventSource?.addEventListener('bot_update', (event: any) => {

        try {
          const data = JSON.parse(event.data);
          this.emit('bot_update', data);
        } catch (error) {
          console.error('❌ Failed to parse bot_update event:', error);
        }
      });

      this.eventSource?.addEventListener('positions', (event: any) => {

        try {
          const data = JSON.parse(event.data);
          this.emit('positions_update', data.positions || []);
        } catch (error) {
          console.error('❌ Failed to parse positions event:', error);
        }
      }); this.eventSource.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected', true);

      };

      this.eventSource.onmessage = (event) => {
        // Default message handler - most events should use specific event types
        try {
          const data = JSON.parse(event.data);

          // Handle as portfolio update if it has portfolio data
          if (data && typeof data === 'object' && data.portfolioValue) {
            this.handlePortfolioUpdate(data);
          }
        } catch (error) {
          console.error('❌ Failed to parse default SSE message:', error);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('❌ SSE connection error:', error);
        console.error('❌ SSE readyState:', this.eventSource?.readyState);
        console.error('❌ SSE URL was:', env.isProduction 
          ? `${config.botManager.baseUrl}/api/stream?token=[REDACTED]`
          : `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/stream?token=[REDACTED]`);

        this.isConnected = false;
        this.emit('connected', false);

        // Check if this might be a rate limiting issue
        if (this.reconnectAttempts > 0) {
          console.warn('⚠️ Multiple connection failures detected - possible rate limiting');
        }

        if (this.eventSource?.readyState === EventSource.CLOSED) {
          this.attemptReconnect();
        } else {
          // Also try to reconnect for other error states after a delay
          setTimeout(() => {
            if (!this.isConnected) {
              this.attemptReconnect();
            }
          }, 2000);
        }
      };

    } catch (error) {
      console.error('❌ Failed to establish SSE connection:', error);
      this.emit('error', error);
      throw error;
    }
  }

  // Handle portfolio data updates from SSE
  private handlePortfolioUpdate(data: any) {
    // Convert timestamp from number to ISO string if needed
    const normalizedTimestamp = typeof data.timestamp === 'number'
      ? new Date(data.timestamp).toISOString()
      : data.timestamp || new Date().toISOString();

    // The server sends exact field names, so let's use them directly
    const normalizedData: PortfolioData = {
      timestamp: normalizedTimestamp,
      portfolioValue: data.portfolioValue || 0,
      totalPnL: data.totalPnL || 0,
      profitLossPercentage: data.profitLossPercentage || data.pnlPercentage || 0,
      pnlPercentage: data.profitLossPercentage || data.pnlPercentage || 0,
      activeBots: data.activeBots || 0,
      botCount: data.botCount || 0,
      totalBalance: data.totalBalance || data.portfolioValue || 0,
      startingBalance: data.startingBalance || data.starting_balance || 0,
      bots: data.bots || []
    };

    // Emit portfolio data update with normalized data
    this.emit('portfolio_update', normalizedData);

    // Emit bot data if present
    if (normalizedData.bots && normalizedData.bots.length > 0) {
      this.emit('bot_update', normalizedData.bots);
    }

    // Update last update timestamp
    const timestamp = normalizedData.timestamp ? new Date(normalizedData.timestamp) : new Date();
    this.emit('last_update', timestamp);
  }

  // Reconnection logic with exponential backoff
  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ Max SSE reconnection attempts reached');
      this.emit('connection_failed', 'Max reconnection attempts reached - using HTTP polling fallback');

      // Start HTTP polling fallback every 30 seconds
      this.startHttpPollingFallback();
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    setTimeout(() => {
      this.connect().catch(error => {
        console.error('❌ SSE reconnection failed:', error);
      });
    }, delay);
  }

  // HTTP polling fallback when SSE fails
  private startHttpPollingFallback() {
    const pollInterval = setInterval(async () => {
      try {
        // Try to reconnect via SSE instead of health checks to avoid rate limits
        if (!this.isConnected) {
          this.reconnectAttempts = 0; // Reset attempts for fresh try
          await this.connect();
        }
      } catch (error) {
        console.error('📡 Polling fallback reconnection failed:', error);
      }
    }, 60000); // Poll every 60 seconds (less frequent to avoid rate limits)

    // Store interval ID for cleanup
    (this as any).pollingInterval = pollInterval;
  }

  // Disconnect SSE
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.isConnected = false;
      this.emit('connected', false);
    }

    // Clean up HTTP polling fallback if it exists
    if ((this as any).pollingInterval) {
      clearInterval((this as any).pollingInterval);
      (this as any).pollingInterval = null;
    }
  }

  // Check connection status
  getConnectionStatus(): boolean {
    const status = this.isConnected && this.eventSource?.readyState === EventSource.OPEN;
    return status;
  }

  // Helper to get readable EventSource ready state
  private getReadyStateString(): string {
    if (!this.eventSource) return 'No EventSource';
    switch (this.eventSource.readyState) {
      case EventSource.CONNECTING: return 'CONNECTING';
      case EventSource.OPEN: return 'OPEN';
      case EventSource.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }

  // Manual test method for debugging
  async testSSEConnection(): Promise<void> {
    const token = getAuthToken();

    if (!token) {
      console.error('No token available for testing');
      return;
    }

    // Test health first
    try {
      const health = await this.checkHealth();
    } catch (error) {
      console.error('Health check failed:', error);
    }

    // Test if we can make a regular API call with the token
    try {
      const response = await fetch(`${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/bots`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      console.error('API call failed:', error);
    }

    // Force disconnect and reconnect
    this.disconnect();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.connect();
  }

  // Fetch chart data for specific interval
  async fetchChartData(interval: '1h' | '24h' | '7d' | '30d'): Promise<ChartResponse> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/charts/portfolio/${interval}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Chart data request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ Failed to fetch chart data for ${interval}:`, error);
      throw error;
    }
  }  // Fetch all chart data intervals
  async fetchAllChartData(): Promise<{ [key: string]: ChartResponse }> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/charts/portfolio`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`All chart data request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.intervals || {};
    } catch (error) {
      console.error('❌ Failed to fetch all chart data:', error);
      throw error;
    }
  }

  // Fetch raw portfolio history
  async fetchPortfolioHistory(): Promise<any[]> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/portfolio/history`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Portfolio history request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('❌ Failed to fetch portfolio history:', error);
      throw error;
    }
  }  // Fetch bot list
  async fetchBots(): Promise<any[]> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/bots`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bot list request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('❌ Failed to fetch bot list:', error);
      throw error;
    }
  }  // Fetch specific bot status
  async fetchBotStatus(instanceId: string): Promise<any> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/bots/${instanceId}/status`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bot status request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ Failed to fetch bot status for ${instanceId}:`, error);
      throw error;
    }
  }

  // Fetch bot balance
  async fetchBotBalance(instanceId: string): Promise<any> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/bots/${instanceId}/balance`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bot balance request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ Failed to fetch bot balance for ${instanceId}:`, error);
      throw error;
    }
  }

  // Fetch bot profit
  async fetchBotProfit(instanceId: string): Promise<any> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/bots/${instanceId}/profit`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Bot profit request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ Failed to fetch bot profit for ${instanceId}:`, error);
      throw error;
    }
  }

  // Create new bot
  async createBot(botConfig: {
    instanceId: string;
    port: number;
    apiUsername: string;
    apiPassword: string;
  }): Promise<any> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(`${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/provision`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(botConfig),
      });

      if (!response.ok) {
        throw new Error(`Bot creation failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('❌ Failed to create bot:', error);
      throw error;
    }
  }

  // Check API health
  async checkHealth(): Promise<HealthResponse> {
    try {
      const response = await fetch(`${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/health`);

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('❌ Health check failed:', error);
      throw error;
    }
  }

  // Format currency values
  formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  // Format percentage values
  formatPercentage(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  // Fetch recent trades
  async fetchTrades(): Promise<TradeData[]> {
    try {
      // The /api/trades endpoint doesn't exist on the server (404 error)
      // Trade data is provided through portfolio.bots in SSE portfolio_update events
      return [];
    } catch (error) {
      console.error('❌ Failed to fetch trades:', error);
      return [];
    }
  }

  // Fetch live trading positions
  async fetchPositions(): Promise<any[]> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/portfolio/positions`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Positions request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data.positions || [];
    } catch (error) {
      console.error('❌ Failed to fetch positions:', error);
      throw error;
    }
  }

  // Fetch universal settings for all bots
  async fetchUniversalSettings(): Promise<UniversalSettingsResponse> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/universal-settings`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Universal settings request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('❌ Failed to fetch universal settings:', error);
      throw error;
    }
  }

  // Update universal settings for a specific bot
  async updateUniversalSettings(instanceId: string, settings: {
    riskLevel?: number;
    autoRebalance?: boolean;
    dcaEnabled?: boolean;
    enabled?: boolean;
  }): Promise<any> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/universal-settings/${instanceId}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(settings),
        }
      );

      if (!response.ok) {
        throw new Error(`Universal settings update failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ Failed to update universal settings for ${instanceId}:`, error);
      throw error;
    }
  }

  // Fetch bot performance metrics
  async fetchBotPerformance(instanceId: string): Promise<BotPerformanceData> {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No authentication token available');
    }

    try {
      const response = await fetch(
        `${FREQTRADE_API_BASE}${FREQTRADE_PROXY_ENDPOINT}/proxy/${instanceId}/api/v1/performance`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Performance request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`❌ Failed to fetch performance for ${instanceId}:`, error);
      throw error;
    }
  }
}

// Universal settings response type
export interface UniversalSettingsResponse {
  success: boolean;
  bots: Array<{
    instanceId: string;
    settings: {
      riskLevel: number;
      autoRebalance: boolean;
      dcaEnabled: boolean;
      enabled: boolean;
    };
    isRunning: boolean;
    lastUpdated?: string;
  }>;
  defaults: {
    riskLevel: number;
    autoRebalance: boolean;
    dcaEnabled: boolean;
    enabled: boolean;
  };
  totalBots: number;
  runningBots: number;
}

// Bot performance data type
export interface BotPerformanceData {
  profit_closed_coin: number;
  profit_closed_percent: number;
  profit_closed_fiat: number;
  profit_all_coin: number;
  profit_all_percent: number;
  profit_all_fiat: number;
  trade_count: number;
  closed_trade_count: number;
  first_trade_date: string;
  first_trade_timestamp: number;
  latest_trade_date: string;
  latest_trade_timestamp: number;
  avg_duration: string;
  best_pair: string;
  best_rate: number;
  winning_trades: number;
  losing_trades: number;
}

// Create singleton instance
export const freqTradeSSEService = new FreqTradeSSEService();

// Make it available for debugging in browser console
if (typeof window !== 'undefined') {
  (window as any).freqTradeSSEService = freqTradeSSEService;
}

// Export default
export default freqTradeSSEService;
