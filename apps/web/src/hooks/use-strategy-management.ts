// Custom hook for strategy management with real-time WebSocket updates
import { useState, useEffect, useCallback, useRef } from 'react';
import { strategyAPI, Strategy, BotStrategy, StrategyUpdateResponse } from '@/lib/strategy-api';

// Cache strategies globally to avoid refetching
let cachedStrategies: Strategy[] | null = null;
let strategiesLoading = false;
let strategiesLoadPromise: Promise<Strategy[]> | null = null;

// WebSocket singleton for real-time strategy updates
let wsInstance: WebSocket | null = null;
const wsSubscribers = new Set<(strategies: Strategy[]) => void>();

function getWebSocketURL(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}/ws/strategies`;
}

function initializeWebSocket() {
  if (wsInstance) return;

  try {
    const wsURL = getWebSocketURL();
    console.log('[StrategyWS] Connecting to:', wsURL);
    
    wsInstance = new WebSocket(wsURL);

    wsInstance.onopen = () => {
      console.log('[StrategyWS] Connected to strategy updates');
    };

    wsInstance.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[StrategyWS] Received message:', message);

        if (message.type === 'strategies:list') {
          // Initial strategy list
          const strategies = message.strategies || [];
          cachedStrategies = strategies;
          wsSubscribers.forEach(cb => cb(strategies));
        } else if (message.type === 'strategies:changed') {
          // Strategy change notification
          const { event: changeEvent, availableStrategies } = message;
          console.log(`[StrategyWS] Strategy ${changeEvent.type}: ${changeEvent.strategy}`);
          
          if (availableStrategies) {
            cachedStrategies = availableStrategies;
            wsSubscribers.forEach(cb => cb(availableStrategies));
          }
        }
      } catch (err) {
        console.error('[StrategyWS] Error parsing message:', err);
      }
    };

    wsInstance.onerror = (error) => {
      console.error('[StrategyWS] Connection error:', error);
    };

    wsInstance.onclose = () => {
      console.log('[StrategyWS] Disconnected');
      wsInstance = null;
      // Attempt to reconnect after 5 seconds
      setTimeout(() => {
        initializeWebSocket();
      }, 5000);
    };
  } catch (err) {
    console.error('[StrategyWS] Failed to create WebSocket:', err);
  }
}

function subscribeToStrategyUpdates(callback: (strategies: Strategy[]) => void): () => void {
  wsSubscribers.add(callback);

  // Initialize WebSocket if not already connected
  if (!wsInstance) {
    initializeWebSocket();
  }

  // Return unsubscribe function
  return () => {
    wsSubscribers.delete(callback);
    if (wsSubscribers.size === 0 && wsInstance) {
      // Close WebSocket when no more subscribers
      wsInstance.close();
      wsInstance = null;
    }
  };
}

export const useStrategyManagement = () => {
  const [strategies, setStrategies] = useState<Strategy[]>(cachedStrategies || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(wsInstance?.readyState === WebSocket.OPEN);
  const mountedRef = useRef(true);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Load available strategies after initial render - with global cache
  useEffect(() => {
    mountedRef.current = true;
    
    // Subscribe to real-time strategy updates
    if (!unsubscribeRef.current) {
      unsubscribeRef.current = subscribeToStrategyUpdates((updatedStrategies) => {
        if (mountedRef.current) {
          setStrategies(updatedStrategies);
          setWsConnected(true);
        }
      });
    }
    
    // If we have cached strategies, use them immediately
    if (cachedStrategies && cachedStrategies.length > 0) {
      setStrategies(cachedStrategies);
      return () => {
        mountedRef.current = false;
      };
    }
    
    // If already loading, wait for that promise
    if (strategiesLoading && strategiesLoadPromise) {
      strategiesLoadPromise.then(data => {
        if (mountedRef.current) {
          setStrategies(data);
        }
      });
      return () => {
        mountedRef.current = false;
      };
    }
    
    // Defer strategy loading to not block initial render
    const timer = setTimeout(() => {
      loadStrategies();
    }, 3000);
    
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
      // Don't unsubscribe here - let the hook unmount handle it
    };
  }, []);

  const loadStrategies = useCallback(async () => {
    if (strategiesLoading) return;
    strategiesLoading = true;
    setLoading(true);
    setError(null);
    
    try {
      strategiesLoadPromise = strategyAPI.getAvailableStrategies();
      const strategiesData = await strategiesLoadPromise;
      cachedStrategies = strategiesData;
      if (mountedRef.current) {
        setStrategies(strategiesData);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load strategies';
      if (mountedRef.current) {
        setError(errorMessage);
      }
      console.error('❌ Failed to load strategies:', err);
    } finally {
      strategiesLoading = false;
      strategiesLoadPromise = null;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const getBotStrategy = useCallback(async (instanceId: string): Promise<BotStrategy | null> => {
    try {
      const botStrategy = await strategyAPI.getBotStrategy(instanceId);

      // Fallback/merge: ensure available strategies are present even if the global fetch failed
      // Only update if we actually have new strategies to add
      if (botStrategy?.available?.length) {
        setStrategies((prev) => {
          const existingNames = new Set(prev.map((s) => s.name));
          let hasNew = false;
          for (const name of botStrategy.available) {
            if (!existingNames.has(name)) {
              hasNew = true;
              break;
            }
          }
          // If no new strategies, return same array reference to avoid re-render
          if (!hasNew) return prev;
          
          const merged = [...prev];
          for (const name of botStrategy.available) {
            if (!existingNames.has(name)) {
              merged.push({
                name,
                className: name,
                description: '',
                fileName: `${name}.py`,
              });
            }
          }
          // Update cache
          cachedStrategies = merged;
          return merged;
        });
      }

      return botStrategy;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to get bot strategy';
      if (mountedRef.current) {
        setError(errorMessage);
      }
      console.error(`❌ Failed to get strategy for bot ${instanceId}:`, err);
      return null;
    }
  }, []);

  const updateBotStrategy = useCallback(async (instanceId: string, newStrategy: string): Promise<StrategyUpdateResponse | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await strategyAPI.updateBotStrategy(instanceId, newStrategy);
      console.log(`🎯 Strategy updated for bot ${instanceId}:`, result);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update strategy';
      if (mountedRef.current) {
        setError(errorMessage);
      }
      console.error(`❌ Failed to update strategy for bot ${instanceId}:`, err);
      return null;
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // Cleanup effect
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, []);

  return {
    strategies,
    loading,
    error,
    wsConnected,
    loadStrategies,
    getBotStrategy,
    updateBotStrategy,
    clearError
  };
};
