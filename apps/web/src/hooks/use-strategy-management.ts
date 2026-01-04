// Custom hook for strategy management
import { useState, useEffect } from 'react';
import { strategyAPI, Strategy, BotStrategy, StrategyUpdateResponse } from '@/lib/strategy-api';

export const useStrategyManagement = () => {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load available strategies on mount
  useEffect(() => {
    loadStrategies();
  }, []);

  const loadStrategies = async () => {
    setLoading(true);
    setError(null);
    try {
      const strategiesData = await strategyAPI.getAvailableStrategies();
      setStrategies(strategiesData);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load strategies';
      setError(errorMessage);
      console.error('❌ Failed to load strategies:', err);
    } finally {
      setLoading(false);
    }
  };

  const getBotStrategy = async (instanceId: string): Promise<BotStrategy | null> => {
    try {
      const botStrategy = await strategyAPI.getBotStrategy(instanceId);

      // Fallback/merge: ensure available strategies are present even if the global fetch failed
      if (botStrategy?.available?.length) {
        setStrategies((prev) => {
          const existingNames = new Set(prev.map((s) => s.name));
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
          return merged;
        });
      }

      return botStrategy;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to get bot strategy';
      setError(errorMessage);
      console.error(`❌ Failed to get strategy for bot ${instanceId}:`, err);
      return null;
    }
  };

  const updateBotStrategy = async (instanceId: string, newStrategy: string): Promise<StrategyUpdateResponse | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await strategyAPI.updateBotStrategy(instanceId, newStrategy);
      console.log(`🎯 Strategy updated for bot ${instanceId}:`, result);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update strategy';
      setError(errorMessage);
      console.error(`❌ Failed to update strategy for bot ${instanceId}:`, err);
      return null;
    } finally {
      setLoading(false);
    }
  };

  return {
    strategies,
    loading,
    error,
    loadStrategies,
    getBotStrategy,
    updateBotStrategy,
    clearError: () => setError(null)
  };
};
