// Custom hook for strategy management
import { useState, useEffect, useCallback, useRef } from 'react';
import { strategyAPI, Strategy, BotStrategy, StrategyUpdateResponse } from '@/lib/strategy-api';

// Cache strategies globally to avoid refetching
let cachedStrategies: Strategy[] | null = null;
let strategiesLoading = false;
let strategiesLoadPromise: Promise<Strategy[]> | null = null;

export const useStrategyManagement = () => {
  const [strategies, setStrategies] = useState<Strategy[]>(cachedStrategies || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // Load available strategies after initial render - with global cache
  useEffect(() => {
    mountedRef.current = true;
    
    // If we have cached strategies, use them immediately
    if (cachedStrategies && cachedStrategies.length > 0) {
      setStrategies(cachedStrategies);
      return;
    }
    
    // If already loading, wait for that promise
    if (strategiesLoading && strategiesLoadPromise) {
      strategiesLoadPromise.then(data => {
        if (mountedRef.current) {
          setStrategies(data);
        }
      });
      return;
    }
    
    // Defer strategy loading to not block initial render
    const timer = setTimeout(() => {
      loadStrategies();
    }, 3000);
    
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
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

  return {
    strategies,
    loading,
    error,
    loadStrategies,
    getBotStrategy,
    updateBotStrategy,
    clearError
  };
};
