import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { config } from '@/lib/config';
import { auth } from '@/lib/firebase';
import {
    ArrowLeft,
    Bot,
    Settings,
    AlertCircle,
    CheckCircle,
    Activity,
    TrendingUp,
    Shield,
    Clock,
    Zap,
    AlertTriangle,
    BarChart3,
    Target,
    Save,
    RotateCcw,
    Play,
    Info
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
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

// Types for Universal Features
interface TakeProfitLevel {
    percentage: number;
    exitPercent: number;
}

interface UniversalFeatures {
    takeProfitLevels: {
        enabled: boolean;
        mode: 'ladder' | 'single';
        levels: TakeProfitLevel[];
    };
    trailingStop: {
        enabled: boolean;
        activationPercent: number;
        callbackRate: number;
        lockInProfit: boolean;
    };
    dailyLossProtection: {
        enabled: boolean;
        maxDailyLossPercent: number;
        pauseUntil: 'nextDay' | 'manual';
        closePositions: boolean;
    };
    tradingSchedule: {
        enabled: boolean;
        activeHours: { start: string; end: string };
        activeDays: string[];
    };
    positionLimits: {
        enabled: boolean;
        maxPercentPerAsset: number;
        maxPositionsPerAsset: number;
        maxCorrelatedPositions: number;
    };
    volatilityAdjustment: {
        enabled: boolean;
        method: 'ATR' | 'stdDev' | 'bollingerWidth';
        minSizeMultiplier: number;
        maxSizeMultiplier: number;
    };
    emergencyStop: {
        enabled: boolean;
        triggers: {
            btcDropPercent: number;
            portfolioDropPercent: number;
        };
        actions: {
            closeAllPositions: boolean;
            pauseDurationHours: number;
        };
    };
    orderExecution: {
        enabled: boolean;
        useLimit: boolean;
        limitOffsetPercent: number;
        postOnly: boolean;
    };
}

// Risk settings from existing universal-risk-manager
interface RiskSettings {
    riskLevel: number;
    autoRebalance: boolean;
    dcaEnabled: boolean;
}

// Bot info interface
interface BotInfo {
    instanceId: string;
    strategy: string;
    port: number;
    exchange: string;
    stake_currency: string;
    dry_run: boolean;
    containerStatus: 'running' | 'stopped' | 'error' | 'unknown';
}

const DEFAULT_FEATURES: UniversalFeatures = {
    takeProfitLevels: {
        enabled: true,
        mode: 'ladder',
        levels: [
            { percentage: 2, exitPercent: 25 },
            { percentage: 5, exitPercent: 50 },
            { percentage: 10, exitPercent: 100 }
        ]
    },
    trailingStop: {
        enabled: true,
        activationPercent: 3,
        callbackRate: 1.5,
        lockInProfit: true
    },
    dailyLossProtection: {
        enabled: true,
        maxDailyLossPercent: 5,
        pauseUntil: 'nextDay',
        closePositions: false
    },
    tradingSchedule: {
        enabled: false,
        activeHours: { start: '00:00', end: '23:59' },
        activeDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
    },
    positionLimits: {
        enabled: true,
        maxPercentPerAsset: 30,
        maxPositionsPerAsset: 3,
        maxCorrelatedPositions: 2
    },
    volatilityAdjustment: {
        enabled: true,
        method: 'ATR',
        minSizeMultiplier: 0.5,
        maxSizeMultiplier: 1.5
    },
    emergencyStop: {
        enabled: true,
        triggers: {
            btcDropPercent: 15,
            portfolioDropPercent: 20
        },
        actions: {
            closeAllPositions: false,
            pauseDurationHours: 4
        }
    },
    orderExecution: {
        enabled: true,
        useLimit: true,
        limitOffsetPercent: 0.1,
        postOnly: true
    }
};

const DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// Defensive normalization to ensure shapes are correct even if backend returns partial/malformed data
const normalizeFeatures = (raw: any): UniversalFeatures => {
    const features = raw && typeof raw === 'object' ? raw : {};

    const takeProfit = features.takeProfitLevels || {};
    const levels = Array.isArray(takeProfit.levels) ? takeProfit.levels : DEFAULT_FEATURES.takeProfitLevels.levels;

    const tradingSchedule = features.tradingSchedule || {};
    const activeDays = Array.isArray(tradingSchedule.activeDays) ? tradingSchedule.activeDays : DEFAULT_FEATURES.tradingSchedule.activeDays;

    return {
        ...DEFAULT_FEATURES,
        ...features,
        takeProfitLevels: {
            ...DEFAULT_FEATURES.takeProfitLevels,
            ...takeProfit,
            levels
        },
        trailingStop: {
            ...DEFAULT_FEATURES.trailingStop,
            ...(features.trailingStop || {})
        },
        dailyLossProtection: {
            ...DEFAULT_FEATURES.dailyLossProtection,
            ...(features.dailyLossProtection || {})
        },
        tradingSchedule: {
            ...DEFAULT_FEATURES.tradingSchedule,
            ...tradingSchedule,
            activeDays
        },
        positionLimits: {
            ...DEFAULT_FEATURES.positionLimits,
            ...(features.positionLimits || {})
        },
        volatilityAdjustment: {
            ...DEFAULT_FEATURES.volatilityAdjustment,
            ...(features.volatilityAdjustment || {})
        },
        emergencyStop: {
            ...DEFAULT_FEATURES.emergencyStop,
            ...(features.emergencyStop || {}),
            triggers: {
                ...DEFAULT_FEATURES.emergencyStop.triggers,
                ...((features.emergencyStop && features.emergencyStop.triggers) || {})
            },
            actions: {
                ...DEFAULT_FEATURES.emergencyStop.actions,
                ...((features.emergencyStop && features.emergencyStop.actions) || {})
            }
        },
        orderExecution: {
            ...DEFAULT_FEATURES.orderExecution,
            ...(features.orderExecution || {})
        }
    } as UniversalFeatures;
};

// Helper component for feature section headers
const FeatureHeader = ({ 
    icon: Icon, 
    title, 
    description, 
    enabled, 
    onToggle,
    disabled = false
}: { 
    icon: React.ElementType; 
    title: string; 
    description: string; 
    enabled: boolean; 
    onToggle: (enabled: boolean) => void;
    disabled?: boolean;
}) => (
    <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                <Icon className="h-5 w-5" />
            </div>
            <div>
                <h3 className="font-semibold text-sm">{title}</h3>
                <p className="text-xs text-muted-foreground">{description}</p>
            </div>
        </div>
        <Switch 
            checked={enabled} 
            onCheckedChange={onToggle}
            disabled={disabled}
        />
    </div>
);

// Info tooltip component
const InfoTooltip = ({ content }: { content: string }) => (
    <TooltipProvider>
        <Tooltip>
            <TooltipTrigger asChild>
                <Info className="h-4 w-4 text-muted-foreground cursor-help ml-1" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
                <p className="text-xs">{content}</p>
            </TooltipContent>
        </Tooltip>
    </TooltipProvider>
);

export default function BotConfigPage() {
    const { botId } = useParams<{ botId: string }>();
    const navigate = useNavigate();
    
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [showResetDialog, setShowResetDialog] = useState(false);
    
    const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
    const [features, setFeatures] = useState<UniversalFeatures>(DEFAULT_FEATURES);
    const [riskSettings, setRiskSettings] = useState<RiskSettings>({
        riskLevel: 50,
        autoRebalance: true,
        dcaEnabled: true
    });
    const [originalFeatures, setOriginalFeatures] = useState<UniversalFeatures>(DEFAULT_FEATURES);
    const [originalRiskSettings, setOriginalRiskSettings] = useState<RiskSettings>({
        riskLevel: 50,
        autoRebalance: true,
        dcaEnabled: true
    });

    // Monitor state
    const [monitorStatus, setMonitorStatus] = useState<{ running: boolean; botCount: number } | null>(null);

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

    // Fetch bot info and settings
    const fetchBotData = useCallback(async () => {
        if (!botId) return;
        
        setLoading(true);
        setError(null);
        
        try {
            const token = await getAuthToken();
            if (!token) {
                setError('Authentication required');
                return;
            }

            // Fetch bot info (using API gateway proxy for CORS compatibility)
            const botsResponse = await fetch(`${config.api.baseUrl}/api/freqtrade/bots`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (botsResponse.ok) {
                const botsData = await botsResponse.json();
                const bot = botsData.bots?.find((b: BotInfo) => b.instanceId === botId);
                if (bot) {
                    setBotInfo(bot);
                } else {
                    setError('Bot not found');
                    return;
                }
            }

            // Fetch universal features (using API gateway proxy)
            const featuresResponse = await fetch(
                `${config.api.baseUrl}/api/freqtrade/universal-features/${botId}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            
            if (featuresResponse.ok) {
                const featuresData = await featuresResponse.json();
                if (featuresData.success && featuresData.data) {
                    const normalized = normalizeFeatures(featuresData.data);
                    setFeatures(normalized);
                    setOriginalFeatures(JSON.parse(JSON.stringify(normalized)));
                }
            }

            // Fetch risk settings (existing universal-settings) - using API gateway proxy
            const riskResponse = await fetch(
                `${config.api.baseUrl}/api/freqtrade/universal-settings/${botId}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            
            if (riskResponse.ok) {
                const riskData = await riskResponse.json();
                const settingsSource = riskData.settings || riskData.data?.settings;
                if (settingsSource) {
                    const settings = {
                        riskLevel: settingsSource.riskLevel ?? 50,
                        autoRebalance: settingsSource.autoRebalance ?? true,
                        dcaEnabled: settingsSource.dcaEnabled ?? true
                    };
                    setRiskSettings(settings);
                    setOriginalRiskSettings({ ...settings });
                }
            }

            // Fetch monitor status - using API gateway proxy
            const monitorResponse = await fetch(
                `${config.api.baseUrl}/api/freqtrade/trade-monitor/status`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            
            if (monitorResponse.ok) {
                const monitorData = await monitorResponse.json();
                if (monitorData.success) {
                    setMonitorStatus({
                        running: monitorData.data.running,
                        botCount: monitorData.data.botCount
                    });
                }
            }

        } catch (err) {
            console.error('Error fetching bot data:', err);
            setError('Failed to load bot configuration');
        } finally {
            setLoading(false);
        }
    }, [botId]);

    useEffect(() => {
        fetchBotData();
    }, [fetchBotData]);

    // Check for changes
    useEffect(() => {
        const featuresChanged = JSON.stringify(features) !== JSON.stringify(originalFeatures);
        const riskChanged = JSON.stringify(riskSettings) !== JSON.stringify(originalRiskSettings);
        setHasChanges(featuresChanged || riskChanged);
    }, [features, riskSettings, originalFeatures, originalRiskSettings]);

    // Update feature helper
    const updateFeature = <K extends keyof UniversalFeatures>(
        key: K,
        value: Partial<UniversalFeatures[K]>
    ) => {
        setFeatures(prev => ({
            ...prev,
            [key]: { ...prev[key], ...value }
        }));
    };

    // Save changes
    const handleSave = async () => {
        if (!botId) return;
        
        setSaving(true);
        setError(null);
        
        try {
            const token = await getAuthToken();
            if (!token) {
                setError('Authentication required');
                return;
            }

            // Save universal features - using API gateway proxy
            const featuresResponse = await fetch(
                `${config.api.baseUrl}/api/freqtrade/universal-features/${botId}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(features)
                }
            );
            
            if (!featuresResponse.ok) {
                const errorData = await featuresResponse.json();
                throw new Error(errorData.message || 'Failed to save features');
            }

            // Save risk settings - using API gateway proxy
            const riskResponse = await fetch(
                `${config.api.baseUrl}/api/freqtrade/universal-settings/${botId}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(riskSettings)
                }
            );
            
            if (!riskResponse.ok) {
                const errorData = await riskResponse.json();
                throw new Error(errorData.message || 'Failed to save risk settings');
            }

            setOriginalFeatures(JSON.parse(JSON.stringify(features)));
            setOriginalRiskSettings({ ...riskSettings });
            setSuccess('Configuration saved successfully');
            setHasChanges(false);

            // Clear success message after 3 seconds
            setTimeout(() => setSuccess(null), 3000);

        } catch (err: any) {
            console.error('Error saving configuration:', err);
            setError(err.message || 'Failed to save configuration');
        } finally {
            setSaving(false);
        }
    };

    // Reset to defaults
    const handleReset = async () => {
        if (!botId) return;
        
        setSaving(true);
        setError(null);
        
        try {
            const token = await getAuthToken();
            if (!token) {
                setError('Authentication required');
                return;
            }

            const response = await fetch(
                `${config.api.baseUrl}/api/freqtrade/universal-features/${botId}/reset`,
                {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                }
            );
            
            if (response.ok) {
                const normalized = normalizeFeatures(DEFAULT_FEATURES);
                setFeatures(normalized);
                setOriginalFeatures(JSON.parse(JSON.stringify(normalized)));
                setSuccess('Configuration reset to defaults');
                setHasChanges(false);
                setTimeout(() => setSuccess(null), 3000);
            } else {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to reset');
            }

        } catch (err: any) {
            console.error('Error resetting configuration:', err);
            setError(err.message || 'Failed to reset configuration');
        } finally {
            setSaving(false);
            setShowResetDialog(false);
        }
    };

    // Resume from emergency pause
    const handleResumeFromPause = async () => {
        if (!botId) return;
        
        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(
                `${config.api.baseUrl}/api/freqtrade/universal-features/${botId}/resume`,
                {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                }
            );
            
            if (response.ok) {
                setSuccess('Trading resumed');
                setTimeout(() => setSuccess(null), 3000);
            }
        } catch (err) {
            console.error('Error resuming:', err);
        }
    };

    // Add/remove take profit level
    const addTakeProfitLevel = () => {
        const newLevels = [...features.takeProfitLevels.levels];
        const lastLevel = newLevels[newLevels.length - 1] || { percentage: 0, exitPercent: 0 };
        newLevels.push({
            percentage: lastLevel.percentage + 5,
            exitPercent: Math.min(lastLevel.exitPercent + 25, 100)
        });
        updateFeature('takeProfitLevels', { levels: newLevels });
    };

    const removeTakeProfitLevel = (index: number) => {
        const newLevels = features.takeProfitLevels.levels.filter((_, i) => i !== index);
        updateFeature('takeProfitLevels', { levels: newLevels });
    };

    const updateTakeProfitLevel = (index: number, field: keyof TakeProfitLevel, value: number) => {
        const newLevels = [...features.takeProfitLevels.levels];
        newLevels[index] = { ...newLevels[index], [field]: value };
        updateFeature('takeProfitLevels', { levels: newLevels });
    };

    // Toggle trading day
    const toggleTradingDay = (day: string) => {
        const currentDays = features.tradingSchedule.activeDays;
        const newDays = currentDays.includes(day)
            ? currentDays.filter(d => d !== day)
            : [...currentDays, day];
        updateFeature('tradingSchedule', { activeDays: newDays });
    };

    if (loading) {
        return <Loading message="Loading bot configuration..." />;
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
                            <Button 
                                variant="ghost" 
                                size="sm" 
                                onClick={() => navigate('/bot-console')}
                                className="gap-1"
                            >
                                <ArrowLeft className="h-4 w-4" />
                                Back
                            </Button>
                            <Separator orientation="vertical" className="mx-2 h-4" />
                            <div className="flex items-center gap-2">
                                <Bot className="h-5 w-5 text-primary" />
                                <span className="font-semibold">{botId}</span>
                            </div>
                            <Badge variant="outline" className="ml-2">Configuration</Badge>
                        </div>
                        <div className="ml-auto flex items-center gap-4">
                            {monitorStatus && (
                                <Badge variant={monitorStatus.running ? 'default' : 'secondary'} className="gap-1">
                                    <Activity className="h-3 w-3" />
                                    Monitor: {monitorStatus.running ? 'Active' : 'Inactive'}
                                </Badge>
                            )}
                            {botInfo && (
                                <Badge 
                                    variant={botInfo.containerStatus === 'running' ? 'default' : 'secondary'}
                                    className={botInfo.containerStatus === 'running' ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' : ''}
                                >
                                    {botInfo.containerStatus === 'running' ? 'Running' : 'Stopped'}
                                </Badge>
                            )}
                            <ModeToggle />
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setShowResetDialog(true)}
                                disabled={saving}
                            >
                                <RotateCcw className="h-4 w-4 mr-1" />
                                Reset
                            </Button>
                            <Button
                                size="sm"
                                onClick={handleSave}
                                disabled={!hasChanges || saving}
                                className="gap-1"
                            >
                                {saving ? (
                                    <LoadingSpinner size="sm" />
                                ) : (
                                    <Save className="h-4 w-4" />
                                )}
                                Save Changes
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
                    <main className="flex-1 p-6">
                        <Tabs defaultValue="profit" className="space-y-6">
                            <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8 gap-1">
                                <TabsTrigger value="profit" className="gap-1">
                                    <Target className="h-4 w-4" />
                                    <span className="hidden sm:inline">Take Profit</span>
                                </TabsTrigger>
                                <TabsTrigger value="trailing" className="gap-1">
                                    <TrendingUp className="h-4 w-4" />
                                    <span className="hidden sm:inline">Trailing</span>
                                </TabsTrigger>
                                <TabsTrigger value="protection" className="gap-1">
                                    <Shield className="h-4 w-4" />
                                    <span className="hidden sm:inline">Protection</span>
                                </TabsTrigger>
                                <TabsTrigger value="schedule" className="gap-1">
                                    <Clock className="h-4 w-4" />
                                    <span className="hidden sm:inline">Schedule</span>
                                </TabsTrigger>
                                <TabsTrigger value="position" className="gap-1">
                                    <BarChart3 className="h-4 w-4" />
                                    <span className="hidden sm:inline">Limits</span>
                                </TabsTrigger>
                                <TabsTrigger value="volatility" className="gap-1">
                                    <Activity className="h-4 w-4" />
                                    <span className="hidden sm:inline">Volatility</span>
                                </TabsTrigger>
                                <TabsTrigger value="emergency" className="gap-1">
                                    <AlertTriangle className="h-4 w-4" />
                                    <span className="hidden sm:inline">Emergency</span>
                                </TabsTrigger>
                                <TabsTrigger value="execution" className="gap-1">
                                    <Zap className="h-4 w-4" />
                                    <span className="hidden sm:inline">Execution</span>
                                </TabsTrigger>
                            </TabsList>

                            {/* Take Profit Levels */}
                            <TabsContent value="profit">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={Target}
                                            title="Take Profit Levels"
                                            description="Automatically take profits at predefined price levels"
                                            enabled={features.takeProfitLevels.enabled}
                                            onToggle={(enabled) => updateFeature('takeProfitLevels', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="flex items-center gap-4">
                                            <Label className="min-w-[80px]">Mode</Label>
                                            <Select
                                                value={features.takeProfitLevels.mode}
                                                onValueChange={(value: 'ladder' | 'single') => 
                                                    updateFeature('takeProfitLevels', { mode: value })
                                                }
                                                disabled={!features.takeProfitLevels.enabled || saving}
                                            >
                                                <SelectTrigger
                                                    className="w-52 max-w-xs"
                                                    style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent
                                                    className="w-52 max-w-xs"
                                                    style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                                >
                                                    <SelectItem value="ladder">Ladder (Multiple Exits)</SelectItem>
                                                    <SelectItem value="single">Single Exit</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <InfoTooltip content="Ladder mode sells portions at each level. Single mode sells all at first hit level." />
                                        </div>

                                        <Separator />

                                        <div className="space-y-4">
                                            <div className="flex items-center justify-between">
                                                <Label className="text-sm font-medium">Profit Levels</Label>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={addTakeProfitLevel}
                                                    disabled={!features.takeProfitLevels.enabled || saving || features.takeProfitLevels.levels.length >= 5}
                                                >
                                                    Add Level
                                                </Button>
                                            </div>
                                            
                                            {features.takeProfitLevels.levels.map((level, index) => (
                                                <div key={index} className="flex items-center gap-4 p-4 bg-muted/50 rounded-lg">
                                                    <div className="flex-1 space-y-2">
                                                        <div className="flex items-center gap-2">
                                                            <Label className="min-w-[100px] text-xs">At Profit %</Label>
                                                            <Input
                                                                type="number"
                                                                value={level.percentage}
                                                                onChange={(e) => updateTakeProfitLevel(index, 'percentage', parseFloat(e.target.value) || 0)}
                                                                className="w-24"
                                                                step={0.5}
                                                                min={0}
                                                                max={100}
                                                                disabled={!features.takeProfitLevels.enabled || saving}
                                                            />
                                                            <span className="text-sm text-muted-foreground">%</span>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <Label className="min-w-[100px] text-xs">Sell Amount</Label>
                                                            <Slider
                                                                value={[level.exitPercent]}
                                                                onValueChange={([value]) => updateTakeProfitLevel(index, 'exitPercent', value)}
                                                                max={100}
                                                                min={5}
                                                                step={5}
                                                                className="flex-1"
                                                                disabled={!features.takeProfitLevels.enabled || saving}
                                                            />
                                                            <span className="text-sm font-medium w-12">{level.exitPercent}%</span>
                                                        </div>
                                                    </div>
                                                    {features.takeProfitLevels.levels.length > 1 && (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => removeTakeProfitLevel(index)}
                                                            disabled={!features.takeProfitLevels.enabled || saving}
                                                            className="text-destructive hover:text-destructive"
                                                        >
                                                            ×
                                                        </Button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>

                            {/* Trailing Stop */}
                            <TabsContent value="trailing">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={TrendingUp}
                                            title="Trailing Stop"
                                            description="Dynamically follow price to lock in profits"
                                            enabled={features.trailingStop.enabled}
                                            onToggle={(enabled) => updateFeature('trailingStop', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="space-y-4">
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label className="flex items-center">
                                                        Activation Profit
                                                        <InfoTooltip content="Trailing stop activates when this profit % is reached" />
                                                    </Label>
                                                    <span className="text-sm font-medium">{features.trailingStop.activationPercent}%</span>
                                                </div>
                                                <Slider
                                                    value={[features.trailingStop.activationPercent]}
                                                    onValueChange={([value]) => updateFeature('trailingStop', { activationPercent: value })}
                                                    max={20}
                                                    min={0.5}
                                                    step={0.5}
                                                    disabled={!features.trailingStop.enabled || saving}
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label className="flex items-center">
                                                        Callback Rate
                                                        <InfoTooltip content="How far price can drop from peak before selling" />
                                                    </Label>
                                                    <span className="text-sm font-medium">{features.trailingStop.callbackRate}%</span>
                                                </div>
                                                <Slider
                                                    value={[features.trailingStop.callbackRate]}
                                                    onValueChange={([value]) => updateFeature('trailingStop', { callbackRate: value })}
                                                    max={10}
                                                    min={0.5}
                                                    step={0.25}
                                                    disabled={!features.trailingStop.enabled || saving}
                                                />
                                            </div>

                                            <Separator />

                                            <div className="flex items-center justify-between">
                                                <div className="space-y-0.5">
                                                    <Label className="flex items-center">
                                                        Lock In Profit
                                                        <InfoTooltip content="Never let a winning trade turn into a loss" />
                                                    </Label>
                                                    <p className="text-xs text-muted-foreground">
                                                        Ensure minimum 0% profit once activated
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={features.trailingStop.lockInProfit}
                                                    onCheckedChange={(checked) => updateFeature('trailingStop', { lockInProfit: checked })}
                                                    disabled={!features.trailingStop.enabled || saving}
                                                />
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>

                            {/* Daily Loss Protection */}
                            <TabsContent value="protection">
                                <div className="grid gap-6 md:grid-cols-2">
                                    <Card>
                                        <CardHeader>
                                            <FeatureHeader
                                                icon={Shield}
                                                title="Daily Loss Protection"
                                                description="Stop trading when daily losses exceed threshold"
                                                enabled={features.dailyLossProtection.enabled}
                                                onToggle={(enabled) => updateFeature('dailyLossProtection', { enabled })}
                                                disabled={saving}
                                            />
                                        </CardHeader>
                                        <CardContent className="space-y-6">
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label>Max Daily Loss</Label>
                                                    <span className="text-sm font-medium text-destructive">
                                                        -{features.dailyLossProtection.maxDailyLossPercent}%
                                                    </span>
                                                </div>
                                                <Slider
                                                    value={[features.dailyLossProtection.maxDailyLossPercent]}
                                                    onValueChange={([value]) => updateFeature('dailyLossProtection', { maxDailyLossPercent: value })}
                                                    max={20}
                                                    min={1}
                                                    step={0.5}
                                                    disabled={!features.dailyLossProtection.enabled || saving}
                                                />
                                            </div>

                                            <div className="flex items-center gap-4">
                                                <Label className="min-w-[100px]">Resume Trading</Label>
                                                <Select
                                                    value={features.dailyLossProtection.pauseUntil}
                                                    onValueChange={(value: 'nextDay' | 'manual') => 
                                                        updateFeature('dailyLossProtection', { pauseUntil: value })
                                                    }
                                                    disabled={!features.dailyLossProtection.enabled || saving}
                                                >
                                                    <SelectTrigger
                                                        className="w-52 max-w-xs"
                                                        style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                                    >
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent
                                                        className="w-52 max-w-xs"
                                                        style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                                    >
                                                        <SelectItem value="nextDay">Next Trading Day</SelectItem>
                                                        <SelectItem value="manual">Manual Resume</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div className="flex items-center justify-between">
                                                <div className="space-y-0.5">
                                                    <Label>Close All Positions</Label>
                                                    <p className="text-xs text-muted-foreground">
                                                        Close open positions when triggered
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={features.dailyLossProtection.closePositions}
                                                    onCheckedChange={(checked) => updateFeature('dailyLossProtection', { closePositions: checked })}
                                                    disabled={!features.dailyLossProtection.enabled || saving}
                                                />
                                            </div>
                                        </CardContent>
                                    </Card>

                                    {/* Risk Settings Card */}
                                    <Card>
                                        <CardHeader>
                                            <div className="flex items-center gap-3 mb-4">
                                                <div className="p-2 rounded-lg bg-primary/10 text-primary">
                                                    <Settings className="h-5 w-5" />
                                                </div>
                                                <div>
                                                    <h3 className="font-semibold text-sm">Risk Settings</h3>
                                                    <p className="text-xs text-muted-foreground">Basic risk management controls</p>
                                                </div>
                                            </div>
                                        </CardHeader>
                                        <CardContent className="space-y-6">
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label>Risk Level</Label>
                                                    <span className="text-sm font-medium">{riskSettings.riskLevel}%</span>
                                                </div>
                                                <Slider
                                                    value={[riskSettings.riskLevel]}
                                                    onValueChange={([value]) => setRiskSettings(prev => ({ ...prev, riskLevel: value }))}
                                                    max={100}
                                                    min={0}
                                                    step={5}
                                                    disabled={saving}
                                                />
                                                <p className="text-xs text-muted-foreground">
                                                    Controls position sizing and trade frequency
                                                </p>
                                            </div>

                                            <div className="flex items-center justify-between">
                                                <div className="space-y-0.5">
                                                    <Label>Auto-Rebalance</Label>
                                                    <p className="text-xs text-muted-foreground">
                                                        Automatically rebalance portfolio
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={riskSettings.autoRebalance}
                                                    onCheckedChange={(checked) => setRiskSettings(prev => ({ ...prev, autoRebalance: checked }))}
                                                    disabled={saving}
                                                />
                                            </div>

                                            <div className="flex items-center justify-between">
                                                <div className="space-y-0.5">
                                                    <Label>DCA Enabled</Label>
                                                    <p className="text-xs text-muted-foreground">
                                                        Dollar-cost averaging on entries
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={riskSettings.dcaEnabled}
                                                    onCheckedChange={(checked) => setRiskSettings(prev => ({ ...prev, dcaEnabled: checked }))}
                                                    disabled={saving}
                                                />
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>
                            </TabsContent>

                            {/* Trading Schedule */}
                            <TabsContent value="schedule">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={Clock}
                                            title="Trading Schedule"
                                            description="Restrict trading to specific hours and days"
                                            enabled={features.tradingSchedule.enabled}
                                            onToggle={(enabled) => updateFeature('tradingSchedule', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="grid gap-4 md:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label>Start Time (UTC)</Label>
                                                <Input
                                                    type="time"
                                                    value={features.tradingSchedule.activeHours.start}
                                                    onChange={(e) => updateFeature('tradingSchedule', { 
                                                        activeHours: { ...features.tradingSchedule.activeHours, start: e.target.value }
                                                    })}
                                                    disabled={!features.tradingSchedule.enabled || saving}
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <Label>End Time (UTC)</Label>
                                                <Input
                                                    type="time"
                                                    value={features.tradingSchedule.activeHours.end}
                                                    onChange={(e) => updateFeature('tradingSchedule', { 
                                                        activeHours: { ...features.tradingSchedule.activeHours, end: e.target.value }
                                                    })}
                                                    disabled={!features.tradingSchedule.enabled || saving}
                                                />
                                            </div>
                                        </div>

                                        <Separator />

                                        <div className="space-y-3">
                                            <Label>Active Trading Days</Label>
                                            <div className="flex flex-wrap gap-2">
                                                {DAYS_OF_WEEK.map(day => (
                                                    <Button
                                                        key={day}
                                                        variant={features.tradingSchedule.activeDays.includes(day) ? 'default' : 'outline'}
                                                        size="sm"
                                                        onClick={() => toggleTradingDay(day)}
                                                        disabled={!features.tradingSchedule.enabled || saving}
                                                        className="w-12"
                                                    >
                                                        {day}
                                                    </Button>
                                                ))}
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>

                            {/* Position Limits */}
                            <TabsContent value="position">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={BarChart3}
                                            title="Position Limits"
                                            description="Control portfolio concentration and exposure"
                                            enabled={features.positionLimits.enabled}
                                            onToggle={(enabled) => updateFeature('positionLimits', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <Label className="flex items-center">
                                                    Max % Per Asset
                                                    <InfoTooltip content="Maximum portfolio percentage in a single asset" />
                                                </Label>
                                                <span className="text-sm font-medium">{features.positionLimits.maxPercentPerAsset}%</span>
                                            </div>
                                            <Slider
                                                value={[features.positionLimits.maxPercentPerAsset]}
                                                onValueChange={([value]) => updateFeature('positionLimits', { maxPercentPerAsset: value })}
                                                max={100}
                                                min={5}
                                                step={5}
                                                disabled={!features.positionLimits.enabled || saving}
                                            />
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <Label className="flex items-center">
                                                    Max Positions Per Asset
                                                    <InfoTooltip content="Maximum number of separate positions in the same asset" />
                                                </Label>
                                                <span className="text-sm font-medium">{features.positionLimits.maxPositionsPerAsset}</span>
                                            </div>
                                            <Slider
                                                value={[features.positionLimits.maxPositionsPerAsset]}
                                                onValueChange={([value]) => updateFeature('positionLimits', { maxPositionsPerAsset: value })}
                                                max={10}
                                                min={1}
                                                step={1}
                                                disabled={!features.positionLimits.enabled || saving}
                                            />
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <Label className="flex items-center">
                                                    Max Correlated Positions
                                                    <InfoTooltip content="Maximum positions in highly correlated assets (e.g., BTC/ETH)" />
                                                </Label>
                                                <span className="text-sm font-medium">{features.positionLimits.maxCorrelatedPositions}</span>
                                            </div>
                                            <Slider
                                                value={[features.positionLimits.maxCorrelatedPositions]}
                                                onValueChange={([value]) => updateFeature('positionLimits', { maxCorrelatedPositions: value })}
                                                max={5}
                                                min={1}
                                                step={1}
                                                disabled={!features.positionLimits.enabled || saving}
                                            />
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>

                            {/* Volatility Adjustment */}
                            <TabsContent value="volatility">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={Activity}
                                            title="Volatility Adjustment"
                                            description="Dynamically adjust position sizes based on market volatility"
                                            enabled={features.volatilityAdjustment.enabled}
                                            onToggle={(enabled) => updateFeature('volatilityAdjustment', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="flex items-center gap-4">
                                            <Label className="min-w-[100px]">Method</Label>
                                            <Select
                                                value={features.volatilityAdjustment.method}
                                                onValueChange={(value: 'ATR' | 'stdDev' | 'bollingerWidth') => 
                                                    updateFeature('volatilityAdjustment', { method: value })
                                                }
                                                disabled={!features.volatilityAdjustment.enabled || saving}
                                            >
                                                <SelectTrigger
                                                    className="w-52 max-w-xs"
                                                    style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent
                                                    className="w-52 max-w-xs"
                                                    style={{ backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e5e7eb' }}
                                                >
                                                    <SelectItem value="ATR">ATR (Average True Range)</SelectItem>
                                                    <SelectItem value="stdDev">Standard Deviation</SelectItem>
                                                    <SelectItem value="bollingerWidth">Bollinger Width</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <Separator />

                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <Label className="flex items-center">
                                                    Min Size Multiplier
                                                    <InfoTooltip content="Reduce position size to this factor in high volatility" />
                                                </Label>
                                                <span className="text-sm font-medium">{features.volatilityAdjustment.minSizeMultiplier}x</span>
                                            </div>
                                            <Slider
                                                value={[features.volatilityAdjustment.minSizeMultiplier]}
                                                onValueChange={([value]) => updateFeature('volatilityAdjustment', { minSizeMultiplier: value })}
                                                max={1}
                                                min={0.1}
                                                step={0.1}
                                                disabled={!features.volatilityAdjustment.enabled || saving}
                                            />
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <Label className="flex items-center">
                                                    Max Size Multiplier
                                                    <InfoTooltip content="Increase position size to this factor in low volatility" />
                                                </Label>
                                                <span className="text-sm font-medium">{features.volatilityAdjustment.maxSizeMultiplier}x</span>
                                            </div>
                                            <Slider
                                                value={[features.volatilityAdjustment.maxSizeMultiplier]}
                                                onValueChange={([value]) => updateFeature('volatilityAdjustment', { maxSizeMultiplier: value })}
                                                max={3}
                                                min={1}
                                                step={0.1}
                                                disabled={!features.volatilityAdjustment.enabled || saving}
                                            />
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>

                            {/* Emergency Stop */}
                            <TabsContent value="emergency">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={AlertTriangle}
                                            title="Emergency Stop"
                                            description="Automatic protection during market crashes"
                                            enabled={features.emergencyStop.enabled}
                                            onToggle={(enabled) => updateFeature('emergencyStop', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="space-y-4">
                                            <h4 className="text-sm font-medium">Trigger Conditions</h4>
                                            
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label className="flex items-center">
                                                        BTC Drop (1 Hour)
                                                        <InfoTooltip content="Trigger if BTC drops this much in 1 hour" />
                                                    </Label>
                                                    <span className="text-sm font-medium text-destructive">
                                                        -{features.emergencyStop.triggers.btcDropPercent}%
                                                    </span>
                                                </div>
                                                <Slider
                                                    value={[features.emergencyStop.triggers.btcDropPercent]}
                                                    onValueChange={([value]) => updateFeature('emergencyStop', { 
                                                        triggers: { ...features.emergencyStop.triggers, btcDropPercent: value }
                                                    })}
                                                    max={30}
                                                    min={5}
                                                    step={1}
                                                    disabled={!features.emergencyStop.enabled || saving}
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label className="flex items-center">
                                                        Portfolio Drop (24 Hours)
                                                        <InfoTooltip content="Trigger if portfolio drops this much in 24 hours" />
                                                    </Label>
                                                    <span className="text-sm font-medium text-destructive">
                                                        -{features.emergencyStop.triggers.portfolioDropPercent}%
                                                    </span>
                                                </div>
                                                <Slider
                                                    value={[features.emergencyStop.triggers.portfolioDropPercent]}
                                                    onValueChange={([value]) => updateFeature('emergencyStop', { 
                                                        triggers: { ...features.emergencyStop.triggers, portfolioDropPercent: value }
                                                    })}
                                                    max={50}
                                                    min={5}
                                                    step={1}
                                                    disabled={!features.emergencyStop.enabled || saving}
                                                />
                                            </div>
                                        </div>

                                        <Separator />

                                        <div className="space-y-4">
                                            <h4 className="text-sm font-medium">Actions When Triggered</h4>

                                            <div className="flex items-center justify-between">
                                                <div className="space-y-0.5">
                                                    <Label>Close All Positions</Label>
                                                    <p className="text-xs text-muted-foreground">
                                                        Immediately sell all positions when triggered
                                                    </p>
                                                </div>
                                                <Switch
                                                    checked={features.emergencyStop.actions.closeAllPositions}
                                                    onCheckedChange={(checked) => updateFeature('emergencyStop', { 
                                                        actions: { ...features.emergencyStop.actions, closeAllPositions: checked }
                                                    })}
                                                    disabled={!features.emergencyStop.enabled || saving}
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <Label>Pause Duration</Label>
                                                    <span className="text-sm font-medium">{features.emergencyStop.actions.pauseDurationHours} hours</span>
                                                </div>
                                                <Slider
                                                    value={[features.emergencyStop.actions.pauseDurationHours]}
                                                    onValueChange={([value]) => updateFeature('emergencyStop', { 
                                                        actions: { ...features.emergencyStop.actions, pauseDurationHours: value }
                                                    })}
                                                    max={48}
                                                    min={1}
                                                    step={1}
                                                    disabled={!features.emergencyStop.enabled || saving}
                                                />
                                            </div>
                                        </div>

                                        <Separator />

                                        <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                                            <div className="space-y-0.5">
                                                <p className="text-sm font-medium">Resume Trading</p>
                                                <p className="text-xs text-muted-foreground">
                                                    Manually resume if bot is paused due to emergency stop
                                                </p>
                                            </div>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={handleResumeFromPause}
                                                className="gap-1"
                                            >
                                                <Play className="h-4 w-4" />
                                                Resume
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>

                            {/* Order Execution */}
                            <TabsContent value="execution">
                                <Card>
                                    <CardHeader>
                                        <FeatureHeader
                                            icon={Zap}
                                            title="Order Execution"
                                            description="Optimize order placement for better fills and lower fees"
                                            enabled={features.orderExecution.enabled}
                                            onToggle={(enabled) => updateFeature('orderExecution', { enabled })}
                                            disabled={saving}
                                        />
                                    </CardHeader>
                                    <CardContent className="space-y-6">
                                        <div className="flex items-center justify-between">
                                            <div className="space-y-0.5">
                                                <Label className="flex items-center">
                                                    Use Limit Orders
                                                    <InfoTooltip content="Use limit orders instead of market orders for lower fees" />
                                                </Label>
                                                <p className="text-xs text-muted-foreground">
                                                    Lower fees, but may not fill immediately
                                                </p>
                                            </div>
                                            <Switch
                                                checked={features.orderExecution.useLimit}
                                                onCheckedChange={(checked) => updateFeature('orderExecution', { useLimit: checked })}
                                                disabled={!features.orderExecution.enabled || saving}
                                            />
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <Label className="flex items-center">
                                                    Limit Offset
                                                    <InfoTooltip content="Place limit orders this % better than current price" />
                                                </Label>
                                                <span className="text-sm font-medium">{features.orderExecution.limitOffsetPercent}%</span>
                                            </div>
                                            <Slider
                                                value={[features.orderExecution.limitOffsetPercent]}
                                                onValueChange={([value]) => updateFeature('orderExecution', { limitOffsetPercent: value })}
                                                max={1}
                                                min={0.01}
                                                step={0.01}
                                                disabled={!features.orderExecution.enabled || !features.orderExecution.useLimit || saving}
                                            />
                                        </div>

                                        <div className="flex items-center justify-between">
                                            <div className="space-y-0.5">
                                                <Label className="flex items-center">
                                                    Post Only
                                                    <InfoTooltip content="Only place maker orders (lowest fees, but may not fill)" />
                                                </Label>
                                                <p className="text-xs text-muted-foreground">
                                                    Maker orders only - lowest fees
                                                </p>
                                            </div>
                                            <Switch
                                                checked={features.orderExecution.postOnly}
                                                onCheckedChange={(checked) => updateFeature('orderExecution', { postOnly: checked })}
                                                disabled={!features.orderExecution.enabled || !features.orderExecution.useLimit || saving}
                                            />
                                        </div>
                                    </CardContent>
                                </Card>
                            </TabsContent>
                        </Tabs>
                    </main>
                </div>

                {/* Reset Dialog */}
                <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Reset Configuration?</AlertDialogTitle>
                            <AlertDialogDescription>
                                This will reset all universal features to their default values. 
                                This action cannot be undone.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleReset} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                                Reset to Defaults
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </SidebarInset>
        </SidebarProvider>
    );
}
