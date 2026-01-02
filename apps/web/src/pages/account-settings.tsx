import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { config } from '@/lib/config';
import { auth } from '@/lib/firebase';
import {
    User,
    Mail,
    Lock,
    Shield,
    Bell,
    Wallet,
    CreditCard,
    Globe,
    Clock,
    Save,
    RefreshCw,
    Plus,
    Minus,
    CheckCircle,
    AlertCircle,
    Eye,
    EyeOff,
    Smartphone,
    Key,
    LogOut,
    Settings,
    PieChart,
    History,
    Crown
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
import { Loading } from "@/components/ui/loading";
import { AppSidebar } from '@/components/app-sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
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
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";

// Types
interface UserProfile {
    id: string;
    username: string;
    email: string;
    displayName: string;
    avatar: string;
    timezone: string;
    preferredCurrency: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    authProvider: string;
    hasPassword: boolean;
    paperWallet: {
        balance: number;
        currency: string;
        lastUpdated: string;
    };
    subscription: {
        plan: string;
        maxBots: number;
        maxWalletSize: number;
        expiresAt: string | null;
    };
    notificationPreferences: {
        emailNotifications: {
            tradeAlerts: boolean;
            dailySummary: boolean;
            botErrors: boolean;
        };
        pushNotifications: boolean;
        notificationFrequency: string;
    };
    createdAt: string;
    lastLogin: string;
}

interface WalletData {
    balance: number;
    currency: string;
    totalAllocated: number;
    totalPortfolioValue: number;
    botAllocations: Record<string, { allocatedAmount: number; currentValue: number; allocatedAt: string }>;
    recentTransactions: Array<{
        type: string;
        amount: number;
        description: string;
        balanceAfter: number;
        timestamp: string;
        botId?: string;
        botName?: string;
    }>;
}

interface Session {
    sessionId: string;
    device: string;
    browser: string;
    ip: string;
    location: string;
    lastActive: string;
    createdAt: string;
}

const TIMEZONES = [
    'UTC',
    'America/New_York',
    'America/Los_Angeles',
    'America/Chicago',
    'America/Denver',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Singapore',
    'Asia/Dubai',
    'Australia/Sydney',
    'Pacific/Auckland',
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'];

export default function AccountSettingsPage() {
    const [searchParams] = useSearchParams();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    
    // Get default tab from URL query param
    const defaultTab = searchParams.get('tab') || 'profile';
    
    // Profile state
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [timezone, setTimezone] = useState('UTC');
    const [preferredCurrency, setPreferredCurrency] = useState('USD');
    
    // Security state
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showCurrentPassword, setShowCurrentPassword] = useState(false);
    const [showNewPassword, setShowNewPassword] = useState(false);
    const [sessions, setSessions] = useState<Session[]>([]);
    
    // Wallet state
    const [wallet, setWallet] = useState<WalletData | null>(null);
    const [walletAmount, setWalletAmount] = useState('');
    const [showWalletDialog, setShowWalletDialog] = useState(false);
    const [walletAction, setWalletAction] = useState<'set' | 'deposit' | 'withdraw'>('set');
    
    // Notification state
    const [notifications, setNotifications] = useState({
        tradeAlerts: true,
        dailySummary: true,
        botErrors: true,
        pushNotifications: false,
        frequency: 'instant',
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

    const fetchProfile = useCallback(async () => {
        try {
            const token = await getAuthToken();
            if (!token) {
                console.error('No auth token available');
                return;
            }

            console.log('Fetching profile from:', `${config.api.baseUrl}/api/account/profile`);
            const response = await fetch(`${config.api.baseUrl}/api/account/profile`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            console.log('Profile response status:', response.status);
            if (response.ok) {
                const data = await response.json();
                console.log('Profile data received:', data);
                setProfile(data.data);
                setDisplayName(data.data.displayName || data.data.username);
                setTimezone(data.data.timezone || 'UTC');
                setPreferredCurrency(data.data.preferredCurrency || 'USD');
                if (data.data.notificationPreferences) {
                    setNotifications({
                        tradeAlerts: data.data.notificationPreferences.emailNotifications?.tradeAlerts ?? true,
                        dailySummary: data.data.notificationPreferences.emailNotifications?.dailySummary ?? true,
                        botErrors: data.data.notificationPreferences.emailNotifications?.botErrors ?? true,
                        pushNotifications: data.data.notificationPreferences.pushNotifications ?? false,
                        frequency: data.data.notificationPreferences.notificationFrequency || 'instant',
                    });
                }
            } else {
                const errorData = await response.json();
                console.error('Failed to fetch profile:', response.status, errorData);
            }
        } catch (error) {
            console.error('Error fetching profile:', error);
        }
    }, []);

    const fetchWallet = useCallback(async () => {
        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.api.baseUrl}/api/account/wallet`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                setWallet(data.data);
            }
        } catch (error) {
            console.error('Error fetching wallet:', error);
        }
    }, []);

    const fetchSessions = useCallback(async () => {
        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.api.baseUrl}/api/account/sessions`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                setSessions(data.data || []);
            }
        } catch (error) {
            console.error('Error fetching sessions:', error);
        }
    }, []);

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            await Promise.all([fetchProfile(), fetchWallet(), fetchSessions()]);
            setLoading(false);
        };
        loadData();
    }, [fetchProfile, fetchWallet, fetchSessions]);

    const handleSaveProfile = async () => {
        setSaving(true);
        setError(null);
        try {
            const token = await getAuthToken();
            if (!token) throw new Error('Not authenticated');

            const response = await fetch(`${config.api.baseUrl}/api/account/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    displayName,
                    timezone,
                    preferredCurrency,
                }),
            });

            const data = await response.json();
            if (response.ok) {
                setSuccess('Profile updated successfully');
                await fetchProfile();
            } else {
                setError(data.message || 'Failed to update profile');
            }
        } catch (error: any) {
            setError(error.message || 'Failed to update profile');
        } finally {
            setSaving(false);
        }
    };

    const handleChangePassword = async () => {
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }
        if (newPassword.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const token = await getAuthToken();
            if (!token) throw new Error('Not authenticated');

            const response = await fetch(`${config.api.baseUrl}/api/account/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    currentPassword: profile?.authProvider === 'local' ? currentPassword : undefined,
                    newPassword,
                }),
            });

            const data = await response.json();
            if (response.ok) {
                setSuccess(data.message || 'Password changed successfully');
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
            } else {
                setError(data.message || 'Failed to change password');
            }
        } catch (error: any) {
            setError(error.message || 'Failed to change password');
        } finally {
            setSaving(false);
        }
    };

    const handleWalletAction = async () => {
        const amount = parseFloat(walletAmount);
        if (isNaN(amount) || amount <= 0) {
            setError('Please enter a valid amount');
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const token = await getAuthToken();
            if (!token) throw new Error('Not authenticated');

            let endpoint = '';
            let body: any = {};

            switch (walletAction) {
                case 'set':
                    endpoint = '/api/account/wallet/set-balance';
                    body = { amount };
                    break;
                case 'deposit':
                    endpoint = '/api/account/wallet/deposit';
                    body = { amount, description: 'Manual deposit' };
                    break;
                case 'withdraw':
                    endpoint = '/api/account/wallet/withdraw';
                    body = { amount, description: 'Manual withdrawal' };
                    break;
            }

            const response = await fetch(`${config.api.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
            });

            const data = await response.json();
            if (response.ok) {
                setSuccess(data.message || 'Wallet updated successfully');
                setWalletAmount('');
                setShowWalletDialog(false);
                await fetchWallet();
            } else {
                setError(data.message || 'Failed to update wallet');
            }
        } catch (error: any) {
            setError(error.message || 'Failed to update wallet');
        } finally {
            setSaving(false);
        }
    };

    const handleRevokeSession = async (sessionId: string) => {
        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.api.baseUrl}/api/account/sessions/${sessionId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });

            if (response.ok) {
                setSuccess('Session revoked successfully');
                await fetchSessions();
            }
        } catch (error: any) {
            setError(error.message || 'Failed to revoke session');
        }
    };

    const handleSendVerificationEmail = async () => {
        try {
            const token = await getAuthToken();
            if (!token) return;

            const response = await fetch(`${config.api.baseUrl}/api/account/send-verification-email`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });

            const data = await response.json();
            if (response.ok) {
                setSuccess('Verification email sent! Please check your inbox.');
            } else {
                setError(data.message || 'Failed to send verification email');
            }
        } catch (error: any) {
            setError(error.message || 'Failed to send verification email');
        }
    };

    const handleSaveNotifications = async () => {
        setSaving(true);
        try {
            const token = await getAuthToken();
            if (!token) throw new Error('Not authenticated');

            const response = await fetch(`${config.api.baseUrl}/api/account/notifications`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    emailNotifications: {
                        tradeAlerts: notifications.tradeAlerts,
                        dailySummary: notifications.dailySummary,
                        botErrors: notifications.botErrors,
                    },
                    pushNotifications: notifications.pushNotifications,
                    notificationFrequency: notifications.frequency,
                }),
            });

            if (response.ok) {
                setSuccess('Notification preferences saved');
            }
        } catch (error: any) {
            setError(error.message);
        } finally {
            setSaving(false);
        }
    };

    const formatCurrency = (amount: number, currency: string = 'USD') => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
        }).format(amount);
    };

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    if (loading) {
        return <Loading message="Loading account settings..." />;
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
                            <Badge variant="outline" className="ml-2">Account Settings</Badge>
                        </div>
                        <div className="ml-auto flex items-center gap-4">
                            <ModeToggle />
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
                    <main className="flex-1 p-6 w-full">
                        <Tabs defaultValue={defaultTab} className="w-full">
                            <TabsList className="grid w-full max-w-2xl grid-cols-5 mb-6">
                                <TabsTrigger value="profile" className="gap-1">
                                    <User className="h-4 w-4" />
                                    <span className="hidden sm:inline">Profile</span>
                                </TabsTrigger>
                                <TabsTrigger value="security" className="gap-1">
                                    <Shield className="h-4 w-4" />
                                    <span className="hidden sm:inline">Security</span>
                                </TabsTrigger>
                                <TabsTrigger value="wallet" className="gap-1">
                                    <Wallet className="h-4 w-4" />
                                    <span className="hidden sm:inline">Wallet</span>
                                </TabsTrigger>
                                <TabsTrigger value="notifications" className="gap-1">
                                    <Bell className="h-4 w-4" />
                                    <span className="hidden sm:inline">Alerts</span>
                                </TabsTrigger>
                                <TabsTrigger value="subscription" className="gap-1">
                                    <Crown className="h-4 w-4" />
                                    <span className="hidden sm:inline">Plan</span>
                                </TabsTrigger>
                            </TabsList>

                            {/* Profile Tab */}
                            <TabsContent value="profile">
                                <div className="grid gap-6 max-w-2xl">
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <User className="h-5 w-5" />
                                                Profile Information
                                            </CardTitle>
                                            <CardDescription>
                                                Manage your account details and preferences
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-6">
                                            {/* Avatar */}
                                            <div className="flex items-center gap-4">
                                                <Avatar className="h-20 w-20">
                                                    <AvatarImage src={profile?.avatar} alt={profile?.displayName} />
                                                    <AvatarFallback className="text-lg">
                                                        {(profile?.displayName || profile?.username || 'U').substring(0, 2).toUpperCase()}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <div>
                                                    <h3 className="font-medium">{profile?.displayName || profile?.username}</h3>
                                                    <p className="text-sm text-muted-foreground">{profile?.email}</p>
                                                    {profile?.authProvider && profile.authProvider !== 'local' && (
                                                        <Badge variant="secondary" className="mt-1">
                                                            {profile.authProvider.charAt(0).toUpperCase() + profile.authProvider.slice(1)} Login
                                                        </Badge>
                                                    )}
                                                </div>
                                            </div>

                                            <Separator />

                                            {/* Display Name */}
                                            <div className="space-y-2">
                                                <Label htmlFor="displayName">Display Name</Label>
                                                <Input
                                                    id="displayName"
                                                    value={displayName}
                                                    onChange={(e) => setDisplayName(e.target.value)}
                                                    placeholder="Your display name"
                                                />
                                            </div>

                                            {/* Email */}
                                            <div className="space-y-2">
                                                <Label htmlFor="email">Email</Label>
                                                <div className="flex items-center gap-2">
                                                    <Input
                                                        id="email"
                                                        value={profile?.email || ''}
                                                        disabled
                                                        className="bg-muted"
                                                    />
                                                    {profile?.emailVerified ? (
                                                        <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                                                            <CheckCircle className="h-3 w-3 mr-1" />
                                                            Verified
                                                        </Badge>
                                                    ) : (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={handleSendVerificationEmail}
                                                        >
                                                            <Mail className="h-4 w-4 mr-1" />
                                                            Verify
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Timezone */}
                                            <div className="space-y-2">
                                                <Label>Timezone</Label>
                                                <Select value={timezone} onValueChange={setTimezone}>
                                                    <SelectTrigger>
                                                        <Clock className="h-4 w-4 mr-2" />
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {TIMEZONES.map((tz) => (
                                                            <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            {/* Preferred Currency */}
                                            <div className="space-y-2">
                                                <Label>Preferred Currency</Label>
                                                <Select value={preferredCurrency} onValueChange={setPreferredCurrency}>
                                                    <SelectTrigger>
                                                        <Globe className="h-4 w-4 mr-2" />
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {CURRENCIES.map((curr) => (
                                                            <SelectItem key={curr} value={curr}>{curr}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </CardContent>
                                        <CardFooter>
                                            <Button onClick={handleSaveProfile} disabled={saving}>
                                                {saving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                                                Save Changes
                                            </Button>
                                        </CardFooter>
                                    </Card>
                                </div>
                            </TabsContent>

                            {/* Security Tab */}
                            <TabsContent value="security">
                                <div className="grid gap-6 max-w-2xl">
                                    {/* Change Password */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Lock className="h-5 w-5" />
                                                {profile?.hasPassword ? 'Change Password' : 'Set Password'}
                                            </CardTitle>
                                            <CardDescription>
                                                {profile?.authProvider !== 'local'
                                                    ? 'Set a password to enable email/password login alongside your social login'
                                                    : 'Update your account password'}
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-4">
                                            {profile?.authProvider === 'local' && (
                                                <div className="space-y-2">
                                                    <Label htmlFor="currentPassword">Current Password</Label>
                                                    <div className="relative">
                                                        <Input
                                                            id="currentPassword"
                                                            type={showCurrentPassword ? 'text' : 'password'}
                                                            value={currentPassword}
                                                            onChange={(e) => setCurrentPassword(e.target.value)}
                                                            placeholder="Enter current password"
                                                        />
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            className="absolute right-0 top-0 h-full px-3"
                                                            onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                                                        >
                                                            {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}
                                            <div className="space-y-2">
                                                <Label htmlFor="newPassword">New Password</Label>
                                                <div className="relative">
                                                    <Input
                                                        id="newPassword"
                                                        type={showNewPassword ? 'text' : 'password'}
                                                        value={newPassword}
                                                        onChange={(e) => setNewPassword(e.target.value)}
                                                        placeholder="Enter new password"
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="absolute right-0 top-0 h-full px-3"
                                                        onClick={() => setShowNewPassword(!showNewPassword)}
                                                    >
                                                        {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="space-y-2">
                                                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                                                <Input
                                                    id="confirmPassword"
                                                    type="password"
                                                    value={confirmPassword}
                                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                                    placeholder="Confirm new password"
                                                />
                                            </div>
                                        </CardContent>
                                        <CardFooter>
                                            <Button onClick={handleChangePassword} disabled={saving || !newPassword}>
                                                {saving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
                                                {profile?.hasPassword ? 'Change Password' : 'Set Password'}
                                            </Button>
                                        </CardFooter>
                                    </Card>

                                    {/* Two-Factor Authentication (Placeholder) */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Smartphone className="h-5 w-5" />
                                                Two-Factor Authentication
                                                <Badge variant="outline" className="ml-2">Coming Soon</Badge>
                                            </CardTitle>
                                            <CardDescription>
                                                Add an extra layer of security to your account
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent>
                                            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
                                                <div>
                                                    <p className="font-medium">Authenticator App</p>
                                                    <p className="text-sm text-muted-foreground">Use an app like Google Authenticator</p>
                                                </div>
                                                <Switch disabled checked={profile?.twoFactorEnabled} />
                                            </div>
                                        </CardContent>
                                    </Card>

                                    {/* Active Sessions */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Key className="h-5 w-5" />
                                                Active Sessions
                                            </CardTitle>
                                            <CardDescription>
                                                Manage your active login sessions
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent>
                                            {sessions.length === 0 ? (
                                                <p className="text-sm text-muted-foreground">No active sessions recorded</p>
                                            ) : (
                                                <div className="space-y-3">
                                                    {sessions.map((session) => (
                                                        <div key={session.sessionId} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                                                            <div>
                                                                <p className="font-medium">{session.device}</p>
                                                                <p className="text-xs text-muted-foreground">
                                                                    {session.browser} • {session.location} • Last active: {formatDate(session.lastActive)}
                                                                </p>
                                                            </div>
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                onClick={() => handleRevokeSession(session.sessionId)}
                                                            >
                                                                <LogOut className="h-4 w-4" />
                                                            </Button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>

                                    {/* API Keys (Placeholder) */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Key className="h-5 w-5" />
                                                API Keys
                                                <Badge variant="outline" className="ml-2">Coming Soon</Badge>
                                            </CardTitle>
                                            <CardDescription>
                                                Connect real exchange accounts for live trading
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent>
                                            <div className="flex items-center justify-center p-8 border border-dashed rounded-lg">
                                                <div className="text-center">
                                                    <Key className="h-12 w-12 mx-auto text-muted-foreground/50" />
                                                    <p className="mt-2 text-sm text-muted-foreground">
                                                        Exchange API key management coming soon
                                                    </p>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>
                            </TabsContent>

                            {/* Wallet Tab */}
                            <TabsContent value="wallet">
                                <div className="grid gap-6 max-w-4xl">
                                    {/* Wallet Overview */}
                                    <div className="grid gap-4 md:grid-cols-3">
                                        <Card>
                                            <CardHeader className="pb-2">
                                                <CardDescription>Available Balance</CardDescription>
                                            </CardHeader>
                                            <CardContent>
                                                <div className="text-2xl font-bold text-emerald-500">
                                                    {formatCurrency(wallet?.balance || 1000, wallet?.currency)}
                                                </div>
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardHeader className="pb-2">
                                                <CardDescription>Allocated to Bots</CardDescription>
                                            </CardHeader>
                                            <CardContent>
                                                <div className="text-2xl font-bold">
                                                    {formatCurrency(wallet?.totalAllocated || 0, wallet?.currency)}
                                                </div>
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardHeader className="pb-2">
                                                <CardDescription>Total Portfolio Value</CardDescription>
                                            </CardHeader>
                                            <CardContent>
                                                <div className="text-2xl font-bold text-primary">
                                                    {formatCurrency(wallet?.totalPortfolioValue || 1000, wallet?.currency)}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </div>

                                    {/* Wallet Actions */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Wallet className="h-5 w-5" />
                                                Paper Trading Wallet
                                            </CardTitle>
                                            <CardDescription>
                                                Manage your paper trading funds. Default balance is $1,000.
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-4">
                                            <div className="flex flex-wrap gap-3">
                                                <Button
                                                    variant="outline"
                                                    onClick={() => {
                                                        setWalletAction('set');
                                                        setWalletAmount('');
                                                        setShowWalletDialog(true);
                                                    }}
                                                >
                                                    <Settings className="h-4 w-4 mr-2" />
                                                    Set Balance
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    onClick={() => {
                                                        setWalletAction('deposit');
                                                        setWalletAmount('');
                                                        setShowWalletDialog(true);
                                                    }}
                                                >
                                                    <Plus className="h-4 w-4 mr-2" />
                                                    Add Funds
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    onClick={() => {
                                                        setWalletAction('withdraw');
                                                        setWalletAmount('');
                                                        setShowWalletDialog(true);
                                                    }}
                                                >
                                                    <Minus className="h-4 w-4 mr-2" />
                                                    Remove Funds
                                                </Button>
                                            </div>

                                            {/* Bot Allocations */}
                                            {wallet?.botAllocations && Object.keys(wallet.botAllocations).length > 0 && (
                                                <>
                                                    <Separator />
                                                    <div>
                                                        <h4 className="font-medium mb-3 flex items-center gap-2">
                                                            <PieChart className="h-4 w-4" />
                                                            Bot Allocations
                                                        </h4>
                                                        <div className="space-y-2">
                                                            {Object.entries(wallet.botAllocations).map(([botId, allocation]) => (
                                                                <div key={botId} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                                                                    <span className="font-medium">{botId}</span>
                                                                    <span>{formatCurrency(allocation.allocatedAmount, wallet.currency)}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </>
                                            )}
                                        </CardContent>
                                    </Card>

                                    {/* Transaction History */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <History className="h-5 w-5" />
                                                Transaction History
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent>
                                            {wallet?.recentTransactions && wallet.recentTransactions.length > 0 ? (
                                                <Table>
                                                    <TableHeader>
                                                        <TableRow>
                                                            <TableHead>Type</TableHead>
                                                            <TableHead>Amount</TableHead>
                                                            <TableHead>Description</TableHead>
                                                            <TableHead>Balance After</TableHead>
                                                            <TableHead>Date</TableHead>
                                                        </TableRow>
                                                    </TableHeader>
                                                    <TableBody>
                                                        {wallet.recentTransactions.map((tx, idx) => (
                                                            <TableRow key={idx}>
                                                                <TableCell>
                                                                    <Badge variant={tx.type === 'deposit' || tx.type === 'profit' ? 'default' : 'secondary'}>
                                                                        {tx.type}
                                                                    </Badge>
                                                                </TableCell>
                                                                <TableCell className={tx.type === 'withdraw' || tx.type === 'loss' || tx.type === 'allocate' ? 'text-red-500' : 'text-emerald-500'}>
                                                                    {tx.type === 'withdraw' || tx.type === 'loss' || tx.type === 'allocate' ? '-' : '+'}
                                                                    {formatCurrency(tx.amount, wallet.currency)}
                                                                </TableCell>
                                                                <TableCell className="max-w-[200px] truncate">{tx.description}</TableCell>
                                                                <TableCell>{formatCurrency(tx.balanceAfter, wallet.currency)}</TableCell>
                                                                <TableCell className="text-muted-foreground">{formatDate(tx.timestamp)}</TableCell>
                                                            </TableRow>
                                                        ))}
                                                    </TableBody>
                                                </Table>
                                            ) : (
                                                <div className="text-center py-8 text-muted-foreground">
                                                    <History className="h-12 w-12 mx-auto mb-2 opacity-50" />
                                                    <p>No transactions yet</p>
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>

                                    {/* Real Currency Placeholder */}
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <CreditCard className="h-5 w-5" />
                                                Digital Wallet
                                                <Badge variant="outline" className="ml-2">Coming Soon</Badge>
                                            </CardTitle>
                                            <CardDescription>
                                                Connect real funds for live trading
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent>
                                            <div className="flex items-center justify-center p-8 border border-dashed rounded-lg">
                                                <div className="text-center">
                                                    <CreditCard className="h-12 w-12 mx-auto text-muted-foreground/50" />
                                                    <p className="mt-2 text-sm text-muted-foreground">
                                                        Real currency deposits and withdrawals coming soon
                                                    </p>
                                                </div>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>
                            </TabsContent>

                            {/* Notifications Tab */}
                            <TabsContent value="notifications">
                                <div className="grid gap-6 max-w-2xl">
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Bell className="h-5 w-5" />
                                                Notification Preferences
                                                <Badge variant="outline" className="ml-2">Placeholder</Badge>
                                            </CardTitle>
                                            <CardDescription>
                                                Configure how you receive alerts and updates
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-6">
                                            <div>
                                                <h4 className="font-medium mb-4">Email Notifications</h4>
                                                <div className="space-y-4">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <Label>Trade Alerts</Label>
                                                            <p className="text-xs text-muted-foreground">Get notified when trades are executed</p>
                                                        </div>
                                                        <Switch
                                                            checked={notifications.tradeAlerts}
                                                            onCheckedChange={(checked) => setNotifications({ ...notifications, tradeAlerts: checked })}
                                                        />
                                                    </div>
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <Label>Daily Summary</Label>
                                                            <p className="text-xs text-muted-foreground">Receive a daily performance summary</p>
                                                        </div>
                                                        <Switch
                                                            checked={notifications.dailySummary}
                                                            onCheckedChange={(checked) => setNotifications({ ...notifications, dailySummary: checked })}
                                                        />
                                                    </div>
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <Label>Bot Errors</Label>
                                                            <p className="text-xs text-muted-foreground">Get alerted when a bot encounters an error</p>
                                                        </div>
                                                        <Switch
                                                            checked={notifications.botErrors}
                                                            onCheckedChange={(checked) => setNotifications({ ...notifications, botErrors: checked })}
                                                        />
                                                    </div>
                                                </div>
                                            </div>

                                            <Separator />

                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <Label>Push Notifications</Label>
                                                    <p className="text-xs text-muted-foreground">Receive push notifications in your browser</p>
                                                </div>
                                                <Switch
                                                    checked={notifications.pushNotifications}
                                                    onCheckedChange={(checked) => setNotifications({ ...notifications, pushNotifications: checked })}
                                                />
                                            </div>

                                            <Separator />

                                            <div className="space-y-2">
                                                <Label>Notification Frequency</Label>
                                                <Select
                                                    value={notifications.frequency}
                                                    onValueChange={(value) => setNotifications({ ...notifications, frequency: value })}
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="instant">Instant</SelectItem>
                                                        <SelectItem value="hourly">Hourly Digest</SelectItem>
                                                        <SelectItem value="daily">Daily Digest</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </CardContent>
                                        <CardFooter>
                                            <Button onClick={handleSaveNotifications} disabled={saving}>
                                                {saving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                                                Save Preferences
                                            </Button>
                                        </CardFooter>
                                    </Card>
                                </div>
                            </TabsContent>

                            {/* Subscription Tab */}
                            <TabsContent value="subscription">
                                <div className="grid gap-6 max-w-3xl">
                                    <Card>
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2">
                                                <Crown className="h-5 w-5" />
                                                Current Plan
                                                <Badge variant="outline" className="ml-2">Placeholder</Badge>
                                            </CardTitle>
                                            <CardDescription>
                                                Manage your subscription and usage limits
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-6">
                                            <div className="p-6 rounded-lg border-2 border-primary bg-primary/5">
                                                <div className="flex items-center justify-between mb-4">
                                                    <div>
                                                        <h3 className="text-xl font-bold capitalize">{profile?.subscription?.plan || 'Free'} Plan</h3>
                                                        <p className="text-sm text-muted-foreground">Your current subscription</p>
                                                    </div>
                                                    <Badge className="text-lg px-4 py-1">Active</Badge>
                                                </div>
                                                <div className="grid grid-cols-2 gap-4 mt-4">
                                                    <div>
                                                        <p className="text-sm text-muted-foreground">Max Bots</p>
                                                        <p className="text-lg font-medium">{profile?.subscription?.maxBots || 3}</p>
                                                    </div>
                                                    <div>
                                                        <p className="text-sm text-muted-foreground">Max Wallet Size</p>
                                                        <p className="text-lg font-medium">{formatCurrency(profile?.subscription?.maxWalletSize || 100000)}</p>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="grid gap-4 md:grid-cols-2">
                                                <Card className="border-2 hover:border-primary/50 transition-colors cursor-pointer">
                                                    <CardHeader>
                                                        <CardTitle>Pro Plan</CardTitle>
                                                        <CardDescription>$19/month</CardDescription>
                                                    </CardHeader>
                                                    <CardContent>
                                                        <ul className="space-y-2 text-sm">
                                                            <li className="flex items-center gap-2">
                                                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                                                                10 Trading Bots
                                                            </li>
                                                            <li className="flex items-center gap-2">
                                                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                                                                $500,000 Wallet Size
                                                            </li>
                                                            <li className="flex items-center gap-2">
                                                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                                                                Priority Support
                                                            </li>
                                                        </ul>
                                                    </CardContent>
                                                    <CardFooter>
                                                        <Button className="w-full" disabled>Coming Soon</Button>
                                                    </CardFooter>
                                                </Card>

                                                <Card className="border-2 hover:border-primary/50 transition-colors cursor-pointer">
                                                    <CardHeader>
                                                        <CardTitle>Enterprise Plan</CardTitle>
                                                        <CardDescription>Contact Sales</CardDescription>
                                                    </CardHeader>
                                                    <CardContent>
                                                        <ul className="space-y-2 text-sm">
                                                            <li className="flex items-center gap-2">
                                                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                                                                Unlimited Bots
                                                            </li>
                                                            <li className="flex items-center gap-2">
                                                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                                                                Unlimited Wallet
                                                            </li>
                                                            <li className="flex items-center gap-2">
                                                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                                                                Dedicated Support
                                                            </li>
                                                        </ul>
                                                    </CardContent>
                                                    <CardFooter>
                                                        <Button className="w-full" variant="outline" disabled>Contact Sales</Button>
                                                    </CardFooter>
                                                </Card>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>
                            </TabsContent>
                        </Tabs>
                    </main>

                    {/* Wallet Dialog */}
                    <AlertDialog open={showWalletDialog} onOpenChange={setShowWalletDialog}>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    {walletAction === 'set' && 'Set Wallet Balance'}
                                    {walletAction === 'deposit' && 'Add Paper Funds'}
                                    {walletAction === 'withdraw' && 'Remove Paper Funds'}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                    {walletAction === 'set' && 'Enter the new total balance for your paper trading wallet.'}
                                    {walletAction === 'deposit' && 'Enter the amount to add to your paper trading wallet.'}
                                    {walletAction === 'withdraw' && 'Enter the amount to remove from your paper trading wallet.'}
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <div className="py-4">
                                <Label htmlFor="walletAmount">Amount ({wallet?.currency || 'USD'})</Label>
                                <Input
                                    id="walletAmount"
                                    type="number"
                                    value={walletAmount}
                                    onChange={(e) => setWalletAmount(e.target.value)}
                                    placeholder="Enter amount"
                                    min="0"
                                    step="0.01"
                                    className="mt-2"
                                />
                                {walletAction === 'set' && (
                                    <p className="text-xs text-muted-foreground mt-2">
                                        Current balance: {formatCurrency(wallet?.balance || 0, wallet?.currency)}
                                    </p>
                                )}
                            </div>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={handleWalletAction} disabled={saving}>
                                    {saving ? 'Processing...' : 'Confirm'}
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
}
