/**
 * FreqTrade SSE Integration Hook
 * Replaces WebSocket-based integration with Server-Sent Events
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { freqTradeSSEService, PortfolioData, BotData, ChartResponse, TradeData } from '@/lib/freqtrade-sse-service';
import { useAuth } from '@/contexts/AuthContext';

interface FreqTradeSSEState {
  // Connection state
  isConnected: boolean;
  connectionError: string | null;
  lastUpdate: Date | null;

  // Portfolio data
  portfolioData: PortfolioData | null;
  portfolioLoading: boolean;
  portfolioError: string | null;

  // Bot data
  bots: BotData[];
  botsLoading: boolean;
  botsError: string | null;

  // Trade data
  trades: TradeData[];
  tradesLoading: boolean;
  tradesError: string | null;

  // Chart data by interval
  chartData: { [interval: string]: ChartResponse };
  chartLoading: boolean;
  chartError: string | null;

  // Actions
  refreshData: () => Promise<void>;
  fetchChartData: (interval: '1h' | '24h' | '7d' | '30d') => Promise<void>;
  fetchAllChartData: () => Promise<void>;
}

export const useFreqTradeSSE = (): FreqTradeSSEState => {
  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // React Strict Mode guard to prevent double initialization
  const initializedRef = useRef(false);

  // Portfolio state
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(true);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);

  // Bot state
  const [bots, setBots] = useState<BotData[]>([]);
  const [botsLoading, setBotsLoading] = useState(true);
  const [botsError, setBotsError] = useState<string | null>(null);

  // Trade state
  const [trades, setTrades] = useState<TradeData[]>([]);
  const [tradesLoading, setTradesLoading] = useState(true);
  const [tradesError, setTradesError] = useState<string | null>(null);

  // Chart data state
  const [chartData, setChartData] = useState<{ [interval: string]: ChartResponse }>({});
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  const { user } = useAuth();
  const unsubscribersRef = useRef<Array<() => void>>([]);

  // Initialize SSE connection when user is authenticated
  useEffect(() => {
    if (!user) return;

    // Prevent double initialization in React Strict Mode (development)
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const initializeSSE = async () => {
      try {
        setConnectionError(null);

        await freqTradeSSEService.connect();
      } catch (error) {
        console.error('❌ [HOOK] Failed to initialize SSE connection:', error);
        setConnectionError(error instanceof Error ? error.message : 'Connection failed');
        setPortfolioLoading(false);
        setBotsLoading(false);
      }
    };

    initializeSSE();

    // Safety timeout to clear loading states if data doesn't arrive within 10 seconds
    setTimeout(() => {
      if (portfolioLoading || botsLoading || tradesLoading) {
        setPortfolioLoading(false);
        setBotsLoading(false);
        setTradesLoading(false);
      }
    }, 10000);

    // Add a timeout to check connection status (but don't force reconnect to avoid rate limits)
    setTimeout(() => {
      // Check if service is connected but hook state is not synced
      if (freqTradeSSEService.getConnectionStatus() && !isConnected) {
        setIsConnected(true);
        setConnectionError(null);
      }

      // Only log status, don't force reconnect to avoid rate limits
      if (!freqTradeSSEService.getConnectionStatus() && !isConnected) {
        // SSE not connected - will retry automatically with backoff
      }
    }, 5000);

    // Setup event listeners
    const unsubscribeConnected = freqTradeSSEService.on('connected', (connected: boolean) => {
      setIsConnected(connected);

      if (connected) {
        setConnectionError(null);
        loadInitialData();
      } else {
        setConnectionError('Disconnected from FreqTrade service');
      }
    });

    const unsubscribePortfolio = freqTradeSSEService.on('portfolio_update', (data: PortfolioData) => {
      setPortfolioData(data);
      setPortfolioLoading(false);
      setPortfolioError(null);
      setLastUpdate(new Date(data.timestamp));

      // Create chart data point for time bucketing
      const liveChartPoint = {
        timestamp: data.timestamp,
        portfolioValue: data.portfolioValue,
        totalPnL: data.totalPnL,
        activeBots: data.activeBots,
        botCount: data.botCount,
      };

      // Time-based aggregation with always-live latest point
      setChartData(prev => {
        const updated = { ...prev };
        const currentTime = new Date(data.timestamp);


        // Define aggregation intervals and time windows
        const intervals = {
          '1h': { bucketMinutes: 5, totalMinutes: 60, maxPoints: 11 },     // 11 historical + 1 live = 12 total
          '24h': { bucketMinutes: 30, totalMinutes: 1440, maxPoints: 47 }, // 47 historical + 1 live = 48 total  
          '7d': { bucketMinutes: 60, totalMinutes: 10080, maxPoints: 167 }, // 167 historical + 1 live = 168 total
          '30d': { bucketMinutes: 720, totalMinutes: 43200, maxPoints: 59 } // 59 historical + 1 live = 60 total
        };

        (['1h', '24h', '7d', '30d'] as const).forEach(interval => {
          const config = intervals[interval];
          const bucketMs = config.bucketMinutes * 60 * 1000;
          const totalMs = config.totalMinutes * 60 * 1000;

          // Create the live point (always at current timestamp, not bucketed)
          const livePoint = {
            ...liveChartPoint,
            timestamp: currentTime.toISOString(),
            isLive: true // Mark as live point for identification
          };

          // Initialize if no data exists
          if (!updated[interval] || !updated[interval].data) {
            updated[interval] = {
              success: true,
              interval,
              data: [livePoint], // Start with just the live point
              metadata: {
                totalPoints: 1,
                timeRange: { start: currentTime.toISOString(), end: currentTime.toISOString() },
                aggregationWindow: `${config.bucketMinutes}m`
              }
            };
            return;
          }

          const existingData = [...updated[interval].data];

          // Remove any existing live points (there should only be one at the end)
          const historicalData = existingData.filter(point => (point as any).isLive !== true);

          // Check if we need to create a new historical bucket from the previous live point
          const lastBucketTime = Math.floor((currentTime.getTime() - config.bucketMinutes * 60 * 1000) / bucketMs) * bucketMs;
          const lastBucketTimeStr = new Date(lastBucketTime).toISOString();

          // If enough time has passed since the last bucket, create a historical point
          if (historicalData.length === 0 ||
            new Date(historicalData[historicalData.length - 1].timestamp).getTime() < lastBucketTime) {

            // Add the previous state as a historical bucket point
            const historicalPoint = {
              ...liveChartPoint,
              timestamp: lastBucketTimeStr,
              isLive: false
            };

            historicalData.push(historicalPoint);

          }

          // Sort historical data by timestamp
          historicalData.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

          // Remove historical data points older than the time window
          const cutoffTime = currentTime.getTime() - totalMs;
          const filteredHistoricalData = historicalData.filter(point =>
            new Date(point.timestamp).getTime() >= cutoffTime
          );

          // Limit historical points to prevent memory issues (save 1 spot for live point)
          while (filteredHistoricalData.length > config.maxPoints) {
            filteredHistoricalData.shift(); // Remove oldest historical point
          }

          // Combine historical data with the live point at the end
          const finalData = [...filteredHistoricalData, livePoint];

          updated[interval].data = finalData;


          // Update metadata
          const allTimes = finalData.map(p => new Date(p.timestamp).getTime());
          updated[interval].metadata = {
            totalPoints: finalData.length,
            timeRange: {
              start: new Date(Math.min(...allTimes)).toISOString(),
              end: new Date(Math.max(...allTimes)).toISOString()
            },
            aggregationWindow: `${config.bucketMinutes}m`
          };
        }); return updated;
      });
    });

    const unsubscribeBots = freqTradeSSEService.on('bot_update', (botData: BotData[]) => {
      setBots(botData);
      setBotsLoading(false);
      setBotsError(null);
    });

    const unsubscribeLastUpdate = freqTradeSSEService.on('last_update', (date: Date) => {
      setLastUpdate(date);
    });

    const unsubscribeError = freqTradeSSEService.on('error', (error: any) => {
      console.error('❌ FreqTrade SSE error:', error);
      const errorMessage = error?.message || 'SSE connection error';
      setConnectionError(errorMessage);
    });

    const unsubscribeConnectionFailed = freqTradeSSEService.on('connection_failed', (message: string) => {
      console.error('❌ FreqTrade SSE connection failed:', message);
      setConnectionError(message);
      setPortfolioLoading(false);
      setBotsLoading(false);
    });

    // Store unsubscribers
    unsubscribersRef.current = [
      unsubscribeConnected,
      unsubscribePortfolio,
      unsubscribeBots,
      unsubscribeLastUpdate,
      unsubscribeError,
      unsubscribeConnectionFailed,
    ];

    // Cleanup on unmount
    return () => {

      unsubscribersRef.current.forEach(unsubscribe => unsubscribe());
      unsubscribersRef.current = [];
      initializedRef.current = false; // Reset guard for potential remount
      // Add a small delay before disconnecting to avoid rapid reconnections
      setTimeout(() => {
        freqTradeSSEService.disconnect();
      }, 100);
    };
  }, [user]);

  // Load initial data (chart data since portfolio comes via SSE)
  const loadInitialData = async () => {
    try {

      // Parallelize all initial data fetching to improve speed
      await Promise.allSettled([
        // Fetch initial chart data for all intervals
        fetchAllChartData(),

        // Try to fetch bot list if available
        freqTradeSSEService.fetchBots()
          .then(botList => {
            if (Array.isArray(botList) && botList.length > 0) {
              // Note: setBots if needed, though SSE will update them
            }
          })
          .catch(error => console.warn('⚠️ Could not fetch initial bot list:', error))
          .finally(() => setBotsLoading(false)),

        // Try to fetch recent trades if available
        freqTradeSSEService.fetchTrades()
          .then(tradeList => {
            if (Array.isArray(tradeList)) {
              setTrades(tradeList);
              setTradesError(null);
            }
          })
          .catch(error => {
            console.warn('⚠️ Could not fetch initial trade list:', error);
            setTradesError(error instanceof Error ? error.message : 'Failed to load trades');
          })
          .finally(() => setTradesLoading(false))
      ]);


    } catch (error) {
      console.error('❌ Failed to load initial data:', error);
    }
  };

  // Fetch chart data for specific interval
  const fetchChartData = useCallback(async (interval: '1h' | '24h' | '7d' | '30d') => {
    try {
      setChartLoading(true);
      setChartError(null);

      const data = await freqTradeSSEService.fetchChartData(interval);

      setChartData(prev => ({
        ...prev,
        [interval]: data
      }));
    } catch (error) {
      console.error(`❌ Failed to fetch chart data for ${interval}:`, error);
      const errorMessage = error instanceof Error ? error.message : `Failed to load ${interval} data`;
      setChartError(errorMessage);
    } finally {
      setChartLoading(false);
    }
  }, []);

  // Fetch all chart data intervals
  const fetchAllChartData = useCallback(async () => {
    try {
      setChartLoading(true);
      setChartError(null);

      // Fetch all data from server
      const serverData = await freqTradeSSEService.fetchAllChartData();

      // Use server data directly without client-side filtering
      // The backend already handles time window filtering and aggregation
      const processedData: { [key: string]: ChartResponse } = {};

      const intervals = ['1h', '24h', '7d', '30d'] as const;

      for (const interval of intervals) {
        const serverInterval = serverData[interval];

        if (serverInterval && serverInterval.data && serverInterval.data.length > 0) {
          // Convert timestamps to ISO strings if they're numbers
          const normalizedData = serverInterval.data.map((point: any) => ({
            ...point,
            timestamp: typeof point.timestamp === 'number'
              ? new Date(point.timestamp).toISOString()
              : point.timestamp,
            isLive: false
          }));

          processedData[interval] = {
            success: true,
            interval,
            data: normalizedData,
            metadata: {
              totalPoints: normalizedData.length,
              timeRange: normalizedData.length > 0 ? {
                start: normalizedData[0].timestamp,
                end: normalizedData[normalizedData.length - 1].timestamp
              } : { start: '', end: '' },
              aggregationWindow: (serverInterval as any).dataPoints ? `${(serverInterval as any).dataPoints} points` : 'auto'
            }
          };
        } else {
          processedData[interval] = {
            success: true,
            interval,
            data: [],
            metadata: {
              totalPoints: 0,
              timeRange: { start: '', end: '' },
              aggregationWindow: 'none'
            }
          };
        }
      }

      setChartData(processedData);
      setChartError(null);
    } catch (error) {
      console.error('❌ [HOOK] Failed to fetch all chart data:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load chart data';
      setChartError(errorMessage);
    } finally {
      setChartLoading(false);
    }
  }, []);

  // Manual refresh function
  const refreshData = useCallback(async () => {
    try {
      // Reconnect if disconnected
      if (!isConnected) {
        await freqTradeSSEService.connect();
      }

      // Refresh chart data
      await fetchAllChartData();

      // Skip health check to avoid rate limiting
    } catch (error) {
      console.error('❌ Failed to refresh data:', error);
      setConnectionError(error instanceof Error ? error.message : 'Refresh failed');
    }
  }, [isConnected, fetchAllChartData]);

  return {
    // Connection state
    isConnected,
    connectionError,
    lastUpdate,

    // Portfolio data
    portfolioData,
    portfolioLoading,
    portfolioError,

    // Bot data
    bots,
    botsLoading,
    botsError,

    // Trade data
    trades,
    tradesLoading,
    tradesError,

    // Chart data
    chartData,
    chartLoading,
    chartError,

    // Actions
    refreshData,
    fetchChartData,
    fetchAllChartData,
  };
};

export default useFreqTradeSSE;
