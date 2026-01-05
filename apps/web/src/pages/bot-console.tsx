import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
// import { useAuth } from '@/contexts/AuthContext';
import { config } from '@/lib/config';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import {
    Bot,
    Plus,
    Play,
    Square,
    Trash2,
    Settings,
    AlertCircle,
    CheckCircle,
    Activity,
    DollarSign
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ModeToggle } from "@/components/mode-toggle";
import {
    SidebarProvider,
    SidebarInset,
    SidebarTrigger,
} from '@/components/ui/sidebar';
import { Loading, LoadingSpinner } from "@/components/ui/loading";
import { AppSidebar } from '@/components/app-sidebar';
import { Skeleton } from "@/components/ui/skeleton";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const MAX_BOTS = 3;

interface BotInstance {
    instanceId: string;
    strategy: string;
    port: number;
    exchange: string;
    stake_currency: string;
    dry_run: boolean;
    containerStatus: 'running' | 'stopped' | 'error' | 'unknown';
}

const BotBalance = ({ bot, onBalanceUpdate }: { bot: BotInstance, onBalanceUpdate?: (id: string, balance: number, currency: string) => void }) => {
    const [balance, setBalance] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [retryCount, setRetryCount] = useState(0);

    useEffect(() => {
        let isMounted = true;
        let retryTimeout: ReturnType<typeof setTimeout> | null = null;

        const fetchBalance = async () => {
            if (bot.containerStatus !== 'running') {
                if (isMounted) setBalance(null);
                return;
            }

            // Only set loading on initial fetch or if we have no data
            if (!balance && isMounted) setLoading(true);

            try {
                const token = await auth.currentUser?.getIdToken();
                if (!token) {
                    // Auth not ready yet, retry after a short delay
                    if (isMounted && retryCount < 3) {
                        retryTimeout = setTimeout(() => {
                            if (isMounted) {
                                setRetryCount(prev => prev + 1);
                            }
                        }, 2000);
                    }
                    return;
                }

                const response = await fetch(`${config.botManager.baseUrl}/api/proxy/${bot.instanceId}/api/v1/balance`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (response.ok) {
                    const data = await response.json();
                    if (isMounted) {
                        const total = typeof data.total === 'number' ? data.total : parseFloat(data.total);
                        const currency = data.symbol || bot.stake_currency || 'USD';

                        setBalance(`${total.toFixed(2)} ${currency}`);
                        setRetryCount(0); // Reset retry count on success

                        if (onBalanceUpdate) {
                            onBalanceUpdate(bot.instanceId, total, currency);
                        }
                    }
                } else if ((response.status === 401 || response.status >= 500) && retryCount < 5) {
                    // Bot might not be ready yet (401) or restarting (5xx), retry with backoff
                    console.log(`[BotBalance] ${bot.instanceId}: Got ${response.status}, retry ${retryCount + 1}/5`);
                    if (isMounted) {
                        retryTimeout = setTimeout(() => {
                            if (isMounted) {
                                setRetryCount(prev => prev + 1);
                            }
                        }, 3000 * (retryCount + 1)); // Exponential backoff: 3s, 6s, 9s...
                    }
                } else {
                    if (isMounted) setBalance("Error");
                }
            } catch (error) {
                if (isMounted) setBalance("Error");
            } finally {
                if (isMounted) setLoading(false);
            }
        };

        fetchBalance();
        const interval = setInterval(fetchBalance, 30000); // Update every 30s

        return () => {
            isMounted = false;
            clearInterval(interval);
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [bot.instanceId, bot.containerStatus, onBalanceUpdate, retryCount]);

    if (bot.containerStatus !== 'running') {
        return <span className="font-medium text-muted-foreground">--</span>;
    }

    if (loading && !balance) {
        return <Skeleton className="h-4 w-24" />;
    }

    return (
        <span className={`font-medium ${balance === 'Error' ? 'text-destructive' : 'text-emerald-500'}`}>
            {balance || '---'}
        </span>
    );
};

export default function BotConsolePage() {
    const navigate = useNavigate();
    // const { user } = useAuth();
    const [bots, setBots] = useState<BotInstance[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [botActionLoading, setBotActionLoading] = useState<{ [id: string]: 'start' | 'stop' | null }>({});
    const [balances, setBalances] = useState<Record<string, { value: number, currency: string }>>({});
    const [walletAllocations, setWalletAllocations] = useState<Record<string, { allocatedAmount: number; currentValue: number; availableBalance?: number }>>({});

    const handleBalanceUpdate = useCallback((id: string, value: number, currency: string) => {
        setBalances(prev => {
            if (prev[id]?.value === value && prev[id]?.currency === currency) return prev;
            return { ...prev, [id]: { value, currency } };
        });
    }, []);

    const getTotalBalances = () => {
        const totals: Record<string, number> = {};
        Object.values(balances).forEach(({ value, currency }) => {
            totals[currency] = (totals[currency] || 0) + value;
        });
        return totals;
    };

    const getAuthToken = async (): Promise<string | null> => {
        try {
            const firebaseUser = auth.currentUser;
            if (firebaseUser) {
                return await firebaseUser.getIdToken();
            }
            return null;
        } catch (error) {
            console.error('Error getting auth token:', error);
            return null;
        }
    };

    const fetchBots = async () => {
        try {
            const token = await getAuthToken();
            if (!token) {
                console.warn('[BotConsole] No auth token available, skipping fetch');
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            const response = await fetch(`${config.botManager.baseUrl}/api/bots`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json();
                setBots(data.bots || []);
            } else {
                console.error('[BotConsole] Failed to fetch bots:', response.status, response.statusText);
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.error('[BotConsole] Fetch bots timed out');
            } else {
                console.error('[BotConsole] Error fetching bots:', error);
            }
        }
    };

    const fetchWalletAllocations = async () => {
        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.api.baseUrl}/api/account/wallet`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.data.botAllocations) {
                    setWalletAllocations(data.data.botAllocations);
                }
            }
        } catch (error) {
            console.error('[BotConsole] Error fetching wallet allocations:', error);
        }
    };

    useEffect(() => {
        // Wait for Firebase auth to be ready before fetching
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                setLoading(true);
                try {
                    await Promise.all([fetchBots(), fetchWalletAllocations()]);
                } finally {
                    setLoading(false);
                }
            } else {
                // No user logged in, stop loading
                setLoading(false);
            }
        });
        
        return () => unsubscribe();
    }, []);

    const [botToDelete, setBotToDelete] = useState<BotInstance | null>(null);
    const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
    const [selectedBotForWithdraw, setSelectedBotForWithdraw] = useState<BotInstance | null>(null);
    const [withdrawAmount, setWithdrawAmount] = useState<string>('');
    const [withdrawLoading, setWithdrawLoading] = useState(false);

    const handleBotAction = async (instanceId: string, action: 'start' | 'stop') => {
        try {
            setBotActionLoading(prev => ({ ...prev, [instanceId]: action }));
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.botManager.baseUrl}/api/bots/${instanceId}/${action}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                setSuccess(`Bot ${action}ed successfully`);
                await fetchBots();
            } else {
                const data = await response.json();
                setError(data.message || `Failed to ${action} bot`);
            }
        } catch (error: any) {
            setError(error.message || `Failed to ${action} bot`);
        } finally {
            setBotActionLoading(prev => ({ ...prev, [instanceId]: null }));
        }
    };

    const confirmDeleteBot = async () => {
        if (!botToDelete) return;
        const instanceId = botToDelete.instanceId;
        setBotToDelete(null);

        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.botManager.baseUrl}/api/bots/${instanceId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });

            const data = await response.json();

            if (response.ok && data.success) {
                let msg = `Bot "${instanceId}" deleted successfully.`;
                if (data.cashedOut && data.cashedOut.amount > 0) {
                    msg += ` Cashed out ${data.cashedOut.amount.toFixed(2)} ${data.cashedOut.currency} to your portfolio.`;
                }
                setSuccess(msg);
                await fetchBots();
            } else {
                setError(data.message || 'Failed to delete bot');
            }
        } catch (error: any) {
            setError(error.message || 'Failed to delete bot');
        }
    };
    const handleWithdrawFromBot = async () => {
        if (!selectedBotForWithdraw) return;

        try {
            setWithdrawLoading(true);
            const token = await getAuthToken();
            if (!token) {
                setError('Authentication required');
                setWithdrawLoading(false);
                return;
            }

            const amount = parseFloat(withdrawAmount || '0');
            if (isNaN(amount) || amount <= 0) {
                setError('Please enter a valid amount');
                return;
            }

            // Call the return-from-bot endpoint
            const response = await fetch(`${config.api.baseUrl}/api/account/wallet/return-from-bot`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    botId: selectedBotForWithdraw.instanceId,
                    returnAmount: amount
                })
            });

            const responseText = await response.text();
            let data: any = {};
            if (responseText) {
                try {
                    data = JSON.parse(responseText);
                } catch (parseError) {
                    console.error('[BotConsole] Failed to parse withdraw response', parseError, responseText);
                }
            }

            if (response.ok && data.success) {
                setSuccess(`Successfully withdrawn $${amount.toFixed(2)} from ${selectedBotForWithdraw.instanceId}. Balance will update shortly.`);
                setWithdrawDialogOpen(false);
                setSelectedBotForWithdraw(null);
                setWithdrawAmount('');
                // Wallet allocation updates immediately, but bot balance needs time to restart
                await fetchWalletAllocations();
                // Wait 3 seconds for bot to restart before refreshing bot list
                setTimeout(() => fetchBots(), 3000);
            } else {
                setError(data.message || `Failed to withdraw from bot (status ${response.status})`);
            }
        } catch (error: any) {
            setError(error.message || 'Failed to withdraw from bot');
        } finally {
            setWithdrawLoading(false);
        }
    };

    const handleWithdrawAllFromBot = async (bot: BotInstance) => {
        try {
            setWithdrawLoading(true);
            const token = await getAuthToken();
            if (!token) {
                setError('Authentication required');
                setWithdrawLoading(false);
                return;
            }

            // Call the return-from-bot endpoint without specifying amount (returns all)
            const response = await fetch(`${config.api.baseUrl}/api/account/wallet/return-from-bot`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    botId: bot.instanceId
                })
            });

            const responseText = await response.text();
            let data: any = {};
            if (responseText) {
                try {
                    data = JSON.parse(responseText);
                } catch (parseError) {
                    console.error('[BotConsole] Failed to parse withdraw-all response', parseError, responseText);
                }
            }

            if (response.ok && data.success) {
                setSuccess(`Successfully returned $${data.data.returnedAmount.toFixed(2)} from ${bot.instanceId} (P&L: ${data.data.pnl >= 0 ? '+' : ''}$${data.data.pnl.toFixed(2)})`);
                setWithdrawDialogOpen(false);
                setSelectedBotForWithdraw(null);
                setWithdrawAmount('');
                await Promise.all([fetchBots(), fetchWalletAllocations()]);
            } else {
                setError(data.message || `Failed to return funds from bot (status ${response.status})`);
            }
        } catch (error: any) {
            setError(error.message || 'Failed to return funds from bot');
        } finally {
            setWithdrawLoading(false);
        }
    };
    // Helper to get consistent status display
    const getStatusDisplay = (bot: BotInstance) => {
        const status = bot.containerStatus || 'unknown';
        // Capitalize first letter
        return status.charAt(0).toUpperCase() + status.slice(1);
    };

    const getStatusColor = (bot: BotInstance) => {
        const status = bot.containerStatus?.toLowerCase();
        switch (status) {
            case 'running': return 'bg-emerald-500';
            case 'stopped': return 'bg-gray-500';
            case 'error': return 'bg-red-500';
            default: return 'bg-yellow-500'; // unknown
        }
    };

    const getStatusBadgeVariant = (bot: BotInstance) => {
        const status = bot.containerStatus?.toLowerCase();
        return status === 'running' ? 'default' : (status === 'error' ? 'destructive' : 'secondary');
    };

    if (loading) {
        return <Loading message="Loading bot console..." />;
    }

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
                <div className="flex flex-col min-h-screen bg-background">
                    {/* Header */}
                    <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6">
                        <div className="flex items-center gap-2">
                            <SidebarTrigger className="-ml-1" />
                            <Separator orientation="vertical" className="mr-2 h-4" />
                            <span className="crypto-dashboard-title text-xl">Crypto Pilot</span>
                            <Badge variant="outline" className="ml-2">Bot Console</Badge>
                        </div>
                        <div className="ml-auto flex items-center gap-4">
                            <Badge variant="outline" className="gap-1">
                                <Activity className="h-3 w-3" />
                                {bots.length} / {MAX_BOTS} Bots
                            </Badge>
                            {Object.entries(getTotalBalances()).map(([curr, val]) => (
                                <Badge key={curr} variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                                    Total: {val.toFixed(2)} {curr}
                                </Badge>
                            ))}
                            <ModeToggle />
                            <Button
                                onClick={() => navigate('/bot-provisioning')}
                                disabled={bots.length >= MAX_BOTS}
                                className="gap-2"
                            >
                                <Plus className="h-4 w-4" />
                                New Bot
                            </Button>
                        </div>
                    </header>

                    {/* Alerts */}
                    {error && (
                        <div className="mx-6 mt-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2">
                            <AlertCircle className="h-5 w-5 text-destructive" />
                            <span className="text-destructive">{error}</span>
                            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setError(null)}>×</Button>
                        </div>
                    )}
                    {success && (
                        <div className="mx-6 mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center gap-2">
                            <CheckCircle className="h-5 w-5 text-emerald-500" />
                            <span className="text-emerald-600">{success}</span>
                            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSuccess(null)}>×</Button>
                        </div>
                    )}

                    {/* Main Content */}
                    <main className="flex-1 p-6 w-full min-w-0">
                        {bots.length === 0 ? (
                            <Card className="border-dashed">
                                <CardContent className="flex flex-col items-center justify-center py-12">
                                    <Bot className="h-16 w-16 text-muted-foreground/50 mb-4" />
                                    <h3 className="text-lg font-medium mb-2">No Bots Yet</h3>
                                    <p className="text-muted-foreground text-center mb-4">
                                        Create your first trading bot to start automated trading
                                    </p>
                                    <Button onClick={() => navigate('/bot-provisioning')}>
                                        <Plus className="h-4 w-4 mr-2" />
                                        Create Your First Bot
                                    </Button>
                                </CardContent>
                            </Card>
                        ) : (
                            <div className="grid gap-6 grid-cols-[repeat(auto-fit,minmax(380px,1fr))] w-full">
                                {bots.map((bot) => (
                                    <Card key={bot.instanceId} className="overflow-hidden flex flex-col">
                                        <CardHeader className="pb-2">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2 truncate">
                                                    <div className={`h-3 w-3 min-w-[12px] rounded-full ${getStatusColor(bot)}`} />
                                                    <CardTitle className="text-lg truncate" title={bot.instanceId}>{bot.instanceId}</CardTitle>
                                                </div>
                                                <Badge variant={bot.dry_run ? 'secondary' : 'destructive'} className="ml-2 flex-shrink-0">
                                                    {bot.dry_run ? 'Paper' : 'Live'}
                                                </Badge>
                                            </div>
                                            <CardDescription>
                                                {bot.exchange?.toUpperCase()} • Port {bot.port}
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-3 flex-1">
                                            <div className="flex items-center justify-between text-sm">
                                                <span className="text-muted-foreground">Strategy</span>
                                                <span className="font-medium truncate ml-2" title={bot.strategy}>{bot.strategy}</span>
                                            </div>
                                            <div className="flex items-center justify-between text-sm">
                                                <span className="text-muted-foreground">Currency</span>
                                                <span className="font-medium">{bot.stake_currency}</span>
                                            </div>
                                            <div className="flex items-center justify-between text-sm">
                                                <span className="text-muted-foreground">Bot Balance</span>
                                                <BotBalance bot={bot} onBalanceUpdate={handleBalanceUpdate} />
                                            </div>
                                            {walletAllocations[bot.instanceId] && (
                                                <div className="flex items-center justify-between text-sm">
                                                    <span className="text-muted-foreground">Wallet Allocation</span>
                                                    <span className="font-medium text-blue-500">
                                                        ${walletAllocations[bot.instanceId].currentValue?.toFixed(2) || '0.00'}
                                                    </span>
                                                </div>
                                            )}
                                            <div className="flex items-center justify-between text-sm">
                                                <span className="text-muted-foreground">Status</span>
                                                <Badge variant={getStatusBadgeVariant(bot)}>
                                                    {getStatusDisplay(bot)}
                                                </Badge>
                                            </div>
                                        </CardContent>
                                        <Separator />
                                        <CardFooter className="flex flex-wrap gap-2 pt-4 justify-between">
                                            <div className="flex gap-2 w-full sm:w-auto">
                                                {bot.containerStatus === 'running' ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="flex-1 sm:flex-none"
                                                        disabled={!!botActionLoading[bot.instanceId]}
                                                        onClick={() => handleBotAction(bot.instanceId, 'stop')}
                                                    >
                                                        {botActionLoading[bot.instanceId] === 'stop' ? (
                                                            <>
                                                                <LoadingSpinner size="sm" className="mr-1" />
                                                                Stopping...
                                                            </>
                                                        ) : (
                                                            <>
                                                                <Square className="h-4 w-4 mr-1 fill-current" />
                                                                Stop
                                                            </>
                                                        )}
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="flex-1 sm:flex-none"
                                                        disabled={!!botActionLoading[bot.instanceId]}
                                                        onClick={() => handleBotAction(bot.instanceId, 'start')}
                                                    >
                                                        {botActionLoading[bot.instanceId] === 'start' ? (
                                                            <>
                                                                <LoadingSpinner size="sm" className="mr-1" />
                                                                Starting...
                                                            </>
                                                        ) : (
                                                            <>
                                                                <Play className="h-4 w-4 mr-1 ml-0.5 fill-current" />
                                                                Start
                                                            </>
                                                        )}
                                                    </Button>
                                                )}
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="flex-1 sm:flex-none"
                                                    onClick={() => navigate(`/bot/${bot.instanceId}/config`)}
                                                >
                                                    <Settings className="h-4 w-4 mr-1" />
                                                    Config
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="flex-1 sm:flex-none"
                                                    disabled={withdrawLoading}
                                                    onClick={() => {
                                                        setSelectedBotForWithdraw(bot);
                                                        setWithdrawDialogOpen(true);
                                                    }}
                                                >
                                                    <DollarSign className="h-4 w-4 mr-1" />
                                                    Withdraw
                                                </Button>
                                            </div>

                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:text-destructive hover:bg-destructive/10 ml-auto"
                                                onClick={() => setBotToDelete(bot)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </CardFooter>
                                    </Card>
                                ))}
                            </div>
                        )}

                        <AlertDialog open={!!botToDelete} onOpenChange={(open) => !open && setBotToDelete(null)}>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                                    <AlertDialogDescription asChild>
                                        <div className="space-y-2 text-sm text-muted-foreground">
                                            <span>This action cannot be undone. This will permanently delete the bot container and all associated data.</span>

                                            {botToDelete?.dry_run && (
                                                <div className="p-2 bg-muted rounded text-foreground font-medium border-l-4 border-emerald-500 pl-4 text-xs">
                                                    All active positions will be cashed out and calculated value returned to your global portfolio.
                                                </div>
                                            )}
                                            {!botToDelete?.dry_run && (
                                                <div className="p-2 bg-muted rounded text-foreground font-medium border-l-4 border-destructive pl-4 text-xs">
                                                    Warning: Live trading bot. Ensure all positions are closed or this action will force a shutdown.
                                                </div>
                                            )}
                                        </div>
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction onClick={confirmDeleteBot} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                        {botToDelete?.dry_run ? 'Cash Out & Delete' : 'Delete Bot'}
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>

                        <Dialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
                            <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>Withdraw from {selectedBotForWithdraw?.instanceId}</DialogTitle>
                                    <DialogDescription>
                                        {selectedBotForWithdraw && walletAllocations[selectedBotForWithdraw.instanceId] ? (
                                            <span>
                                                Wallet allocation: ${walletAllocations[selectedBotForWithdraw.instanceId].currentValue?.toFixed(2) || '0.00'} 
                                                {' '}(originally allocated: ${walletAllocations[selectedBotForWithdraw.instanceId].allocatedAmount?.toFixed(2) || '0.00'})
                                            </span>
                                        ) : (
                                            <span>No wallet allocation found for this bot.</span>
                                        )}
                                    </DialogDescription>
                                </DialogHeader>
                                <div className="space-y-4 py-4">
                                    <div className="space-y-2">
                                        <label htmlFor="withdraw-amount" className="text-sm font-medium">
                                            Withdrawal Amount
                                        </label>
                                        <Input
                                            id="withdraw-amount"
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            max={selectedBotForWithdraw ? walletAllocations[selectedBotForWithdraw.instanceId]?.currentValue : undefined}
                                            value={withdrawAmount}
                                            onChange={(e) => setWithdrawAmount(e.target.value)}
                                            placeholder="Enter amount or leave empty for full withdrawal"
                                            disabled={withdrawLoading || (selectedBotForWithdraw && !walletAllocations[selectedBotForWithdraw.instanceId])}
                                        />
                                        {selectedBotForWithdraw && walletAllocations[selectedBotForWithdraw.instanceId] && (
                                            <p className="text-xs text-muted-foreground">
                                                Max: ${walletAllocations[selectedBotForWithdraw.instanceId].currentValue?.toFixed(2)}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button
                                        variant="outline"
                                        onClick={() => {
                                            setWithdrawDialogOpen(false);
                                            setWithdrawAmount(0);
                                        }}
                                        disabled={withdrawLoading}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        onClick={() => {
                                            if (selectedBotForWithdraw) {
                                                if (withdrawAmount > 0) {
                                                    handleWithdrawFromBot(selectedBotForWithdraw);
                                                } else {
                                                    handleWithdrawAllFromBot(selectedBotForWithdraw);
                                                }
                                            }
                                        }}
                                        disabled={withdrawLoading}
                                    >
                                        {withdrawLoading ? (
                                            <>
                                                <LoadingSpinner size="sm" className="mr-1" />
                                                Withdrawing...
                                            </>
                                        ) : (
                                            'Withdraw'
                                        )}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </main>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
}
