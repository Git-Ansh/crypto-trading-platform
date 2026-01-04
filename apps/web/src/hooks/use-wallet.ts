import { useState, useEffect, useCallback } from 'react';
import { auth } from '@/lib/firebase';
import { config } from '@/lib/config';

export interface WalletData {
    balance: number;
    currency: string;
    lastUpdated?: string;
    totalAllocated: number;
    totalCurrentValue: number;
    totalPortfolioValue: number;
    unrealizedPnL: number;
    botAllocations: Record<string, {
        allocatedAmount: number;
        currentValue: number;
        botId: string;
    }>;
    recentTransactions: Array<{
        type: string;
        amount: number;
        timestamp: string;
        description?: string;
    }>;
}

interface UseWalletReturn {
    wallet: WalletData | null;
    loading: boolean;
    error: string | null;
    refetch: () => Promise<void>;
    // Convenience accessors
    balance: number;
    availableBalance: number;
    currency: string;
}

const DEFAULT_WALLET: WalletData = {
    balance: 0,
    currency: 'USD',
    totalAllocated: 0,
    totalCurrentValue: 0,
    totalPortfolioValue: 0,
    unrealizedPnL: 0,
    botAllocations: {},
    recentTransactions: []
};

/**
 * Centralized wallet hook for consistent wallet data access across the app.
 * Fetches wallet data from /api/account/wallet endpoint.
 * 
 * Usage:
 * ```tsx
 * const { balance, availableBalance, loading, refetch } = useWallet();
 * ```
 */
export function useWallet(autoFetch = true): UseWalletReturn {
    const [wallet, setWallet] = useState<WalletData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const getAuthToken = useCallback(async (): Promise<string | null> => {
        try {
            const firebaseUser = auth.currentUser;
            if (firebaseUser) {
                return await firebaseUser.getIdToken();
            }
            return null;
        } catch (err) {
            console.error('Error getting auth token:', err);
            return null;
        }
    }, []);

    const fetchWallet = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const token = await getAuthToken();
            if (!token) {
                setError('Not authenticated');
                setLoading(false);
                return;
            }

            const response = await fetch(`${config.api.baseUrl}/api/account/wallet`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `Failed to fetch wallet: ${response.status}`);
            }

            const data = await response.json();
            
            // API returns { success: true, data: { balance, ... } }
            if (data.success && data.data) {
                setWallet({
                    balance: data.data.balance ?? 0,
                    currency: data.data.currency ?? 'USD',
                    lastUpdated: data.data.lastUpdated,
                    totalAllocated: data.data.totalAllocated ?? 0,
                    totalCurrentValue: data.data.totalCurrentValue ?? 0,
                    totalPortfolioValue: data.data.totalPortfolioValue ?? 0,
                    unrealizedPnL: data.data.unrealizedPnL ?? 0,
                    botAllocations: data.data.botAllocations ?? {},
                    recentTransactions: data.data.recentTransactions ?? []
                });
            } else {
                throw new Error('Invalid wallet response format');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error fetching wallet';
            console.error('Wallet fetch error:', message);
            setError(message);
            // Set default wallet on error so UI doesn't break
            setWallet(DEFAULT_WALLET);
        } finally {
            setLoading(false);
        }
    }, [getAuthToken]);

    useEffect(() => {
        if (autoFetch) {
            fetchWallet();
        }
    }, [autoFetch, fetchWallet]);

    // Compute available balance (wallet balance minus allocated to bots)
    const availableBalance = wallet ? wallet.balance : 0;
    const balance = wallet?.balance ?? 0;
    const currency = wallet?.currency ?? 'USD';

    return {
        wallet,
        loading,
        error,
        refetch: fetchWallet,
        balance,
        availableBalance,
        currency
    };
}

export default useWallet;
