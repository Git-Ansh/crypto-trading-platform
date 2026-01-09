/**
 * Pool Management Page
 * Displays comprehensive pool statistics and management controls
 * 
 * Features:
 * - Pool overview with memory/CPU metrics
 * - Bot-to-pool mapping
 * - Pool health status
 * - Pool actions (cleanup, health check)
 */

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Server, Bot, Activity, AlertCircle, RefreshCw, Trash2, 
  CheckCircle, XCircle, Clock, Cpu, HardDrive, Network,
  ChevronRight
} from 'lucide-react';
import { config } from '@/lib/config';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { 
  Breadcrumb, 
  BreadcrumbItem, 
  BreadcrumbLink, 
  BreadcrumbList, 
  BreadcrumbPage, 
  BreadcrumbSeparator 
} from '@/components/ui/breadcrumb';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';

interface PoolMetrics {
  memoryUsageMB: number;
  cpuPercent: number;
  lastUpdated: string | null;
}

interface PoolData {
  id: string;
  userId: string;
  containerName: string;
  status: string;
  botsCount: number;
  capacity: number;
  utilizationPercent: number;
  bots: string[];
  metrics?: PoolMetrics;
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

interface HealthCheckResult {
  success: boolean;
  timestamp: string;
  pools: Array<{
    id: string;
    status: string;
    message: string;
    details: {
      containerStatus?: string;
      supervisor?: string;
      metrics?: { memory: string; cpu: string; network: string };
    };
  }>;
  bots: Array<{
    id: string;
    poolId: string;
    status: string;
    message: string;
  }>;
  issues: Array<{ type: string; id: string; status: string; message: string }>;
  recoveryActions: Array<{ type: string; id: string; action: string }>;
  durationMs: number;
}

export default function PoolManagement() {
  const { user } = useAuth();
  const [poolStats, setPoolStats] = useState<PoolStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [healthCheckResult, setHealthCheckResult] = useState<HealthCheckResult | null>(null);
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchPoolStats = useCallback(async (showRefresh = false) => {
    try {
      if (showRefresh) setRefreshing(true);
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
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Error fetching pool stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load pool information');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPoolStats();
    // Refresh every 30 seconds
    const interval = setInterval(() => fetchPoolStats(), 30000);
    return () => clearInterval(interval);
  }, [fetchPoolStats]);

  const runHealthCheck = async () => {
    try {
      setHealthCheckLoading(true);
      setError(null);
      const token = await auth.currentUser?.getIdToken();

      const response = await fetch(`${config.botManager.baseUrl}/api/pool/my-health-check`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.message || data.error || 'Health check failed');
        setHealthCheckResult(null);
        return;
      }

      // Ensure all required fields exist
      setHealthCheckResult({
        ...data,
        issues: data.issues || [],
        recoveryActions: data.recoveryActions || [],
        pools: data.pools || [],
        bots: data.bots || []
      });
    } catch (err) {
      console.error('Health check failed:', err);
      setError(err instanceof Error ? err.message : 'Health check failed');
      setHealthCheckResult(null);
    } finally {
      setHealthCheckLoading(false);
    }
  };

  const cleanupEmptyPools = async () => {
    try {
      setCleanupLoading(true);
      setError(null);
      const token = await auth.currentUser?.getIdToken();

      // Use my-cleanup for user's own orphaned bots (doesn't require admin)
      const response = await fetch(`${config.botManager.baseUrl}/api/pool/my-cleanup`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setError(data.message || data.error || 'Cleanup failed');
        return;
      }

      if (data.success) {
        fetchPoolStats(true);
      }
    } catch (err) {
      console.error('Cleanup failed:', err);
      setError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setCleanupLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running': return 'bg-green-500';
      case 'healthy': return 'text-green-600';
      case 'stopped': return 'bg-yellow-500';
      case 'degraded': return 'text-yellow-600';
      case 'unhealthy': return 'text-red-600';
      default: return 'bg-gray-500';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'running':
      case 'healthy':
        return <Badge variant="default" className="bg-green-600">{status}</Badge>;
      case 'stopped':
      case 'degraded':
        return <Badge variant="secondary" className="bg-yellow-600 text-white">{status}</Badge>;
      case 'unhealthy':
      case 'failed':
        return <Badge variant="destructive">{status}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <div className="flex items-center justify-center h-screen">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </SidebarInset>
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="/">Dashboard</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Pool Management</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold">Container Pool Management</h1>
              <p className="text-muted-foreground">
                Manage your FreqTrade bot container pools
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => fetchPoolStats(true)}
                disabled={refreshing}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button
                variant="outline"
                onClick={runHealthCheck}
                disabled={healthCheckLoading}
              >
                <Activity className={`h-4 w-4 mr-2 ${healthCheckLoading ? 'animate-pulse' : ''}`} />
                Health Check
              </Button>
              <Button
                variant="outline"
                onClick={cleanupEmptyPools}
                disabled={cleanupLoading}
              >
                <Trash2 className={`h-4 w-4 mr-2 ${cleanupLoading ? 'animate-pulse' : ''}`} />
                Cleanup Empty
              </Button>
            </div>
          </div>

          {error && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!poolStats?.poolMode && (
            <Alert className="mb-6">
              <Server className="h-4 w-4" />
              <AlertTitle>Pool Mode Disabled</AlertTitle>
              <AlertDescription>
                Container pool mode is not enabled. Bots are running in legacy mode (one container per bot).
              </AlertDescription>
            </Alert>
          )}

          {poolStats?.poolMode && (
            <Tabs defaultValue="overview" className="space-y-4">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="pools">Pools ({poolStats?.totalPools || 0})</TabsTrigger>
                <TabsTrigger value="bots">Bots ({poolStats?.totalBots || 0})</TabsTrigger>
                {healthCheckResult && <TabsTrigger value="health">Health Report</TabsTrigger>}
              </TabsList>

              {/* Overview Tab */}
              <TabsContent value="overview" className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Total Pools</CardTitle>
                      <Server className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{poolStats?.totalPools || 0}</div>
                      <p className="text-xs text-muted-foreground">
                        Active container pools
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Total Bots</CardTitle>
                      <Bot className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{poolStats?.totalBots || 0}</div>
                      <p className="text-xs text-muted-foreground">
                        Running in pools
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Capacity</CardTitle>
                      <HardDrive className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {poolStats?.totalBots || 0} / {(poolStats?.totalPools || 0) * (poolStats?.maxBotsPerPool || 3)}
                      </div>
                      <Progress
                        value={((poolStats?.totalBots || 0) / ((poolStats?.totalPools || 1) * (poolStats?.maxBotsPerPool || 3))) * 100}
                        className="mt-2"
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Bots per Pool</CardTitle>
                      <Cpu className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{poolStats?.maxBotsPerPool || 3}</div>
                      <p className="text-xs text-muted-foreground">
                        Maximum capacity
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* Pool Summary Cards */}
                <div className="grid gap-4 md:grid-cols-2">
                  {poolStats?.pools.map((pool) => (
                    <Card key={pool.id}>
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Server className="h-5 w-5" />
                            {pool.id.split('-').slice(-2).join('-')}
                          </CardTitle>
                          {getStatusBadge(pool.status)}
                        </div>
                        <CardDescription className="font-mono text-xs">
                          {pool.containerName}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-muted-foreground">Bots</p>
                            <p className="text-xl font-bold">{pool.botsCount} / {pool.capacity}</p>
                          </div>
                          <div>
                            <p className="text-sm text-muted-foreground">Utilization</p>
                            <p className="text-xl font-bold">{pool.utilizationPercent}%</p>
                          </div>
                        </div>
                        <Progress value={pool.utilizationPercent} />
                        {pool.metrics?.lastUpdated && (
                          <div className="grid grid-cols-2 gap-4 pt-2 border-t text-sm">
                            <div className="flex items-center gap-2">
                              <HardDrive className="h-4 w-4 text-muted-foreground" />
                              <span>{pool.metrics.memoryUsageMB} MB</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Cpu className="h-4 w-4 text-muted-foreground" />
                              <span>{pool.metrics.cpuPercent.toFixed(1)}%</span>
                            </div>
                          </div>
                        )}
                        <div className="pt-2 border-t">
                          <p className="text-xs text-muted-foreground mb-2">Bots in this pool:</p>
                          <div className="flex flex-wrap gap-1">
                            {pool.bots.map((botId) => (
                              <Badge key={botId} variant="outline" className="text-xs">
                                {botId.split('-').pop()}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </TabsContent>

              {/* Pools Tab */}
              <TabsContent value="pools">
                <Card>
                  <CardHeader>
                    <CardTitle>Pool Details</CardTitle>
                    <CardDescription>
                      All container pools and their current status
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Pool ID</TableHead>
                          <TableHead>Container</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Bots</TableHead>
                          <TableHead>Utilization</TableHead>
                          <TableHead>Memory</TableHead>
                          <TableHead>CPU</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {poolStats?.pools.map((pool) => (
                          <TableRow key={pool.id}>
                            <TableCell className="font-medium">
                              {pool.id.split('-').slice(-2).join('-')}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {pool.containerName.substring(0, 30)}...
                            </TableCell>
                            <TableCell>{getStatusBadge(pool.status)}</TableCell>
                            <TableCell>{pool.botsCount} / {pool.capacity}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Progress value={pool.utilizationPercent} className="w-16" />
                                <span className="text-sm">{pool.utilizationPercent}%</span>
                              </div>
                            </TableCell>
                            <TableCell>{pool.metrics?.memoryUsageMB || 0} MB</TableCell>
                            <TableCell>{pool.metrics?.cpuPercent?.toFixed(1) || 0}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Bots Tab */}
              <TabsContent value="bots">
                <Card>
                  <CardHeader>
                    <CardTitle>Bot Assignments</CardTitle>
                    <CardDescription>
                      All bots and their pool assignments
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Bot ID</TableHead>
                          <TableHead>Pool</TableHead>
                          <TableHead>Slot</TableHead>
                          <TableHead>Port</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {poolStats?.bots.map((bot) => (
                          <TableRow key={bot.instanceId}>
                            <TableCell className="font-medium">{bot.instanceId}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {bot.poolId.split('-').slice(-2).join('-')}
                            </TableCell>
                            <TableCell>{bot.slotIndex}</TableCell>
                            <TableCell>{bot.port}</TableCell>
                            <TableCell>{getStatusBadge(bot.status)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Health Report Tab */}
              {healthCheckResult && (
                <TabsContent value="health">
                  <Card>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle>Health Check Report</CardTitle>
                          <CardDescription>
                            Last check: {new Date(healthCheckResult.timestamp).toLocaleString()}
                            {' • '}Duration: {healthCheckResult.durationMs}ms
                          </CardDescription>
                        </div>
                        {(healthCheckResult.issues?.length || 0) === 0 ? (
                          <Badge className="bg-green-600">
                            <CheckCircle className="h-4 w-4 mr-1" />
                            All Healthy
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            <XCircle className="h-4 w-4 mr-1" />
                            {healthCheckResult.issues?.length || 0} Issues
                          </Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {(healthCheckResult.issues?.length || 0) > 0 && (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>Issues Detected</AlertTitle>
                          <AlertDescription>
                            <ul className="list-disc list-inside mt-2">
                              {healthCheckResult.issues?.map((issue, i) => (
                                <li key={i}>
                                  {issue.type}: {issue.id} - {issue.message}
                                </li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}

                      {(healthCheckResult.recoveryActions?.length || 0) > 0 && (
                        <Alert>
                          <Activity className="h-4 w-4" />
                          <AlertTitle>Recovery Actions Taken</AlertTitle>
                          <AlertDescription>
                            <ul className="list-disc list-inside mt-2">
                              {healthCheckResult.recoveryActions?.map((action, i) => (
                                <li key={i}>
                                  {action.type}: {action.id} - {action.action}
                                </li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}

                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <h4 className="font-medium mb-2">Pool Health</h4>
                          {healthCheckResult.pools?.map((pool) => (
                            <div key={pool.id} className="flex items-center justify-between py-2 border-b">
                              <span className="font-mono text-sm">{pool.id.split('-').slice(-2).join('-')}</span>
                              <span className={getStatusColor(pool.status)}>{pool.status}</span>
                            </div>
                          ))}
                        </div>
                        <div>
                          <h4 className="font-medium mb-2">Bot Health</h4>
                          {healthCheckResult.bots?.map((bot) => (
                            <div key={bot.id} className="flex items-center justify-between py-2 border-b">
                              <span className="font-mono text-sm">{bot.id}</span>
                              <span className={getStatusColor(bot.status)}>{bot.status}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>
              )}
            </Tabs>
          )}

          {/* Last refresh indicator */}
          {lastRefresh && (
            <p className="text-xs text-muted-foreground text-center mt-6">
              <Clock className="h-3 w-3 inline mr-1" />
              Last updated: {lastRefresh.toLocaleTimeString()}
            </p>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

