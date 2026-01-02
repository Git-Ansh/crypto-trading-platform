/**
 * Pool Info Component
 * Displays user's container pool statistics and bot assignments
 * 
 * Fetches pool data from /api/pool/my-pools endpoint
 * Shows: Total pools, bots per pool, utilization, pool health
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Server, Bot, Activity, AlertCircle } from 'lucide-react';
import { config } from '@/lib/config';
import { auth } from '@/lib/firebase';

interface PoolData {
  id: string;
  userId: string;
  containerName: string;
  status: string;
  botsCount: number;
  capacity: number;
  utilizationPercent: number;
  bots: string[];
  metrics?: {
    memoryUsageMB: number;
    cpuPercent: number;
    lastUpdated: string | null;
  };
}

interface BotAssignment {
  instanceId: string;
  poolId: string;
  slotIndex: number;
  port: number;
  status: string;
}

interface PoolStatsResponse {
  success: boolean;
  poolMode: boolean;
  userId: string;
  totalPools: number;
  totalBots: number;
  maxBotsPerPool: number;
  pools: PoolData[];
  bots: BotAssignment[];
}

export const PoolInfo = () => {
  const [poolStats, setPoolStats] = useState<PoolStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPoolStats();
  }, []);

  const fetchPoolStats = async () => {
    try {
      setLoading(true);
      setError(null);

      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${config.botManager.baseUrl}/api/pool/my-pools`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch pool stats: ${response.statusText}`);
      }

      const data = await response.json();
      setPoolStats(data);
    } catch (err) {
      console.error('Error fetching pool stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load pool information');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Pool Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading pool information...</p>
        </CardContent>
      </Card>
    );
  }

  if (error || !poolStats) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" />
            Pool Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{error || 'Failed to load pool data'}</p>
        </CardContent>
      </Card>
    );
  }

  if (!poolStats.poolMode) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Pool Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Pool mode is not enabled</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          Container Pools ({poolStats.totalPools})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Total Pools</p>
            <p className="text-2xl font-bold">{poolStats.totalPools}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Total Bots</p>
            <p className="text-2xl font-bold">{poolStats.totalBots}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Bots per Pool</p>
            <p className="text-2xl font-bold">{poolStats.maxBotsPerPool}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Capacity Used</p>
            <p className="text-2xl font-bold">
              {poolStats.totalBots} / {poolStats.totalPools * poolStats.maxBotsPerPool}
            </p>
          </div>
        </div>

        {/* Pool Details */}
        {poolStats.pools.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Pool Details</h4>
            {poolStats.pools.map((pool) => (
              <div
                key={pool.id}
                className="rounded-lg border p-3 space-y-2 hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono text-sm">{pool.id}</span>
                  </div>
                  <Badge
                    variant={pool.status === 'running' ? 'default' : 'secondary'}
                  >
                    {pool.status}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Bot className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Bots:</span>
                    <span className="font-medium">
                      {pool.botsCount} / {pool.capacity}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Activity className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Usage:</span>
                    <span className="font-medium">{pool.utilizationPercent}%</span>
                  </div>
                </div>

                {pool.metrics && pool.metrics.lastUpdated && (
                  <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2 border-t">
                    <div>
                      <span>Memory: </span>
                      <span className="font-mono">{pool.metrics.memoryUsageMB} MB</span>
                    </div>
                    <div>
                      <span>CPU: </span>
                      <span className="font-mono">{pool.metrics.cpuPercent.toFixed(1)}%</span>
                    </div>
                  </div>
                )}

                {/* Bot List */}
                {pool.bots.length > 0 && (
                  <div className="pt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-1">Bots in this pool:</p>
                    <div className="flex flex-wrap gap-1">
                      {pool.bots.map((botId) => (
                        <Badge key={botId} variant="outline" className="text-xs">
                          {botId.split('-').pop()}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {poolStats.pools.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No pools created yet. Provision a bot to create your first pool.
          </p>
        )}
      </CardContent>
    </Card>
  );
};
