import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { config } from '@/lib/config';
import { auth } from '@/lib/firebase';
import {
    Bot,
    Loader2,
    AlertCircle,
    CheckCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModeToggle } from "@/components/mode-toggle";
import { Switch } from '@/components/ui/switch';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Loading } from "@/components/ui/loading";

const MAX_BOTS = 3;

interface StrategyOption {
    name: string;
    displayName: string;
    description: string;
    features: string[];
    riskLevel: string;
    recommendedFor: string;
}

interface ProvisionConfig {
    instanceId: string;
    strategy: string;
    exchange: string;
    stake_currency: string;
    stake_amount: number;
    max_open_trades: number;
    dry_run: boolean;
    tradingPairs: string[];
}

export default function BotProvisioningPage() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const [strategies, setStrategies] = useState<StrategyOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [provisioning, setProvisioning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [botCount, setBotCount] = useState(0);

    const [provisionConfig, setProvisionConfig] = useState<ProvisionConfig>({
        instanceId: '',
        strategy: 'EmaRsiStrategy',
        exchange: 'kraken',
        stake_currency: 'USD',
        stake_amount: 100,
        max_open_trades: 3,
        dry_run: true,
        tradingPairs: ['BTC/USD', 'ETH/USD', 'SOL/USD']
    });

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

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                const token = await getAuthToken();
                if (!token) return;

                // Fetch strategies
                const strategiesRes = await fetch(`${config.botManager.baseUrl}/api/strategies/enhanced`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (strategiesRes.ok) {
                    const data = await strategiesRes.json();
                    setStrategies(data.strategies || []);
                }

                // Fetch bots to check limit and generate name
                const botsRes = await fetch(`${config.botManager.baseUrl}/api/bots`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (botsRes.ok) {
                    const data = await botsRes.json();
                    const bots = data.bots || [];
                    setBotCount(bots.length);

                    // Generate default name
                    const prefix = user?.email?.split('@')[0] || 'user';
                    const sanitized = prefix.replace(/[^a-zA-Z0-9]/g, '');
                    const existingNumbers = bots
                        .map((b: any) => {
                            const match = b.instanceId.match(/-bot-(\d+)$/);
                            return match ? parseInt(match[1]) : 0;
                        })
                        .filter((n: number) => n > 0);
                    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;

                    setProvisionConfig(prev => ({
                        ...prev,
                        instanceId: `${sanitized}-bot-${nextNumber}`
                    }));
                }
            } catch (error) {
                console.error('Error loading data:', error);
            } finally {
                setLoading(false);
            }
        };
        loadData();
    }, [user]);

    const handleProvision = async () => {
        if (botCount >= MAX_BOTS) {
            setError(`You can only have ${MAX_BOTS} bots maximum`);
            return;
        }

        setProvisioning(true);
        setError(null);

        try {
            const token = await getAuthToken();
            if (!token) throw new Error('Not authenticated');

            const response = await fetch(`${config.botManager.baseUrl}/api/provision`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    instanceId: provisionConfig.instanceId,
                    strategy: provisionConfig.strategy,
                    exchange: provisionConfig.exchange,
                    stake_currency: provisionConfig.stake_currency,
                    stake_amount: provisionConfig.stake_amount,
                    max_open_trades: provisionConfig.max_open_trades,
                    dry_run: provisionConfig.dry_run,
                    tradingPairs: provisionConfig.tradingPairs
                })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                navigate('/bot-console');
            } else {
                throw new Error(data.message || 'Failed to provision bot');
            }
        } catch (error: any) {
            setError(error.message || 'Failed to provision bot');
        } finally {
            setProvisioning(false);
        }
    };

    if (loading) {
        return <Loading message="Loading bot provisioning..." />;
    }

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
                <div className="flex flex-col min-h-screen bg-background">
                    <header className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b bg-background/95 backdrop-blur px-6">
                        <div className="flex items-center gap-2">
                            <SidebarTrigger className="-ml-1" />
                            <Separator orientation="vertical" className="mr-2 h-4" />
                            <span className="crypto-dashboard-title text-xl">Crypto Pilot</span>
                            <Badge variant="outline" className="ml-2">Provisioning</Badge>
                        </div>
                        <div className="ml-auto">
                            <ModeToggle />
                        </div>
                    </header>

                    <main className="flex-1 p-6 w-full">
                        {error && (
                            <div className="mb-6 p-4 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2 text-destructive">
                                <AlertCircle className="h-5 w-5" />
                                <span>{error}</span>
                            </div>
                        )}

                        <Card>
                            <CardHeader>
                                <div className="flex items-center gap-2">
                                    <Bot className="h-6 w-6 text-primary" />
                                    <div>
                                        <CardTitle>Bot Configuration</CardTitle>
                                        <CardDescription>Configure your new trading bot instance</CardDescription>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-6">
                                {/* Bot Name */}
                                <div className="grid gap-2">
                                    <Label htmlFor="botName">Bot Name</Label>
                                    <Input
                                        id="botName"
                                        value={provisionConfig.instanceId}
                                        onChange={(e) => setProvisionConfig(prev => ({ ...prev, instanceId: e.target.value }))}
                                        placeholder="my-trading-bot-1"
                                    />
                                    <p className="text-xs text-muted-foreground">Unique identifier for your bot instance</p>
                                </div>

                                {/* Strategy Selection */}
                                <div className="grid gap-2">
                                    <Label>Trading Strategy</Label>
                                    <Select
                                        value={provisionConfig.strategy}
                                        onValueChange={(value) => setProvisionConfig(prev => ({ ...prev, strategy: value }))}
                                    >
                                        <SelectTrigger
                                            className="w-60 max-w-sm"
                                            style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                        >
                                            <SelectValue placeholder="Select a strategy" />
                                        </SelectTrigger>
                                        <SelectContent
                                            className="w-60 max-w-sm"
                                            style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                        >
                                            {strategies.map((strategy) => (
                                                <SelectItem key={strategy.name} value={strategy.name}>
                                                    <div className="flex flex-col py-1">
                                                        <span className="font-medium">{strategy.displayName}</span>
                                                        <span className="text-xs text-muted-foreground">{strategy.description}</span>
                                                    </div>
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid grid-cols-2 gap-6">
                                    {/* Exchange */}
                                    <div className="grid gap-2">
                                        <Label>Exchange</Label>
                                        <Select
                                            value={provisionConfig.exchange}
                                            onValueChange={(value) => setProvisionConfig(prev => ({ ...prev, exchange: value }))}
                                        >
                                            <SelectTrigger
                                                className="w-44 max-w-xs"
                                                style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent
                                                className="w-44 max-w-xs"
                                                style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                            >
                                                <SelectItem value="kraken">Kraken</SelectItem>
                                                <SelectItem value="binance">Binance</SelectItem>
                                                <SelectItem value="coinbase">Coinbase</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Stake Currency */}
                                    <div className="grid gap-2">
                                        <Label>Stake Currency</Label>
                                        <Select
                                            value={provisionConfig.stake_currency}
                                            onValueChange={(value) => setProvisionConfig(prev => ({ ...prev, stake_currency: value }))}
                                        >
                                            <SelectTrigger
                                                className="w-44 max-w-xs"
                                                style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent
                                                className="w-44 max-w-xs"
                                                style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                            >
                                                <SelectItem value="USD">USD</SelectItem>
                                                <SelectItem value="USDT">USDT</SelectItem>
                                                <SelectItem value="EUR">EUR</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-6">
                                    {/* Stake Amount */}
                                    <div className="grid gap-2">
                                        <Label htmlFor="stakeAmount">Stake Amount</Label>
                                        <Input
                                            id="stakeAmount"
                                            type="number"
                                            value={provisionConfig.stake_amount}
                                            onChange={(e) => setProvisionConfig(prev => ({ ...prev, stake_amount: Number(e.target.value) }))}
                                        />
                                    </div>

                                    {/* Max Open Trades */}
                                    <div className="grid gap-2">
                                        <Label htmlFor="maxTrades">Max Open Trades</Label>
                                        <Input
                                            id="maxTrades"
                                            type="number"
                                            min="1"
                                            max="10"
                                            value={provisionConfig.max_open_trades}
                                            onChange={(e) => setProvisionConfig(prev => ({ ...prev, max_open_trades: Number(e.target.value) }))}
                                        />
                                    </div>
                                </div>

                                {/* Dry Run Toggle */}
                                <div className="flex items-center justify-between rounded-lg border p-4 bg-muted/50">
                                    <div className="space-y-0.5">
                                        <Label className="text-base">Dry Run Mode</Label>
                                        <p className="text-sm text-muted-foreground">
                                            Simulate trades without using real money (Paper Trading)
                                        </p>
                                    </div>
                                    <Switch
                                        checked={provisionConfig.dry_run}
                                        onCheckedChange={(checked) => setProvisionConfig(prev => ({ ...prev, dry_run: checked }))}
                                    />
                                </div>
                            </CardContent>
                            <CardFooter className="flex justify-end gap-4 border-t px-6 py-4">
                                <Button variant="outline" onClick={() => navigate('/bot-console')}>
                                    Cancel
                                </Button>
                                <Button onClick={handleProvision} disabled={provisioning || botCount >= MAX_BOTS}>
                                    {provisioning ? (
                                        <>
                                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                            Deploying...
                                        </>
                                    ) : (
                                        <>
                                            <CheckCircle className="h-4 w-4 mr-2" />
                                            Deploy Bot
                                        </>
                                    )}
                                </Button>
                            </CardFooter>
                        </Card>
                    </main>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
}
