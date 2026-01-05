"use client";
import {
  ChevronDown,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Settings,
  Search,
  ChevronLeft,
  ChevronRight,
  Bot,
  Plus,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useState, useEffect, useRef, useCallback, memo, useMemo, lazy, Suspense } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { isAuthenticated } from "@/lib/api";
import axios from "axios";
import "./dashboard.css"; // Extracted CSS for performance
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFreqTradeSSE } from "@/hooks/use-freqtrade-sse";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarProvider,
  SidebarInset,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
// Lazy load heavy chart components
const PortfolioChart = lazy(() => import("@/components/portfolio-chart").then(m => ({ default: m.PortfolioChart })));
import { InlineLoading, LoadingSpinner } from "@/components/ui/loading";
import { useIsMobile } from "@/hooks/use-mobile";
// Lazy load heavy table and selector components
const PositionsTable = lazy(() => import("@/components/positions-table").then(m => ({ default: m.PositionsTable })));
const StrategySelector = lazy(() => import("@/components/strategy-selector").then(m => ({ default: m.StrategySelector })));
import { config } from "@/lib/config";
import { auth } from "@/lib/firebase";

// ================== CONFIG ENDPOINTS ==================
// Replace the Coindesk/CC endpoints with Binance endpoints
const HISTORICAL_ENDPOINT = "https://api.binance.com/api/v3/klines"; // for OHLCV data (e.g. 1h candles)
const MINUTE_DATA_ENDPOINT = "https://api.binance.com/api/v3/klines"; // for 1m candles

const WS_ENDPOINT = "wss://stream.binance.com:9443/ws";
const COIN_GECKO_ENDPOINT =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=120&page=1&sparkline=false";

// Bot Manager API handled by SSE service

// Define the symbols you want to track – note these are in the Binance pair format.
const TOP_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "XRPUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "SOLUSDT",
  "DOGEUSDT",
  "DOTUSDT",
  "AVAXUSDT",
  "MATICUSDT",
  "LINKUSDT",
  "SHIBUSDT",
];

const BATCH_THRESHOLD = 5;
const BATCH_WINDOW = 2000;
const MAX_CHART_POINTS = 300;
const MAX_CURRENCIES = 50; // Reduced from 120 for faster initial render
const HOUR_IN_MS = 60 * 60 * 1000;
const MARKET_DATA_DEFER_MS = 100; // Reduced from 600ms



interface CryptoInfo {
  price: number;
  change24h?: number;
}

interface KlineData {
  time: string;
  close: number;
  timestamp: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  isMinuteData?: boolean;
}



interface CurrencyData {
  symbol: string;
  name: string;
  price: number;
  volume: number;
  marketCap: number;
  change24h: number;
  lastUpdated: number;
}

type InitStep = "market" | "portfolio" | "bots" | "chart";
const REQUIRED_INIT_STEPS: InitStep[] = ["market", "portfolio", "bots", "chart"];











export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const isMobile = useIsMobile();

  const [cryptoData, setCryptoData] = useState<CryptoInfo | null>(null);
  const [chartData, setChartData] = useState<KlineData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "disconnected" | "connecting"
  >("disconnected");
  const [lastUpdated, setLastUpdated] = useState<string>("");

  // Separate state for each timeframe to prevent cross-contamination and race conditions
  const [portfolioDataByTimeframe, setPortfolioDataByTimeframe] = useState<{
    "1H": any[];
    "24H": any[];
    "7D": any[];
    "30D": any[];
  }>({
    "1H": [],
    "24H": [],
    "7D": [],
    "30D": [],
  });
  const [portfolioDateRange, setPortfolioDateRange] = useState<
    "1H" | "24H" | "7D" | "30D"
  >("24H");
  const [portfolioChartLoading, setPortfolioChartLoading] =
    useState<boolean>(false);
  
  // Bot action loading state - tracks which bot is being started/stopped
  const [botActionLoading, setBotActionLoading] = useState<{ [botId: string]: 'start' | 'stop' | null }>({});

  // Refs for batching updates
  const messageCountRef = useRef<number>(0);
  const batchTimerRef = useRef<number | null>(null);
  const priceBufferRef = useRef<number | null>(null);
  const changeBufferRef = useRef<number | null>(null);
  const lastChartUpdateRef = useRef<number>(Date.now());

  // WebSocket ref for Binance connection (market data)
  const wsRef = useRef<WebSocket | null>(null);

  // Ref for latest prices for all currencies (to batch table updates)
  const latestPricesRef = useRef<
    Record<string, { price: number; change24h?: number; lastUpdated: number }>
  >({});

  // FreqTrade SSE Integration
  const {
    isConnected: freqTradeConnected,
    connectionError: freqTradeError,
    portfolioData: freqTradePortfolio,
    portfolioLoading: freqTradePortfolioLoading,
    bots: freqTradeBots,
    botsLoading: freqTradeBotsLoading,
    chartData: freqTradeChartData,
    chartLoading: freqTradeChartLoading,
    trades: freqTradeTrades,
    tradesLoading,
    refreshData: refreshFreqTradeData,
    fetchChartData: fetchFreqTradeChartData,
  } = useFreqTradeSSE();

  // Helper variable for FreqTrade UI conditional rendering
  const isFreqTradeAvailable =
    freqTradeConnected || freqTradePortfolio !== null;

  // Debug logging for portfolio data (reduced)
  if (freqTradePortfolio && freqTradePortfolio.portfolioValue > 0) {
  }

  // Note: Live trading positions now displayed directly from freqTradeBots array
  // This provides real-time bot status, balance, and P&L data similar to streaming client

  // Bot control functions with loading state
  const startBot = useCallback(async (botId: string) => {
    try {
      setBotActionLoading(prev => ({ ...prev, [botId]: 'start' }));
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        console.error('No auth token available');
        return;
      }
      
      const response = await fetch(`${config.botManager.baseUrl}/api/bots/${botId}/start`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        // Refresh bot data after action
        await refreshFreqTradeData();
      } else {
        const data = await response.json();
        console.error('Failed to start bot:', data.message);
      }
    } catch (error) {
      console.error('Error starting bot:', error);
    } finally {
      setBotActionLoading(prev => ({ ...prev, [botId]: null }));
    }
  }, [refreshFreqTradeData]);

  const stopBot = useCallback(async (botId: string) => {
    try {
      setBotActionLoading(prev => ({ ...prev, [botId]: 'stop' }));
      const token = await auth.currentUser?.getIdToken();
      if (!token) {
        console.error('No auth token available');
        return;
      }
      
      const response = await fetch(`${config.botManager.baseUrl}/api/bots/${botId}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        // Refresh bot data after action
        await refreshFreqTradeData();
      } else {
        const data = await response.json();
        console.error('Failed to stop bot:', data.message);
      }
    } catch (error) {
      console.error('Error stopping bot:', error);
    } finally {
      setBotActionLoading(prev => ({ ...prev, [botId]: null }));
    }
  }, [refreshFreqTradeData]);

  // Helper function to safely update portfolio data for a specific timeframe
  const updatePortfolioDataForTimeframe = useCallback(
    (timeframe: "1H" | "24H" | "7D" | "30D", data: any[]) => {
      setPortfolioDataByTimeframe((prev) => ({
        ...prev,
        [timeframe]: data,
      }));
    },
    []
  );

  // Helper function to get data for current timeframe
  const getCurrentTimeframeData = useCallback(() => {
    const data = portfolioDataByTimeframe[portfolioDateRange] || [];
    return data;
  }, [
    portfolioDataByTimeframe,
    portfolioDateRange,
    freqTradeConnected,
    freqTradePortfolio,
  ]);

  // Create emergency fallback chart data if needed
  const getChartDataWithFallback = useCallback(() => {
    const data = getCurrentTimeframeData();

    // If we have chart data with non-zero values, return it
    const hasNonZeroData = data.some(p => (p.portfolioValue > 0 || p.total > 0));

    if (data.length > 0 && hasNonZeroData) {
      return data;
    }

    // If we have portfolio data but no chart data, create a minimal chart point
    if (
      freqTradeConnected &&
      freqTradePortfolio &&
      freqTradePortfolio.portfolioValue > 0
    ) {
      const fallbackPoint = {
        timestamp: new Date(freqTradePortfolio.timestamp),
        date: new Date(freqTradePortfolio.timestamp),
        portfolioValue: freqTradePortfolio.portfolioValue,
        totalPnL: freqTradePortfolio.totalPnL,
        totalValue: freqTradePortfolio.portfolioValue,
        value: freqTradePortfolio.portfolioValue,
        paperBalance: freqTradePortfolio.totalPnL,
        total: freqTradePortfolio.portfolioValue,
        pnlPercentage: freqTradePortfolio.pnlPercentage || 0,
        _emergencyFallback: true,
      };

      return [fallbackPoint];
    }

    return [];
  }, [getCurrentTimeframeData, freqTradeConnected, freqTradePortfolio]);

  // Determine if user is new based on portfolio data availability
  const isNewUser = useMemo(() => 
    !freqTradeConnected ||
    !freqTradePortfolio ||
    getChartDataWithFallback().length === 0,
    [freqTradeConnected, freqTradePortfolio, getChartDataWithFallback]
  );

  // Check if user has no FreqTrade bots provisioned
  const hasNoBots = useMemo(() => 
    !freqTradeBotsLoading && freqTradeBots.length === 0,
    [freqTradeBotsLoading, freqTradeBots.length]
  );

  // Memoize portfolio display values to avoid recalculations on every render
  const portfolioDisplayData = useMemo(() => ({
    totalBalance: freqTradePortfolio?.totalBalance || 0,
    botCount: freqTradePortfolio?.bots?.length || 0,
    portfolioValue: freqTradePortfolio?.portfolioValue || 0,
    totalPnL: freqTradePortfolio?.totalPnL || 0,
    pnlPercentage: freqTradePortfolio?.pnlPercentage || 0,
  }), [freqTradePortfolio]);

  // Use a ref for the currently selected currency so that the WS handler always sees the latest value
  const selectedCurrencyRef = useRef<string>("BTC");

  // Ref to track the current portfolio timeframe request to prevent race conditions
  const currentTimeframeRequestRef = useRef<string | null>(null);

  // Ref to track chart data without causing callback recreation (prevents infinite loops)
  const freqTradeChartDataRef = useRef(freqTradeChartData);
  freqTradeChartDataRef.current = freqTradeChartData;

  // Chart now gets data directly from getCurrentTimeframeData() - no need for syncing useEffect

  // Zoom/Pan states
  const [zoomState, setZoomState] = useState<{
    xDomain?: [number, number];
    yDomain?: [number, number];
    isZoomed: boolean;
  }>({ xDomain: undefined, yDomain: undefined, isZoomed: false });

  const [touchState, setTouchState] = useState<{
    initialDistance: number;
    initialDomains: {
      x: [number, number];
      y: [number, number];
      centerX: number;
      centerY: number;
    };
  }>({
    initialDistance: 0,
    initialDomains: { x: [0, 0], y: [0, 0], centerX: 0, centerY: 0 },
  });

  const [panState, setPanState] = useState<{
    isPanning: boolean;
    lastMouseX: number;
    lastMouseY: number;
  }>({ isPanning: false, lastMouseX: 0, lastMouseY: 0 });

  // Memoize expensive chart bounds calculation - used by multiple handlers
  const chartBounds = useMemo(() => {
    if (chartData.length === 0) return { minClose: 0, maxClose: 0, fullXDomain: [0, 0] as [number, number], fullYDomain: [0, 0] as [number, number] };
    const closes = chartData.map((d) => d.close);
    const minClose = Math.min(...closes);
    const maxClose = Math.max(...closes);
    return {
      minClose,
      maxClose,
      fullXDomain: [0, chartData.length - 1] as [number, number],
      fullYDomain: [minClose * 0.99, maxClose * 1.01] as [number, number],
    };
  }, [chartData]);

  // Ref for RAF throttling of mouse/touch move handlers
  const rafIdRef = useRef<number | null>(null);

  // Gate heavy market data loading to reduce LCP/INP pressure
  const [marketDataReady, setMarketDataReady] = useState<boolean>(false);
  // Overlay release to avoid blocking on secondary loads (charts/bots)
  const [overlayReleased, setOverlayReleased] = useState<boolean>(false);
  const [initStatus, setInitStatus] = useState<Record<InitStep, boolean>>({
    market: false,
    portfolio: false,
    bots: false,
    chart: false,
  });
  const [initFailSafeReached, setInitFailSafeReached] = useState<boolean>(false);

  const markInitStep = useCallback((step: InitStep) => {
    setInitStatus((prev) => (prev[step] ? prev : { ...prev, [step]: true }));
  }, []);

  // Memoize init step calculations to avoid recalculating on every render
  const { completedInitSteps, initProgress, pendingInitStep, initStatusText, initComplete } = useMemo(() => {
    const initStepLabels: Record<InitStep, string> = {
      market: "Market Data",
      portfolio: "Portfolio",
      bots: "Bots",
      chart: "Charts",
    };
    const completed = REQUIRED_INIT_STEPS.filter((step) => initStatus[step]).length;
    const progress = Math.max(10, Math.round((completed / REQUIRED_INIT_STEPS.length) * 100));
    const pending = REQUIRED_INIT_STEPS.find((step) => !initStatus[step]);
    const statusText = pending ? `Initializing ${initStepLabels[pending]}...` : "Systems Ready";
    return {
      completedInitSteps: completed,
      initProgress: progress,
      pendingInitStep: pending,
      initStatusText: statusText,
      initComplete: completed === REQUIRED_INIT_STEPS.length,
    };
  }, [initStatus]);

  // Minute data
  const [minuteData, setMinuteData] = useState<KlineData[]>([]);
  const [isLoadingMinuteData, setIsLoadingMinuteData] =
    useState<boolean>(false);

  // Memoize chart data source for tooltip calculations - must be after minuteData declared
  const activeChartData = useMemo(() => 
    zoomState.isZoomed && minuteData.length > 0 ? minuteData : chartData,
    [zoomState.isZoomed, minuteData, chartData]
  );

  // Top currencies
  const [topCurrencies, setTopCurrencies] = useState<CurrencyData[]>([]);
  const [isLoadingCurrencies, setIsLoadingCurrencies] = useState<boolean>(true);

  // Pagination and search for currencies
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [allCurrencies, setAllCurrencies] = useState<CurrencyData[]>([]);
  const [displayedCurrencies, setDisplayedCurrencies] = useState<
    CurrencyData[]
  >([]);
  const [filteredCurrencies, setFilteredCurrencies] = useState<CurrencyData[]>(
    []
  );
  const [startIndex, setStartIndex] = useState<number>(0);
  const [endIndex, setEndIndex] = useState<number>(0);
  const [rowsPerPage, setRowsPerPage] = useState<number>(10);
  const CURRENCIES_PER_PAGE_OPTIONS = [5, 10, 25, 50];

  // Selected currency
  const [selectedCurrency, setSelectedCurrency] = useState<string>("BTC");

  // Bot state - only keep selectedBotForStrategy which is actually used
  const [selectedBotForStrategy, setSelectedBotForStrategy] = useState<string | null>(null);

  // Helper function to safely get bot status as string
  const getBotStatus = useCallback((bot: any): string => {
    if (typeof bot.status === 'string') {
      return bot.status;
    } else if (Array.isArray(bot.status)) {
      return 'running'; // If status is an array of trades, bot is likely running
    } else {
      return 'unknown';
    }
  }, []);

  // Helper function to check if bot is running
  const isBotRunning = useCallback((bot: any): boolean => {
    const status = getBotStatus(bot);
    return status === 'running' || Array.isArray(bot.status);
  }, [getBotStatus]);

  // Memoize bot status computations to avoid recalculating on every render
  const { anyBotRunning, runningBotCount } = useMemo(() => {
    if (!freqTradeBots || freqTradeBots.length === 0) {
      return { anyBotRunning: false, runningBotCount: 0 };
    }
    const running = freqTradeBots.filter((bot) => {
      const status = typeof bot.status === 'string' ? bot.status : (Array.isArray(bot.status) ? 'running' : 'unknown');
      return status === 'running' || Array.isArray(bot.status);
    });
    return { anyBotRunning: running.length > 0, runningBotCount: running.length };
  }, [freqTradeBots]);

  // Update selectedBotForStrategy when FreqTrade bots are loaded
  useEffect(() => {
    if (freqTradeBots.length > 0 && !selectedBotForStrategy) {
      setSelectedBotForStrategy(freqTradeBots[0].instanceId);
    }
  }, [freqTradeBots, selectedBotForStrategy]);

  // Update selectedCurrencyRef when selectedCurrency changes
  useEffect(() => {
    selectedCurrencyRef.current = selectedCurrency;
  }, [selectedCurrency]);

  // Current time for mobile header - updated every second (only when mobile)
  const [currentTime, setCurrentTime] = useState<string>("");
  useEffect(() => {
    if (!isMobile) return;
    const updateTime = () => {
      setCurrentTime(new Date().toLocaleTimeString("en-US", {
        hour12: false,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }));
    };
    updateTime();
    const intervalId = setInterval(updateTime, 1000);
    return () => clearInterval(intervalId);
  }, [isMobile]);

  // Force update counter for strategy changes
  const [, setForceUpdate] = useState(0);

  // On mount, set initial lastUpdated
  useEffect(() => {
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
    const failSafe = setTimeout(() => setInitFailSafeReached(true), 5000); // Reduced from 8s
    return () => clearTimeout(failSafe);
  }, []);

  useEffect(() => {
    if (initComplete || initFailSafeReached) {
      setOverlayReleased(true);
    }
  }, [initComplete, initFailSafeReached]);

  // News data state
  const [newsItems, setNewsItems] = useState<any[]>([]);
  const [loadingNews, setLoadingNews] = useState<boolean>(true);

  // Additional state variables - removed unused variables
  // All data now comes from FreqTrade integration or external APIs (Binance, CoinGecko)

  // All data fetching functions removed - using FreqTrade integration instead
  // Portfolio, trades, positions, and bot config now come from FreqTrade WebSocket

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (isAuthenticated()) {
      // All data fetching is now handled by FreqTrade integration via WebSocket
      // No more localhost:5000 API calls needed
    }
  }, [
    authLoading,
    // Removed dependency on fetch handlers since they no longer make API calls
  ]);

  useEffect(() => {
    // Mark market as complete as soon as we have BTC data - don't wait for currencies
    if (!loading && cryptoData && chartData.length > 0) {
      markInitStep("market");
    }
  }, [loading, cryptoData, chartData, markInitStep]);

  useEffect(() => {
    if (!freqTradePortfolioLoading && (freqTradePortfolio || isNewUser)) {
      markInitStep("portfolio");
    }
  }, [freqTradePortfolioLoading, freqTradePortfolio, isNewUser, markInitStep]);

  useEffect(() => {
    if (!freqTradeBotsLoading) {
      markInitStep("bots");
    }
  }, [freqTradeBotsLoading, markInitStep]);

  useEffect(() => {
    const currentData = getChartDataWithFallback();
    // Mark chart complete even without data for faster perceived loading
    if (!portfolioChartLoading || currentData.length > 0 || isNewUser) {
      markInitStep("chart");
    }
  }, [portfolioChartLoading, getChartDataWithFallback, isNewUser, markInitStep]);



  // ============== Helpers ==============
  // Defer heavy work until the main thread is idle to improve LCP/INP
  const deferHeavyInit = useCallback((fn: () => void) => {
    if (typeof (window as any).requestIdleCallback === 'function') {
      (window as any).requestIdleCallback(fn, { timeout: 1500 });
    } else {
      setTimeout(fn, 250);
    }
  }, []);
  function formatCurrency(num: number, abbreviated: boolean = false): string {
    if (abbreviated && num > 1000000) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 2,
      }).format(num);
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // ============== All Currencies with Pagination ==============
  const fetchTopCurrencies = useCallback(async () => {
    try {
      setIsLoadingCurrencies(true);

      // Get data from CoinGecko which provides comprehensive market data
      const geckoResp = await axios.get(COIN_GECKO_ENDPOINT);

      if (!geckoResp.data || !Array.isArray(geckoResp.data)) {
        throw new Error("Invalid data format from CoinGecko API");
      }

      // Transform CoinGecko data to our format
      const currencies: CurrencyData[] = geckoResp.data.map((coin: any) => {
        return {
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          price: coin.current_price || 0,
          volume: coin.total_volume || 0,
          marketCap: coin.market_cap || 0,
          change24h: coin.price_change_percentage_24h || 0,
          lastUpdated: Date.now(),
        };
      });

      // Sort by market cap descending
      const sortedCurrencies = currencies.sort(
        (a, b) => b.marketCap - a.marketCap
      );

      // Store a capped list to keep rendering lightweight
      const limitedCurrencies = sortedCurrencies.slice(0, MAX_CURRENCIES);
      setAllCurrencies(limitedCurrencies);

      // Set the first 10 for backward compatibility with topCurrencies
      setTopCurrencies(sortedCurrencies.slice(0, 10));

      // Calculate total pages
      const totalPagesCount = Math.ceil(sortedCurrencies.length / rowsPerPage);
      setTotalPages(totalPagesCount);

      // Set initial displayed currencies (first page)
      setDisplayedCurrencies(sortedCurrencies.slice(0, rowsPerPage));

      setIsLoadingCurrencies(false);
      return true;
    } catch (err: any) {
      console.error("Error fetching currencies:", err);
      setIsLoadingCurrencies(false);
      return false;
    }
  }, [rowsPerPage]);

  // ============== Historical & Ticker Data ==============
  const fetchHistoricalDataForCurrency = useCallback(
    async (symbol: string): Promise<KlineData[]> => {
      try {
        const params = {
          symbol: symbol.toUpperCase() + "USDT",
          interval: "1h",
          limit: 24,
        };
        const resp = await axios.get(HISTORICAL_ENDPOINT, { params });
        const dataArray = resp.data;
        return dataArray.map((item: any) => ({
          timestamp: item[0] / 1000,
          time: formatTime(item[0]),
          open: Number(item[1]),
          high: Number(item[2]),
          low: Number(item[3]),
          close: Number(item[4]),
          volume: Number(item[5]),
        }));
      } catch (err: any) {
        console.error(`Error fetching historical data for ${symbol}:`, err);
        throw new Error(`Failed to load historical data for ${symbol}`);
      }
    },
    []
  );

  const fetchTickerDataForCurrency = useCallback(
    async (symbol: string): Promise<CryptoInfo> => {
      try {
        const params = {
          symbol: symbol.toUpperCase() + "USDT",
        };
        const endpoint = "https://api.binance.com/api/v3/ticker/24hr";
        const resp = await axios.get(endpoint, { params });
        return {
          price: Number(resp.data.lastPrice),
          change24h: Number(resp.data.priceChangePercent)
        };
      } catch (err: any) {
        console.error(`Error fetching ticker data for ${symbol}:`, err);
        throw new Error(`Failed to load current price for ${symbol}`);
      }
    },
    []
  );

  // ============== Minute Data ==============
  const fetchMinuteDataForCurrency = useCallback(
    async (
      symbol: string,
      startTime: number,
      endTime: number
    ): Promise<KlineData[]> => {
      try {
        setIsLoadingMinuteData(true);
        const params = {
          symbol: symbol.toUpperCase() + "USDT",
          interval: "1m",
          startTime: startTime,
          endTime: endTime,
          limit: 1000,
        };
        const resp = await axios.get(MINUTE_DATA_ENDPOINT, { params });
        const dataArray = resp.data;
        if (!Array.isArray(dataArray) || dataArray.length === 0) {
          setIsLoadingMinuteData(false);
          return [];
        }
        const sortedData = dataArray
          .map((item: any) => ({
            timestamp: item[0] / 1000,
            time: formatTime(item[0]),
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5]),
            isMinuteData: true,
          }))
          .sort((a, b) => a.timestamp - b.timestamp);

        setIsLoadingMinuteData(false);
        return sortedData;
      } catch (err: any) {
        console.error(`Error fetching minute data for ${symbol}:`, err);
        setIsLoadingMinuteData(false);
        throw new Error(`Failed to load minute data for ${symbol}`);
      }
    },
    []
  );

  // ============== WebSocket & Initialization ==============
  // Process batch for selected currency chart updates
  const processBatch = useCallback(() => {
    if (priceBufferRef.current !== null) {
      const latestPrice = priceBufferRef.current;
      const latestChange = changeBufferRef.current;
      const now = Date.now();
      setCryptoData((prev) =>
        prev
          ? { ...prev, price: latestPrice, change24h: latestChange ?? prev.change24h }
          : { price: latestPrice, change24h: latestChange ?? 0 }
      );
      const hourElapsed = now - lastChartUpdateRef.current >= HOUR_IN_MS;
      if (hourElapsed) {
        lastChartUpdateRef.current = now;
        setChartData((prev) => {
          const newPoint: KlineData = {
            time: formatTime(now),
            close: latestPrice,
            timestamp: now / 1000,
          };
          const historicalPoints = prev.slice(0, 24);
          const livePoints = prev.slice(24);
          const updatedLivePoints = [...livePoints, newPoint];
          if (updatedLivePoints.length > MAX_CHART_POINTS - 24) {
            updatedLivePoints.shift();
          }
          return [...historicalPoints, ...updatedLivePoints];
        });
      }
      setLastUpdated(new Date().toLocaleTimeString());
    }
    messageCountRef.current = 0;
    priceBufferRef.current = null;
    changeBufferRef.current = null;
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
  }, []);

  // Global WebSocket connection that subscribes to all top tickers
  const connectWebSocketAll = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setConnectionStatus("connecting");
    const ws = new WebSocket(WS_ENDPOINT);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setConnectionStatus("connected");
      const subscriptionMessage = {
        method: "SUBSCRIBE",
        params: TOP_SYMBOLS.map((symbol) => symbol.toLowerCase() + "@ticker"),
        id: 1,
      };
      ws.send(JSON.stringify(subscriptionMessage));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg && msg.c && msg.s) {
          const instrument = msg.s; // e.g., "BTCUSDT"
          const price = Number(msg.c);
          const change24h = Number(msg.P);
          const currencySymbol = instrument.replace("USDT", "");
          // Update the latest data in a ref (for table updates)
          latestPricesRef.current[currencySymbol] = {
            price,
            change24h,
            lastUpdated: Date.now(),
          };
          // If this update is for the currently selected currency, batch chart updates
          if (currencySymbol === selectedCurrencyRef.current) {
            priceBufferRef.current = price;
            changeBufferRef.current = change24h;
            messageCountRef.current += 1;
            if (messageCountRef.current >= BATCH_THRESHOLD) {
              processBatch();
            } else if (!batchTimerRef.current) {
              batchTimerRef.current = window.setTimeout(
                processBatch,
                BATCH_WINDOW
              );
            }
          }
        }
      } catch (err) {
        console.error("Error parsing WS message:", err);
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setWsConnected(false);
      setConnectionStatus("disconnected");
    };

    ws.onclose = (e) => {
      setWsConnected(false);
      setConnectionStatus("disconnected");
      if (e.code !== 1000 && e.code !== 1001) {
        // Attempt reconnect after 5 seconds
        setTimeout(() => {
          setConnectionStatus("connecting");
          setTimeout(connectWebSocketAll, 100); // Small delay before actual connection attempt
        }, 5000);
      }
    };
  }, [processBatch]);

  // Update the table of currencies every second using the latestPricesRef
  useEffect(() => {
    const intervalId = setInterval(() => {
      const updateCurrency = (currency: CurrencyData) => {
        const latest = latestPricesRef.current[currency.symbol];
        return latest
          ? {
            ...currency,
            price: latest.price,
            change24h: latest.change24h ?? currency.change24h,
            lastUpdated: latest.lastUpdated,
          }
          : currency;
      };

      // Update a limited slice to reduce render work
      if (marketDataReady) {
        setAllCurrencies((prev) => prev.map(updateCurrency));
        setTopCurrencies((prev) => prev.slice(0, 20).map(updateCurrency));
      }
    }, 30000); // Reduced from 5s to 30s to improve performance
    return () => clearInterval(intervalId);
  }, [marketDataReady]);

  // Initialization for selected currency – note we no longer reconnect WS here
  const initializeDashboardForCurrency = useCallback(
    async (symbol: string) => {
      try {
        setLoading(true);
        setError(null);

        // Parallelize fetching historical and ticker data
        const [historical, ticker] = await Promise.all([
          fetchHistoricalDataForCurrency(symbol),
          fetchTickerDataForCurrency(symbol),
        ]);

        setChartData(historical);
        setCryptoData(ticker);
        setLastUpdated(new Date().toLocaleTimeString());

        setLoading(false);
      } catch (err: any) {
        console.error(`Error initializing for ${symbol}:`, err);
        setError(err?.message || `Failed to load data for ${symbol}`);
        setLoading(false);
      }
    },
    [fetchHistoricalDataForCurrency, fetchTickerDataForCurrency]
  );

  // 2. Fetch news from CryptoCompare
  const fetchLatestNews = useCallback(async () => {
    if (!marketDataReady) return false;
    try {
      setLoadingNews(true);
      const resp = await axios.get(
        "https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC,ETH,Regulation,Mining&excludeCategories=Sponsored&items=5"
      );
      if (!resp.data || !resp.data.Data) {
        throw new Error("Invalid news data format from API");
      }
      const newsData = resp.data.Data.map((item: any) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        source: item.source,
        imageUrl: item.imageurl,
        categories: item.categories,
        snippet:
          item.body.length > 120
            ? item.body.substring(0, 120) + "..."
            : item.body,
        publishedAt: new Date(item.published_on * 1000).toLocaleString(),
      }));
      setNewsItems(newsData);
      setLoadingNews(false);
      return true;
    } catch (err: any) {
      console.error("Error fetching news:", err);
      setLoadingNews(false);
      return false;
    }
  }, [marketDataReady]);

  useEffect(() => {
    // Use requestIdleCallback to defer non-critical initialization
    const scheduleInit = (fn: () => void, fallbackMs: number) => {
      if ('requestIdleCallback' in window) {
        (window as any).requestIdleCallback(fn, { timeout: fallbackMs });
      } else {
        setTimeout(fn, fallbackMs);
      }
    };

    // Defer BTC ticker to allow initial render to complete first
    scheduleInit(() => {
      initializeDashboardForCurrency("BTC").catch(err => console.error("BTC init error:", err));
    }, 100);
    
    // Set market data ready after initial render
    scheduleInit(() => setMarketDataReady(true), 200);
    
    // Defer WebSocket connection further
    scheduleInit(() => {
      connectWebSocketAll();
    }, 800);
    
    // Defer heavy CoinGecko currency fetch even more
    const currencyTimeout = setTimeout(() => {
      fetchTopCurrencies().catch(err => console.error("Currency init error:", err));
    }, 2000);
    
    // Defer news to much later - it's not critical
    const newsTimeout = setTimeout(() => {
      fetchLatestNews().catch(err => console.error("News init error:", err));
    }, 3000);

    return () => {
      clearTimeout(currencyTimeout);
      clearTimeout(newsTimeout);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
    };
  }, [
    fetchTopCurrencies,
    initializeDashboardForCurrency,
    fetchLatestNews,
    connectWebSocketAll,
  ]);

  // Removed fetchUserData - account creation date is no longer fetched from localhost:5000
  // User data is handled by Firebase Auth context - no longer needed
  // Portfolio data comes from Bot Manager API


  // ============== Handlers ==============
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const handleResetZoom = useCallback(() => {
    setZoomState({ xDomain: undefined, yDomain: undefined, isZoomed: false });
    setMinuteData([]);

  }, []);

  const handleCurrencySelect = useCallback(
    (symbol: string) => {
      // Do not close or reconnect the WS – it stays global.
      setZoomState({ xDomain: undefined, yDomain: undefined, isZoomed: false });
      setChartData([]);
      setMinuteData([]);
      setSelectedCurrency(symbol);
      const currencyData = topCurrencies.find((c) => c.symbol === symbol);
      if (currencyData) {
        // Name state removed as it was unused
      }
        initializeDashboardForCurrency(symbol);
    },
    [topCurrencies, initializeDashboardForCurrency]
  );

  // Placeholder for handleRefresh - will be defined after fetchPortfolioChartData

  // Zoom/Pan via Mouse & Touch
  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (event.touches.length === 2) {
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        const distance = Math.hypot(
          t2.clientX - t1.clientX,
          t2.clientY - t1.clientY
        );
        const chartRect = event.currentTarget.getBoundingClientRect();
        const centerX = (t1.clientX + t2.clientX) / 2;
        const centerY = (t1.clientY + t2.clientY) / 2;
        const xPercent = (centerX - chartRect.left) / chartRect.width;
        const yPercent = (centerY - chartRect.top) / chartRect.height;
        setTouchState({
          initialDistance: distance,
          initialDomains: {
            x: zoomState.xDomain || chartBounds.fullXDomain,
            y: zoomState.yDomain || chartBounds.fullYDomain,
            centerX: xPercent,
            centerY: yPercent,
          },
        });
      } else if (event.touches.length === 1 && zoomState.isZoomed) {
        const touch = event.touches[0];
        setPanState({
          isPanning: true,
          lastMouseX: touch.clientX,
          lastMouseY: touch.clientY,
        });
      }
    },
    [chartBounds, zoomState]
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      // Throttle with RAF to prevent INP issues
      if (rafIdRef.current) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        
        if (event.touches.length === 2) {
          const t1 = event.touches[0];
          const t2 = event.touches[1];
          const distance = Math.hypot(
            t2.clientX - t1.clientX,
            t2.clientY - t1.clientY
          );
          const zoomFactor = touchState.initialDistance / distance;
          const xPercent = touchState.initialDomains.centerX;
          const yPercent = touchState.initialDomains.centerY;
          const xRange =
            touchState.initialDomains.x[1] - touchState.initialDomains.x[0];
          const yRange =
            touchState.initialDomains.y[1] - touchState.initialDomains.y[0];
          const newXDomain: [number, number] = [
            touchState.initialDomains.x[0] - xRange * (1 - zoomFactor) * xPercent,
            touchState.initialDomains.x[1] +
            xRange * (1 - zoomFactor) * (1 - xPercent),
          ];
          const newYDomain: [number, number] = [
            touchState.initialDomains.y[0] -
            yRange * (1 - zoomFactor) * (1 - yPercent),
            touchState.initialDomains.y[1] + yRange * (1 - zoomFactor) * yPercent,
          ];
          if (zoomFactor > 1) {
            if (
              newXDomain[0] < chartBounds.fullXDomain[0] &&
              newXDomain[1] > chartBounds.fullXDomain[1] &&
              newYDomain[0] < chartBounds.fullYDomain[0] &&
              newYDomain[1] > chartBounds.fullYDomain[1]
            ) {
              handleResetZoom();
              return;
            }
          }
          setZoomState({
            xDomain: newXDomain,
            yDomain: newYDomain,
            isZoomed: true,
          });
        } else if (
          event.touches.length === 1 &&
          panState.isPanning &&
          zoomState.isZoomed
        ) {
          const touch = event.touches[0];
          const deltaX = touch.clientX - panState.lastMouseX;
          const deltaY = touch.clientY - panState.lastMouseY;
          const currentXDomain = zoomState.xDomain || chartBounds.fullXDomain;
          const currentYDomain = zoomState.yDomain || chartBounds.fullYDomain;
          const xRange = currentXDomain[1] - currentXDomain[0];
          const yRange = currentYDomain[1] - currentYDomain[0];
          const chartRect = chartContainerRef.current?.getBoundingClientRect();
          if (!chartRect) return;
          const xShift = (deltaX / chartRect.width) * xRange * -2;
          const yShift = (deltaY / chartRect.height) * yRange;
          let newXDomain: [number, number] = [
            currentXDomain[0] + xShift,
            currentXDomain[1] + xShift,
          ];
          const newYDomain: [number, number] = [
            currentYDomain[0] + yShift,
            currentYDomain[1] + yShift,
          ];
          if (newXDomain[0] < chartBounds.fullXDomain[0]) {
            const overflow = chartBounds.fullXDomain[0] - newXDomain[0];
            newXDomain = [chartBounds.fullXDomain[0], newXDomain[1] - overflow];
          }
          if (newXDomain[1] > chartBounds.fullXDomain[1]) {
            const overflow = newXDomain[1] - chartBounds.fullXDomain[1];
            newXDomain = [newXDomain[0] + overflow, chartBounds.fullXDomain[1]];
          }
          setZoomState({
            xDomain: newXDomain,
            yDomain: newYDomain,
            isZoomed: true,
          });
          setPanState({
            isPanning: true,
            lastMouseX: touch.clientX,
            lastMouseY: touch.clientY,
          });
        }
      });
    },
    [touchState, panState, zoomState, chartBounds, handleResetZoom]
  );

  const handleTouchEnd = useCallback(() => {
    setPanState((prev) => ({ ...prev, isPanning: false }));
  }, []);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (zoomState.isZoomed) {
        setPanState({
          isPanning: true,
          lastMouseX: event.clientX,
          lastMouseY: event.clientY,
        });
        event.preventDefault();
      }
    },
    [zoomState.isZoomed]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!panState.isPanning || !zoomState.isZoomed) return;
      // Throttle with RAF to prevent INP issues
      if (rafIdRef.current) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const deltaX = event.clientX - panState.lastMouseX;
        const deltaY = event.clientY - panState.lastMouseY;
        const currentXDomain = zoomState.xDomain || chartBounds.fullXDomain;
        const currentYDomain = zoomState.yDomain || chartBounds.fullYDomain;
        const xRange = currentXDomain[1] - currentXDomain[0];
        const yRange = currentYDomain[1] - currentYDomain[0];
        const chartRect = chartContainerRef.current?.getBoundingClientRect();
        if (!chartRect) return;
        const xShift = (deltaX / chartRect.width) * xRange * -1.5;
        const yShift = (deltaY / chartRect.height) * yRange;
        let newXDomain: [number, number] = [
          currentXDomain[0] + xShift,
          currentXDomain[1] + xShift,
        ];
        const newYDomain: [number, number] = [
          currentYDomain[0] + yShift,
          currentYDomain[1] + yShift,
        ];
        if (newXDomain[0] < chartBounds.fullXDomain[0]) {
          const overflow = chartBounds.fullXDomain[0] - newXDomain[0];
          newXDomain = [chartBounds.fullXDomain[0], newXDomain[1] - overflow];
        }
        if (newXDomain[1] > chartBounds.fullXDomain[1]) {
          const overflow = newXDomain[1] - chartBounds.fullXDomain[1];
          newXDomain = [newXDomain[0] + overflow, chartBounds.fullXDomain[1]];
        }
        setZoomState({
          xDomain: newXDomain,
          yDomain: newYDomain,
          isZoomed: true,
        });
        setPanState({
          isPanning: true,
          lastMouseX: event.clientX,
          lastMouseY: event.clientY,
        });
      });
    },
    [panState, zoomState, chartBounds]
  );

  const handleMouseUp = useCallback(() => {
    setPanState((prev) => ({ ...prev, isPanning: false }));
  }, []);

  const handleMouseLeave = useCallback(() => {
    setPanState((prev) => ({ ...prev, isPanning: false }));
  }, []);

  useEffect(() => {
    if (!panState.isPanning) return;
    const handleGlobalMouseUp = () => {
      setPanState((prev) => ({ ...prev, isPanning: false }));
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [panState.isPanning]);

  // ====== Portfolio Distribution and Bot Advanced Settings ======
  // Note: Advanced settings have been moved to the dedicated Bot Config page (/bot/:botId/config)
  // These state variables are kept for backwards compatibility with the settings fetch

  const [botRiskLevel, setBotRiskLevel] = useState<number>(50);
  const [botAutoRebalance, setBotAutoRebalance] = useState<boolean>(true);
  const [botDCAEnabled, setBotDCAEnabled] = useState<boolean>(true);
  const [settingsLoading, setSettingsLoading] = useState<boolean>(false);
  const [botPerformance, setBotPerformance] = useState<{
    successRate: number;
    tradesPerDay: number;
    winningTrades: number;
    losingTrades: number;
    totalTrades: number;
  }>({ successRate: 0, tradesPerDay: 0, winningTrades: 0, losingTrades: 0, totalTrades: 0 });

  // Fetch universal settings when a bot is selected
  useEffect(() => {
    const fetchBotSettings = async () => {
      if (!selectedBotForStrategy || hasNoBots) return;
      
      try {
        setSettingsLoading(true);
        const token = await auth.currentUser?.getIdToken();
        const response = await fetch(
          `${config.api.baseUrl}/api/freqtrade/universal-settings`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );
        
        if (response.ok) {
          const data = await response.json();
          const botSettings = data.bots?.find((b: any) => b.instanceId === selectedBotForStrategy);
          if (botSettings?.settings) {
            setBotRiskLevel(botSettings.settings.riskLevel ?? 50);
            setBotAutoRebalance(botSettings.settings.autoRebalance ?? true);
            setBotDCAEnabled(botSettings.settings.dcaEnabled ?? true);
          }
        }
      } catch (error) {
        console.error('Failed to fetch bot settings:', error);
      } finally {
        setSettingsLoading(false);
      }
    };
    
    fetchBotSettings();
  }, [selectedBotForStrategy, hasNoBots]);

  // Fetch bot performance when a bot is selected
  useEffect(() => {
    const fetchPerformance = async () => {
      if (!selectedBotForStrategy || hasNoBots) return;
      
      try {
        const token = await auth.currentUser?.getIdToken();
        const response = await fetch(
          `${config.api.baseUrl}/api/freqtrade/proxy/${selectedBotForStrategy}/api/v1/profit`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );
        
        if (response.ok) {
          const data = await response.json();
          const winning = data.winning_trades || 0;
          const losing = data.losing_trades || 0;
          const total = winning + losing;
          const successRate = total > 0 ? Math.round((winning / total) * 100) : 0;
          
          // Calculate trades per day
          const firstTrade = data.first_trade_timestamp ? new Date(data.first_trade_timestamp * 1000) : null;
          const now = new Date();
          const daysSinceFirstTrade = firstTrade ? Math.max(1, (now.getTime() - firstTrade.getTime()) / (1000 * 60 * 60 * 24)) : 1;
          const tradesPerDay = total > 0 ? Math.round((total / daysSinceFirstTrade) * 10) / 10 : 0;
          
          setBotPerformance({
            successRate,
            tradesPerDay,
            winningTrades: winning,
            losingTrades: losing,
            totalTrades: total,
          });
        }
      } catch (error) {
        console.error('Failed to fetch bot performance:', error);
        // Keep default values on error
      }
    };
    
    fetchPerformance();
    // Refresh performance every 30 seconds
    const interval = setInterval(fetchPerformance, 30000);
    return () => clearInterval(interval);
  }, [selectedBotForStrategy, hasNoBots]);

  // Handler to update universal settings on the backend
  const updateBotSettings = useCallback(async (settings: {
    riskLevel?: number;
    autoRebalance?: boolean;
    dcaEnabled?: boolean;
  }) => {
    if (!selectedBotForStrategy || hasNoBots) return;
    
    try {
      const token = await auth.currentUser?.getIdToken();
      const response = await fetch(
        `${config.api.baseUrl}/api/freqtrade/universal-settings/${selectedBotForStrategy}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(settings),
        }
      );
      
      if (response.ok) {
        // Settings updated successfully
      }
    } catch (error) {
      // Handle error silently
    }
  }, [selectedBotForStrategy, hasNoBots]);

  // Debounced risk level update
  const riskLevelTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const handleRiskLevelChange = useCallback((value: number[]) => {
    setBotRiskLevel(value[0]);
    
    // Debounce API call
    if (riskLevelTimeoutRef.current) {
      clearTimeout(riskLevelTimeoutRef.current);
    }
    riskLevelTimeoutRef.current = setTimeout(() => {
      updateBotSettings({ riskLevel: value[0] });
    }, 500);
  }, [updateBotSettings]);

  // Toggle handlers that update backend
  const handleAutoRebalanceToggle = useCallback(() => {
    const newValue = !botAutoRebalance;
    setBotAutoRebalance(newValue);
    updateBotSettings({ autoRebalance: newValue });
  }, [botAutoRebalance, updateBotSettings]);

  const handleDCAToggle = useCallback(() => {
    const newValue = !botDCAEnabled;
    setBotDCAEnabled(newValue);
    updateBotSettings({ dcaEnabled: newValue });
  }, [botDCAEnabled, updateBotSettings]);

  const fetchPortfolioChartData = useCallback(
    async (timeframe: "1H" | "24H" | "7D" | "30D") => {
      setPortfolioChartLoading(true);

      // Track the current request to prevent race conditions
      currentTimeframeRequestRef.current = timeframe;

      try {
        // Use SSE-based chart data fetching
        if (freqTradeConnected) {
          // Map timeframe format to API format
          const apiTimeframe =
            timeframe === "1H"
              ? "1h"
              : timeframe === "24H"
                ? "24h"
                : timeframe === "7D"
                  ? "7d"
                  : "30d";

          // Check if we already have data for this timeframe (use ref to avoid dependency loop)
          const existingData = freqTradeChartDataRef.current?.[apiTimeframe];
          if (
            existingData &&
            existingData.data &&
            existingData.data.length > 0
          ) {
            // Transform SSE chart data to internal format
            const transformedData = existingData.data.map((point: any) => ({
              timestamp: new Date(point.timestamp),
              portfolioValue: point.portfolioValue,
              totalPnL: point.totalPnL,
              total: point.portfolioValue,
              showPoint: point.showPoint, // Preserve showPoint flag
              pnlPercentage:
                point.totalPnL / (point.portfolioValue - point.totalPnL),
            }));

            updatePortfolioDataForTimeframe(timeframe, transformedData);
            setPortfolioChartLoading(false);
            return;
          }

          // Fetch new chart data from SSE service
          await fetchFreqTradeChartData(
            apiTimeframe as "1h" | "24h" | "7d" | "30d"
          );

          // Data will be updated via the chart data effect hook
        } else {
          // FreqTrade not connected - clear data
          updatePortfolioDataForTimeframe(timeframe, []);
          setPortfolioChartLoading(false);
        }
      } catch (error) {
        // Handle error silently
        updatePortfolioDataForTimeframe(timeframe, []);
        setPortfolioChartLoading(false);
      }
    },
    [
      freqTradeConnected,
      fetchFreqTradeChartData,
      updatePortfolioDataForTimeframe,
    ]
  );

  // Handle chart data updates from SSE service
  useEffect(() => {
    if (!freqTradeChartData || Object.keys(freqTradeChartData).length === 0) {

      // If we have portfolio data but no chart data, let's create a simple fallback point
      if (
        freqTradeConnected &&
        freqTradePortfolio &&
        freqTradePortfolio.portfolioValue > 0
      ) {
        const fallbackPoint = {
          timestamp: new Date(freqTradePortfolio.timestamp),
          date: new Date(freqTradePortfolio.timestamp),
          portfolioValue: freqTradePortfolio.portfolioValue,
          totalPnL: freqTradePortfolio.totalPnL,
          totalValue: freqTradePortfolio.portfolioValue,
          value: freqTradePortfolio.portfolioValue,
          paperBalance: freqTradePortfolio.totalPnL,
          total: freqTradePortfolio.portfolioValue,
          pnlPercentage: freqTradePortfolio.pnlPercentage,
          _fallback: true,
        };
        updatePortfolioDataForTimeframe(portfolioDateRange, [fallbackPoint]);
      }

      setPortfolioChartLoading(false);
      return;
    }

    // Check if we have data for the current timeframe
    const apiTimeframe =
      portfolioDateRange === "1H"
        ? "1h"
        : portfolioDateRange === "24H"
          ? "24h"
          : portfolioDateRange === "7D"
            ? "7d"
            : "30d";

    const chartDataForTimeframe = freqTradeChartData[apiTimeframe];

    if (
      chartDataForTimeframe &&
      chartDataForTimeframe.data &&
      chartDataForTimeframe.data.length > 0
    ) {
      // Transform SSE chart data to internal format
      const transformedData = chartDataForTimeframe.data.map(
        (point: any, index: number) => {
          const transformed = {
            timestamp: new Date(point.timestamp),
            date: new Date(point.timestamp), // Chart expects 'date' field
            portfolioValue: point.portfolioValue,
            totalPnL: point.totalPnL,
            // Chart component expects these specific fields:
            totalValue: point.portfolioValue, // Chart looks for 'totalValue' or 'value'
            value: point.portfolioValue, // Backup field
            paperBalance: point.totalPnL, // Use PnL as paper balance
            total: point.portfolioValue, // This is what actually gets displayed
            pnlPercentage:
              point.totalPnL /
              Math.max(point.portfolioValue - point.totalPnL, 1), // Avoid division by zero
            showPoint: point.showPoint, // Preserve showPoint flag for chart dot visibility
            _fromSSE: true, // Mark as SSE data
            _index: index,
          };
          return transformed;
        }
      );

      updatePortfolioDataForTimeframe(portfolioDateRange, transformedData);
      setPortfolioChartLoading(false);
    } else {
      setPortfolioChartLoading(false);
    }
  }, [
    freqTradeChartData,
    portfolioDateRange,
    updatePortfolioDataForTimeframe,
    freqTradeConnected,
    freqTradePortfolio,
  ]);

  // Chart data is now handled in the SSE hook directly - removed duplicate logic

  // Main refresh function
  const handleRefresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Refresh crypto price data
      const ticker = await fetchTickerDataForCurrency(selectedCurrency);
      setCryptoData(ticker);

      // Refresh FreqTrade SSE data
      await refreshFreqTradeData();

      // Refresh current portfolio chart data
      await fetchPortfolioChartData(portfolioDateRange);

      setLastUpdated(new Date().toLocaleTimeString());
      setLoading(false);
    } catch (err: any) {
      setError(err?.message || "Failed to refresh data");
      setLoading(false);
    }
  }, [
    fetchTickerDataForCurrency,
    selectedCurrency,
    refreshFreqTradeData,
    fetchPortfolioChartData,
    portfolioDateRange,
  ]);

  // Helper function to generate fallback chart data
  // Fallback data generation disabled - return empty array
  const generateFallbackData = () => [];
  const generateMockData = () => [];

  useEffect(() => {
    // Fetch data when timeframe changes
    fetchPortfolioChartData(portfolioDateRange);
  }, [portfolioDateRange, fetchPortfolioChartData]);

  // Old WebSocket-based portfolio history watching removed - now handled by SSE chart data effect

  // Safety mechanism: Clear loading state after 8 seconds if still loading
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (portfolioChartLoading) {
        setPortfolioChartLoading(false);
      }
    }, 8000);

    return () => clearTimeout(timeoutId);
  }, [portfolioChartLoading, portfolioDateRange, portfolioDataByTimeframe]);

  // Ensure the chart's latest data point matches the current displayed balance
  // DISABLED: This was causing timeframe data to be overwritten
  // useEffect(() => {
  //   if (freqTradePortfolio && portfolioHistory.length > 0) {
  //     const currentValue =
  //       freqTradePortfolio.portfolioValue ||
  //       freqTradePortfolio.totalBalance ||
  //       0;
  //     const currentPnL = freqTradePortfolio.totalPnL || 0;
  //     const latestHistoryValue =
  //       portfolioHistory[portfolioHistory.length - 1]?.totalValue || 0;

  //     // If there's a significant difference, add the current value as the latest point
  //     if (Math.abs(currentValue - latestHistoryValue) > 0.01) {
  //       console.log(
  //         `📊 Updating chart with current balance: $${currentValue.toFixed(
  //           2
  //         )} (was $${latestHistoryValue.toFixed(2)})`
  //       );

  //       const currentTimestamp = new Date();
  //       const updatedHistory = [...portfolioHistory];

  //       // Update or add the latest point to match current balance
  //       const latestPoint = {
  //         timestamp: currentTimestamp.toISOString(),
  //         date: currentTimestamp,
  //         totalValue: currentValue,
  //         paperBalance: currentPnL,
  //         value: currentValue,
  //       };

  //       // Replace the last point if it's very recent (within 5 minutes), otherwise add new point
  //       const lastPoint = updatedHistory[updatedHistory.length - 1];
  //       if (
  //         lastPoint &&
  //         currentTimestamp.getTime() - new Date(lastPoint.timestamp).getTime() <
  //           5 * 60 * 1000
  //       ) {
  //         updatedHistory[updatedHistory.length - 1] = latestPoint;
  //       } else {
  //         updatedHistory.push(latestPoint);
  //       }

  //       setPortfolioHistory(updatedHistory);
  //     }
  //   }
  // }, [freqTradePortfolio, portfolioHistory]);

  // ============== Pagination and Search Utilities ==============
  const filterAndPaginateCurrencies = useCallback(() => {
    // Use requestAnimationFrame to avoid blocking user interactions
    requestAnimationFrame(() => {
      let filtered = allCurrencies;

      // Apply search filter
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        filtered = allCurrencies.filter(
          (currency) =>
            currency.symbol.toLowerCase().includes(term) ||
            currency.name.toLowerCase().includes(term)
        );
      }

      // Calculate total pages for filtered results
      const totalPagesCount = Math.ceil(filtered.length / rowsPerPage);
      const validPage = currentPage > totalPagesCount ? 1 : currentPage;

      // Paginate
      const start = (validPage - 1) * rowsPerPage;
      const end = start + rowsPerPage;
      const paginatedCurrencies = filtered.slice(start, end);

      // Batch all state updates together (React 18 auto-batches these)
      setTotalPages(totalPagesCount);
      if (validPage !== currentPage) {
        setCurrentPage(validPage);
      }
      setDisplayedCurrencies(paginatedCurrencies);
      setFilteredCurrencies(filtered);
      setStartIndex(start);
      setEndIndex(end);
    });
  }, [allCurrencies, searchTerm, currentPage, rowsPerPage]);

  // Handle rows per page change
  const handleRowsPerPageChange = (value: string) => {
    setRowsPerPage(parseInt(value));
    setCurrentPage(1); // Reset to first page when changing rows per page
  };

  // Handle page change
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  // Handle search
  const handleSearch = (value: string) => {
    setSearchTerm(value);
    setCurrentPage(1); // Reset to first page on search
  };

  // Effect to update displayed currencies when filters change
  useEffect(() => {
    if (allCurrencies.length > 0) {
      filterAndPaginateCurrencies();
    }
  }, [filterAndPaginateCurrencies]);

  // ============== Render ==============
  return (
    <SidebarProvider defaultOpen={!isMobile}>
      <AppSidebar />
      <SidebarInset>
        {!isMobile && <SidebarRail className="absolute top-4.5 left-4" />}
        {/* CSS moved to dashboard.css for performance */}
        {(authLoading || !overlayReleased) && (
          <div className="loading-overlay">
            <div className="text-center">
              <h1 className="crypto-dashboard-title text-4xl sm:text-6xl md:text-7xl">
                CRYPTO PILOT
              </h1>
              <div className="mt-4 flex flex-col items-center gap-2">
                <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary animate-progress-loading"
                    style={{ width: `${initProgress}%` }}
                  />
                </div>
                <p className="text-xs text-white/50 uppercase tracking-widest font-medium">
                  {initStatusText} ({initProgress}%)
                </p>
              </div>
            </div>
          </div>
        )}
        <div
          className={cn(
            "w-full overflow-hidden no-scrollbar sidebar-responsive-content",
            isMobile
              ? "mobile-content-wrapper mobile-content-container"
              : "p-2 sm:p-4"
          )}
          style={{ maxWidth: "100%" }}
        >
          {/* Mobile Floating Header Tray */}
          {isMobile && (
            <div className="mobile-floating-header">
              <div className="mobile-header-content">
                {/* 1. Sidebar Toggle Button - First element */}
                <div
                  style={{
                    flex: "0 0 36px",
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <SidebarTrigger className="mobile-tray-icon-button bg-transparent border-black/20 dark:border-white/20 text-black/90 dark:text-white/90 hover:bg-black/10 dark:hover:bg-white/10" />
                </div>

                {/* 2. "LAST UPDATED" section - Takes remaining space */}
                <div className="group relative mobile-last-updated-section">
                  <div
                    className="mobile-last-updated-combined"
                    style={{
                      color: "white !important",
                      backgroundColor: "rgba(0, 0, 0, 0.9) !important",
                      borderColor: "rgba(0, 0, 0, 0.3) !important",
                      border: "1px solid rgba(0, 0, 0, 0.3)",
                      borderRadius: "10px",
                      padding: "0 12px",
                      height: "36px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "1",
                      width: "100%",
                      maxWidth: "100%",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      className="mobile-last-updated-text"
                      style={{
                        color: "rgb(255, 255, 255) !important",
                        fontSize: "7px !important",
                        lineHeight: "1 !important",
                        textTransform: "uppercase",
                        opacity: "0.8 !important",
                      }}
                    >
                      LAST UPDATED
                    </div>
                    <div
                      className="mobile-last-updated-time"
                      style={{
                        color: "rgb(255, 255, 255) !important",
                        fontSize: "9px !important",
                        fontWeight: "600 !important",
                        lineHeight: "1 !important",
                        textShadow: "none !important",
                        opacity: "1 !important",
                        filter: "none !important",
                      }}
                    >
                      {currentTime}
                    </div>
                  </div>
                  {/* Tooltip for Last Updated */}
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1 bg-black/80 text-white text-xs rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap z-50 border border-white/20">
                    <div className="font-medium">Last Updated</div>
                    <div className="text-white/70">
                      {lastUpdated
                        ? `Data refreshed at ${lastUpdated}`
                        : "No data refresh yet"}
                    </div>
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-black/80"></div>
                  </div>
                </div>

                {/* 3. Connection Indicator - Center element */}
                <div
                  style={{
                    flex: "0 0 36px",
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <div className="mobile-connection-wrapper">
                    <div className="group relative">
                      <span
                        className={cn(
                          "mobile-connection-indicator inline-block rounded-full transition-all duration-300 cursor-help shadow-lg",
                          wsConnected && freqTradeConnected
                            ? "bg-green-500 shadow-green-500/50"
                            : wsConnected || freqTradeConnected
                              ? "bg-yellow-500 shadow-yellow-500/50"
                              : connectionStatus === "connecting"
                                ? "bg-yellow-500 shadow-yellow-500/50 animate-pulse"
                                : "bg-red-500 shadow-red-500/50 animate-ping"
                        )}
                        style={
                          connectionStatus === "connecting"
                            ? {
                              animationDuration: "2s",
                            }
                            : {}
                        }
                        title={
                          wsConnected && freqTradeConnected
                            ? "Market data and FreqTrade connected"
                            : wsConnected
                              ? "Market data connected, FreqTrade disconnected"
                              : freqTradeConnected
                                ? "FreqTrade connected, market data disconnected"
                                : connectionStatus === "connecting"
                                  ? "Connecting to data sources..."
                                  : "All connections lost - data may be outdated"
                        }
                      />
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1 bg-black/80 text-white text-xs rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap z-50 border">
                        <div className="font-medium">
                          {wsConnected && freqTradeConnected
                            ? "All Connected"
                            : wsConnected
                              ? "Market Data Only"
                              : freqTradeConnected
                                ? "FreqTrade Only"
                                : connectionStatus === "connecting"
                                  ? "Connecting..."
                                  : "Disconnected"}
                        </div>
                        <div className="text-white/70 space-y-1">
                          <div
                            className={
                              wsConnected ? "text-green-400" : "text-red-400"
                            }
                          >
                            Market Data:{" "}
                            {wsConnected ? "Connected" : "Disconnected"}
                          </div>
                          <div
                            className={
                              freqTradeConnected
                                ? "text-green-400"
                                : "text-red-400"
                            }
                          >
                            FreqTrade:{" "}
                            {freqTradeConnected ? "Connected" : "Disconnected"}
                          </div>
                        </div>
                        <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-black/80"></div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 4. Refresh Button - Individual element */}
                <div
                  style={{
                    flex: "0 0 36px",
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={loading}
                    className="mobile-tray-icon-button bg-transparent border-black/20 dark:border-white/20 text-black/90 dark:text-white/90 hover:bg-black/10 dark:hover:bg-white/10"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>

                {/* 5. Mode Toggle - Individual element */}
                <div
                  style={{
                    flex: "0 0 36px",
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <ModeToggle className="mobile-tray-icon-button bg-transparent border-black/20 dark:border-white/20 text-black/90 dark:text-white/90 hover:bg-black/10 dark:hover:bg-white/10" />
                </div>
              </div>
            </div>
          )}

          {/* Mobile Title Section - Below the tray */}
          {isMobile && (
            <div className="mobile-title-section">
              <h1 className="text-3xl font-bold crypto-dashboard-title">
                Crypto Pilot Dashboard
              </h1>
            </div>
          )}

          {/* Header - Desktop Only */}
          <div className="hidden sm:flex flex-col gap-4 mb-4 sm:mb-6">
            {/* Desktop and mobile title row */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div className="pl-10">
                <h1 className="text-3xl font-bold crypto-dashboard-title">
                  Crypto Pilot Dashboard
                </h1>
              </div>

              {/* Desktop: Controls on the right */}
              <div className="hidden sm:flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 w-full sm:w-auto">
                <div className="flex items-center gap-2">
                  <div className="text-xs sm:text-sm text-muted-foreground">
                    Last updated: {lastUpdated || "Never"}
                  </div>
                  <div className="group relative">
                    <span
                      className={cn(
                        "inline-block w-3 h-3 rounded-full transition-all duration-300 cursor-help shadow-lg",
                        wsConnected
                          ? "bg-green-500 shadow-green-500/50"
                          : connectionStatus === "connecting"
                            ? "bg-yellow-500 shadow-yellow-500/50 animate-pulse"
                            : "bg-red-500 shadow-red-500/50 animate-ping"
                      )}
                      style={
                        connectionStatus === "connecting"
                          ? {
                            animationDuration: "2s",
                          }
                          : {}
                      }
                      title={
                        wsConnected
                          ? "Real-time data connected"
                          : connectionStatus === "connecting"
                            ? "Connecting to real-time data..."
                            : "Connection lost - data may be outdated"
                      }
                    />
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1 bg-popover text-popover-foreground text-sm rounded-md shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap z-50 border">
                      <div className="font-medium">
                        {wsConnected
                          ? "Connected"
                          : connectionStatus === "connecting"
                            ? "Connecting..."
                            : "Disconnected"}
                      </div>
                      <div className="text-muted-foreground">
                        {wsConnected
                          ? "Real-time market data active"
                          : connectionStatus === "connecting"
                            ? "Establishing connection..."
                            : "Attempting to reconnect..."}
                      </div>
                      <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-popover"></div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={loading}
                  >
                    <RefreshCw className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                    {loading ? "Loading" : "Refresh"}
                  </Button>
                  <ModeToggle />
                </div>
              </div>
            </div>
          </div>
          {error && (
            <Card
              className={cn(
                "mb-4 sm:mb-6 border-red-500",
                isMobile && "mobile-section-padding"
              )}
            >
              <CardContent className="p-2 sm:p-4 text-red-500 text-sm">
                {error}
              </CardContent>
            </Card>
          )}
          {/* Row 1: Portfolio & Bot */}
          <div
            className={cn(
              "grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-4 sm:mb-6",
              isMobile && "mobile-section-padding"
            )}
          >
            {/* Consolidated Portfolio Overview & Value Chart */}
            <Card className="lg:col-span-1">
              <CardHeader className="p-3 sm:p-4 pb-0">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <CardTitle className="text-base sm:text-lg">
                      Portfolio Overview
                    </CardTitle>
                    <p className="mb-2 text-muted-foreground text-sm">
                      {isNewUser
                        ? `Welcome, ${user?.name || "Trader"}!`
                        : `Welcome back, ${user?.name || "Trader"}!`}
                    </p>
                    {/* FreqTrade Connection Status */}
                    <div className="flex items-center gap-2 text-xs">
                      <div
                        className={cn(
                          "w-2 h-2 rounded-full",
                          freqTradeConnected ? "bg-green-500" : "bg-red-500"
                        )}
                      />
                      <span className="text-muted-foreground">
                        {freqTradeConnected
                          ? "FreqTrade Connected"
                          : "FreqTrade Disconnected"}
                      </span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-3 sm:p-4">
                {freqTradePortfolioLoading ? (
                  <InlineLoading
                    message="Loading portfolio..."
                    size="md"
                    className="h-48"
                  />
                ) : hasNoBots ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <Bot className="h-12 w-12 text-muted-foreground/50 mb-3" />
                    <h3 className="text-base font-medium mb-1">No FreqTrade Bots Found</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Create your first trading bot to start tracking portfolio value
                    </p>
                    <Button asChild size="sm">
                      <Link to="/bot-provisioning">
                        <Plus className="h-4 w-4 mr-2" />
                        Create Bot
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Portfolio Stats - Mobile: 2 rows, Desktop: 3-column */}
                    <div className="flex flex-col space-y-2 sm:grid sm:grid-cols-3 sm:gap-4 sm:space-y-0 text-sm">
                      {/* Mobile: First row with Balance and Open Positions side by side */}
                      <div className="grid grid-cols-2 gap-4 sm:block sm:col-span-1">
                        <div className="flex justify-between sm:block">
                          <p className="text-muted-foreground">All Bots Total</p>
                          <p className="text-lg font-semibold sm:mt-1">
                            {freqTradeConnected && freqTradePortfolio ? (
                              <>
                                {formatCurrency(
                                  freqTradePortfolio.totalBalance || 0
                                )}
                                <span className="text-xs text-green-500 block">
                                  Live: {freqTradePortfolio.bots?.length || 0}{" "}
                                  bots
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">
                                Data unavailable
                                <span className="text-xs block">
                                  Connected: {freqTradeConnected ? "Yes" : "No"}
                                </span>
                              </span>
                            )}
                          </p>
                          {freqTradeConnected && (
                            <p className="text-xs text-green-500 mt-1">
                              Live FreqTrade Data
                            </p>
                          )}
                          {!freqTradeConnected && (
                            <p className="text-xs text-muted-foreground mt-1">
                              FreqTrade disconnected
                            </p>
                          )}
                        </div>
                        <div className="sm:hidden">
                          <p className="text-muted-foreground mb-1">
                            Open Positions
                          </p>
                          {!freqTradeConnected ? (
                            <p className="text-xs text-muted-foreground">
                              Data unavailable
                            </p>
                          ) : freqTradeBots?.length > 0 ? (
                            <div className="space-y-1">
                              <div className="flex justify-between text-xs">
                                <span>Live Positions</span>
                                <span>{freqTradeBots.length}</span>
                              </div>
                              <p className="text-xs text-green-500">
                                Live from FreqTrade
                              </p>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              No active trades
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Mobile: Second row with Overall P/L, Desktop: Second column */}
                      <div className="flex justify-between sm:block">
                        <p className="text-muted-foreground">Overall P/L</p>
                        <p
                          className={cn(
                            "text-lg font-semibold sm:mt-1",
                            freqTradeConnected && freqTradePortfolio
                              ? (freqTradePortfolio.totalPnL || 0) >= 0
                                ? "text-green-600"
                                : "text-red-600"
                              : "text-muted-foreground"
                          )}
                        >
                          {freqTradeConnected && freqTradePortfolio ? (
                            <>
                              {(freqTradePortfolio.totalPnL || 0) >= 0
                                ? "+"
                                : ""}
                              {formatCurrency(freqTradePortfolio.totalPnL || 0)}
                              {freqTradePortfolio.profitLossPercentage !== undefined && (
                                <span className={cn(
                                  "text-sm font-normal ml-1.5",
                                  freqTradePortfolio.profitLossPercentage >= 0 ? "text-green-500" : "text-red-500"
                                )}>
                                  ({freqTradePortfolio.profitLossPercentage >= 0 ? "+" : ""}
                                  {freqTradePortfolio.profitLossPercentage.toFixed(2)}%)
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">
                              Data unavailable
                            </span>
                          )}
                        </p>
                      </div>

                      {/* Desktop: Third column - Open Positions */}
                      <div className="hidden sm:block">
                        <div className="flex justify-between items-start sm:block">
                          <p className="text-muted-foreground">
                            Open Positions
                          </p>
                          {!freqTradeConnected ? (
                            <p className="text-sm text-muted-foreground sm:mt-1">
                              Data unavailable
                            </p>
                          ) : freqTradeBots?.length > 0 ? (
                            <div className="text-right sm:text-left sm:mt-1">
                              <div className="space-y-1 sm:space-y-1">
                                <div className="flex justify-between text-xs sm:justify-between">
                                  <span>Live Positions</span>
                                  <span>{freqTradeBots.length}</span>
                                </div>
                                <p className="text-xs text-green-500">
                                  Live from FreqTrade
                                </p>
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground sm:mt-1">
                              No active trades
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Portfolio Value Chart - Mobile: Larger, Desktop: Same */}
                    <div className="border-t pt-2 -mx-3 sm:-mx-4 px-2 sm:px-3">
                      {/* Time frame dropdown above the chart */}
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="text-sm font-medium text-muted-foreground">
                          Portfolio Value
                          <span className="text-xs text-blue-500 ml-2">
                            ({getChartDataWithFallback().length} pts)
                          </span>
                        </h4>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              className={cn(
                                "h-8 flex justify-center items-center",
                                isMobile
                                  ? "w-[40px] text-sm px-1 min-w-0 bg-background text-white dark:text-black"
                                  : "w-auto px-3"
                              )}
                            >
                              <span
                                className={
                                  isMobile
                                    ? "text-sm font-bold text-white dark:text-black"
                                    : ""
                                }
                              >
                                {isMobile
                                  ? portfolioDateRange === "1H"
                                    ? "1H"
                                    : portfolioDateRange === "24H"
                                      ? "24H"
                                      : portfolioDateRange === "7D"
                                        ? "7D"
                                        : portfolioDateRange === "30D"
                                          ? "30D"
                                          : portfolioDateRange
                                  : portfolioDateRange}
                              </span>
                              <ChevronDown
                                className={cn(
                                  "opacity-50 flex-shrink-0",
                                  isMobile ? "h-3 w-3 ml-1" : "h-4 w-4 ml-2"
                                )}
                              />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem
                              onClick={() => {
                                setPortfolioDateRange("1H");
                              }}
                            >
                              1 Hour
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setPortfolioDateRange("24H");
                              }}
                            >
                              24 Hours
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setPortfolioDateRange("7D");
                              }}
                            >
                              7 Days
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setPortfolioDateRange("30D");
                              }}
                            >
                              30 Days
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="w-full h-60 sm:h-62 overflow-hidden rounded-md">
                        {portfolioChartLoading ? (
                          <InlineLoading
                            message="Loading chart data..."
                            size="md"
                            className="h-full"
                          />
                        ) : (
                          <div className="w-full h-full overflow-visible">
                            <Suspense fallback={<InlineLoading message="Loading chart..." size="md" className="h-full" />}>
                              <PortfolioChart
                                key={`portfolio-chart-${portfolioDateRange}-${getChartDataWithFallback().length
                                  }`}
                                data={getChartDataWithFallback()}
                                timeframe={portfolioDateRange}
                                isMobile={isMobile}
                              />
                            </Suspense>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            {/* Bot Status & Strategy */}
            <Card className="lg:col-span-1">
              <CardHeader className="p-3 sm:p-4 pb-0">
                <div className="flex justify-between items-center">
                  <CardTitle className="text-base sm:text-lg">
                    Bot Status & Strategy
                  </CardTitle>
                  {!hasNoBots && selectedBotForStrategy && (
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                      className="h-8 w-8 p-0"
                    >
                      <Link to={`/bot/${selectedBotForStrategy}/config`}>
                        <Settings className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-3 sm:p-4">
                {hasNoBots ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <Bot className="h-12 w-12 text-muted-foreground/50 mb-3" />
                    <h3 className="text-base font-medium mb-1">No Bots Configured</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Provision a trading bot to manage strategies and view performance
                    </p>
                    <Button asChild size="sm">
                      <Link to="/bot-provisioning">
                        <Plus className="h-4 w-4 mr-2" />
                        Create Bot
                      </Link>
                    </Button>
                  </div>
                ) : (
                  /* Mobile-first layout with forced CSS classes */
                  <div className="space-y-4 sm:space-y-3">
                    <div className="bot-section-spacing mobile-dropdown-fix">
                      <Label htmlFor="bot-select" className="text-sm font-medium">
                        Bot Name
                      </Label>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            id="bot-select"
                            variant="outline"
                            className="mt-1 w-full flex justify-between items-center h-9 sm:h-auto mobile-dropdown-trigger"
                          >
                            {selectedBotForStrategy ? (
                              freqTradeBots.find(b => b.instanceId === selectedBotForStrategy)?.instanceId || "Select bot"
                            ) : (
                              "Select bot"
                            )}
                            <ChevronDown className="h-4 w-4 opacity-50" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-[280px] sm:w-[500px] h-auto mobile-dropdown-content"
                        >
                          {freqTradeBots.length > 0 ? (
                            freqTradeBots.map((bot) => (
                              <DropdownMenuItem
                                key={bot.instanceId}
                                onClick={() => {
                                  setSelectedBotForStrategy(bot.instanceId);
                                }}
                              >
                                <div className="flex flex-col items-start">
                                  <span className="font-medium">{bot.instanceId}</span>
                                  <span className="text-xs text-muted-foreground">
                                    Status: {typeof bot.status === 'string' ? bot.status : 'Unknown'}
                                  </span>
                                </div>
                              </DropdownMenuItem>
                            ))
                          ) : (
                            <DropdownMenuItem disabled>
                              No bots available
                            </DropdownMenuItem>
                          )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex items-center gap-3 bot-section-spacing">
                    <div
                      className={cn(
                        "bot-status-indicator w-3 h-3 sm:w-4 sm:h-4 rounded-full shrink-0 flex-shrink-0",
                        (isFreqTradeAvailable && freqTradeBots.length > 0)
                          ? (anyBotRunning ? "bg-green-500" : "bg-red-500")
                          : "bg-gray-500"
                      )}
                    />
                    <p className="text-sm font-medium">
                      Status:{" "}
                      <span
                        className={
                          (isFreqTradeAvailable && freqTradeBots.length > 0)
                            ? (anyBotRunning ? "text-green-600" : "text-red-600")
                            : "text-muted-foreground"
                        }
                      >
                        {isFreqTradeAvailable && freqTradeBots.length > 0
                          ? `${runningBotCount} Active`
                          : "No Bots"}
                      </span>
                    </p>
                    {freqTradeConnected && (
                      <Badge variant="outline" className="text-xs">
                        Live
                      </Badge>
                    )}
                  </div>
                  <div className="bot-section-spacing mobile-dropdown-fix">
                    <Suspense fallback={<div className="h-10 bg-muted/50 animate-pulse rounded" />}>
                      <StrategySelector
                        botInstanceId={selectedBotForStrategy || (freqTradeBots.length > 0 ? freqTradeBots[0]?.instanceId || null : null)}
                        onStrategyChange={(newStrategy, success) => {
                          if (success) {
                            // Strategy changed successfully - trigger bot data refresh
                            setForceUpdate(prev => prev + 1);
                          }
                        }}
                        className="w-full"
                      />
                    </Suspense>
                  </div>
                  <div className="bot-section-spacing">
                    <p className="text-sm font-medium bot-performance-spacing sm:mb-2">
                      Bot Performance
                    </p>
                    <div className="space-y-3 sm:space-y-2">
                      <div>
                        <div className="flex justify-between text-sm sm:text-xs mb-1">
                          <span>Success Rate</span>
                          <span className="font-medium" title={`${botPerformance.winningTrades}W / ${botPerformance.losingTrades}L`}>
                            {botPerformance.successRate}%
                            {botPerformance.totalTrades > 0 && (
                              <span className="text-muted-foreground ml-1 text-xs">
                                ({botPerformance.totalTrades} trades)
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="bot-progress-bar w-full bg-secondary rounded-full h-1.5 sm:h-1 overflow-hidden relative">
                          <div
                            className="bg-primary h-full rounded-full transition-all duration-300 ease-in-out absolute top-0 left-0"
                            style={{ width: `${botPerformance.successRate}%` }}
                          />
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between text-sm sm:text-xs mb-1">
                          <span>Avg. Trades/Day</span>
                          <span className="font-medium">{botPerformance.tradesPerDay}</span>
                        </div>
                        <div className="bot-progress-bar w-full bg-secondary rounded-full h-1.5 sm:h-1 overflow-hidden relative">
                          <div
                            className="bg-primary h-full rounded-full transition-all duration-300 ease-in-out absolute top-0 left-0"
                            style={{
                              width: `${Math.min((botPerformance.tradesPerDay / 20) * 100, 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="pt-4 sm:pt-3">
                    {(() => {
                      const currentBotId = selectedBotForStrategy || (freqTradeBots.length > 0 ? freqTradeBots[0]?.instanceId : null);
                      const currentBot = freqTradeBots.find(b => b.instanceId === currentBotId);
                      const isRunning = currentBot ? isBotRunning(currentBot) : false;
                      const isLoading = currentBotId ? botActionLoading[currentBotId] : null;
                      
                      return (
                        <Button
                          variant={isRunning ? "destructive" : "default"}
                          size="sm"
                          className="w-full"
                          disabled={!!isLoading || !currentBotId}
                          onClick={() => {
                            if (currentBotId) {
                              if (isRunning) {
                                stopBot(currentBotId);
                              } else {
                                startBot(currentBotId);
                              }
                            }
                          }}
                        >
                          {isLoading ? (
                            <>
                              <LoadingSpinner size="sm" className="mr-2" />
                              {isLoading === 'start' ? 'Starting...' : 'Stopping...'}
                            </>
                          ) : (
                            isRunning ? "Stop Bot" : "Start Bot"
                          )}
                        </Button>
                      );
                    })()}
                  </div>
                </div>
                )}
              </CardContent>
            </Card>
          </div>
          {/* Row 2: Ticker/Chart & Top Crypto */}
          <div
            className={cn(
              "grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4",
              isMobile && "mobile-section-padding"
            )}
          >
            {/* Main chart side */}
            <div className="lg:col-span-2">
              {chartData.length > 0 && (
                <Card className="mb-3 sm:mb-4 h-[600px] flex flex-col">
                  <CardHeader className="p-3 sm:p-4 pb-0 flex-shrink-0">
                    <div className="flex flex-col sm:flex-row justify-between gap-2 w-full">
                      <div className="flex flex-col gap-1">
                        <CardTitle className="text-base sm:text-lg">
                          {selectedCurrency}/USD Chart
                        </CardTitle>
                        {cryptoData && (
                          <div className="flex items-center gap-2">
                            <span className="text-sm sm:text-base font-semibold">
                              {formatCurrency(cryptoData.price)}
                            </span>
                            {cryptoData.change24h !== undefined && (
                              <span
                                className={cn(
                                  "text-xs rounded-md px-1.5 py-0.5 font-medium",
                                  cryptoData.change24h >= 0
                                    ? "bg-green-500/10 text-green-600"
                                    : "bg-red-500/10 text-red-600"
                                )}
                              >
                                {cryptoData.change24h >= 0 ? "+" : ""}
                                {cryptoData.change24h.toFixed(2)}%
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-muted-foreground">
                          Last updated: {lastUpdated || "Never"}
                        </span>
                        {zoomState.isZoomed && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleResetZoom}
                            className="text-xs"
                          >
                            Reset Zoom
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="p-2 sm:p-4 flex-1 flex flex-col min-h-0">
                    <div
                      ref={chartContainerRef}
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onMouseLeave={handleMouseLeave}
                      onTouchStart={handleTouchStart}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
                      className="flex-1 min-h-0"
                      style={{
                        width: "100%",
                        touchAction: "none",
                        cursor: panState.isPanning
                          ? "grabbing"
                          : zoomState.isZoomed
                            ? "grab"
                            : "default",
                        userSelect: "none",
                        overflow: "hidden",
                      }}
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={activeChartData}
                          margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="#aaa"
                            opacity={0.2}
                          />
                          <XAxis
                            dataKey="time"
                            tick={{ fontSize: 9 }}
                            domain={zoomState.xDomain}
                            allowDataOverflow
                            interval="preserveStartEnd"
                            minTickGap={15}
                          />
                          <YAxis
                            domain={zoomState.yDomain || ["auto", "auto"]}
                            allowDataOverflow
                            tick={{ fontSize: 9 }}
                            tickFormatter={(val: number) => val.toFixed(0)}
                            width={35}
                          />
                          <Line
                            type="monotone"
                            dataKey="close"
                            stroke="#f7931a"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 6 }}
                            isAnimationActive
                            animationBegin={0}
                            animationDuration={2000}
                            animationEasing="ease-in-out"
                          />
                          <Tooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const data = payload[0].payload;
                                const timestamp = data.timestamp * 1000;
                                const date = new Date(timestamp);
                                const formattedDate = date.toLocaleDateString(
                                  "en-US",
                                  {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                  }
                                );
                                const formattedTime = date.toLocaleTimeString(
                                  "en-US",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }
                                );
                                let priceChangePercent = null;
                                const dataIndex = activeChartData.findIndex(
                                  (item) => item.timestamp === data.timestamp
                                );
                                if (
                                  dataIndex > 0 &&
                                  activeChartData[dataIndex - 1]
                                ) {
                                  const prevClose =
                                    activeChartData[dataIndex - 1].close;
                                  const currentClose = data.close;
                                  priceChangePercent =
                                    ((currentClose - prevClose) / prevClose) *
                                    100;
                                }
                                return (
                                  <div className="bg-background/95 backdrop-blur-sm border rounded shadow-lg p-3 text-xs">
                                    <div className="font-bold mb-1 text-sm">
                                      {selectedCurrency}/USD
                                    </div>
                                    <div className="text-muted-foreground mb-2">
                                      {formattedDate} at {formattedTime}
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                      <div>Price:</div>
                                      <div className="text-right font-medium">
                                        {formatCurrency(data.close)}
                                      </div>
                                      {data.open !== undefined && (
                                        <>
                                          <div>Open:</div>
                                          <div className="text-right">
                                            {formatCurrency(data.open)}
                                          </div>
                                        </>
                                      )}
                                      {data.high !== undefined && (
                                        <>
                                          <div>High:</div>
                                          <div className="text-right">
                                            {formatCurrency(data.high)}
                                          </div>
                                        </>
                                      )}
                                      {data.low !== undefined && (
                                        <>
                                          <div>Low:</div>
                                          <div className="text-right">
                                            {formatCurrency(data.low)}
                                          </div>
                                        </>
                                      )}
                                      {priceChangePercent !== null && (
                                        <>
                                          <div>Change:</div>
                                          <div
                                            className={`text-right ${priceChangePercent >= 0
                                              ? "text-green-600"
                                              : "text-red-600"
                                              }`}
                                          >
                                            {priceChangePercent >= 0 ? "+" : ""}
                                            {priceChangePercent.toFixed(2)}%
                                          </div>
                                        </>
                                      )}
                                      {data.volume !== undefined && (
                                        <>
                                          <div>Volume:</div>
                                          <div className="text-right">
                                            {formatCurrency(data.volume, true)}
                                          </div>
                                        </>
                                      )}
                                      {data.isMinuteData && (
                                        <div className="col-span-2 mt-1 text-[10px] text-muted-foreground">
                                          Minute resolution data
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          {isLoadingMinuteData && (
                            <text
                              x="50%"
                              y="50%"
                              textAnchor="middle"
                              fill="currentColor"
                              dy=".3em"
                              fontSize="14"
                              fontWeight="bold"
                            >
                              Loading minute data...
                            </text>
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                  <CardFooter className="border-t p-2 sm:p-4 flex-shrink-0">
                    <div className="w-full">
                      <p className="text-[10px] sm:text-xs text-muted-foreground mb-1 sm:mb-2">
                        Data from Binance & CoinGecko API; live updates from
                        Binance WebSocket.
                      </p>
                    </div>
                  </CardFooter>
                </Card>
              )}
            </div>
            {/* Cryptocurrencies with Search and Pagination */}
            <div className="lg:col-span-1 lg:col-start-3">
              <Card
                className={cn(
                  "flex flex-col",
                  isMobile ? "h-[550px]" : "h-[600px]"
                )}
              >
                <CardHeader
                  className={cn(
                    "flex-shrink-0 border-b bg-card/50",
                    isMobile ? "p-2 pb-2" : "p-4 pb-2"
                  )}
                >
                  <CardTitle
                    className={cn(
                      "mb-2",
                      isMobile
                        ? "text-base font-semibold"
                        : "text-base sm:text-lg"
                    )}
                  >
                    Cryptocurrencies
                  </CardTitle>
                  {/* Mobile-optimized Search Bar */}
                  <div className="relative">
                    <Search
                      className={cn(
                        "absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground",
                        isMobile ? "h-3 w-3" : "h-3 w-3"
                      )}
                    />
                    <Input
                      type="text"
                      placeholder="Search currencies..."
                      value={searchTerm}
                      onChange={(e) => handleSearch(e.target.value)}
                      className={cn(
                        "border-2 focus:border-primary transition-colors",
                        isMobile
                          ? "h-9 text-sm pl-9 rounded-md"
                          : "text-xs h-8 pl-8"
                      )}
                    />
                  </div>
                </CardHeader>
                <CardContent className="p-0 flex-1 flex flex-col min-h-0 overflow-hidden">
                  {/* Mobile-optimized Table Container */}
                  <div
                    className={cn("flex-1 overflow-auto", isMobile && "px-2")}
                  >
                    <Table className="w-full">
                      <TableHeader className="sticky top-0 bg-background/95 backdrop-blur-sm z-10 border-b">
                        <TableRow className="hover:bg-transparent">
                          <TableHead
                            className={cn(
                              "font-semibold text-foreground",
                              isMobile
                                ? "text-xs py-2 px-2 w-[70px]"
                                : "w-[60px] text-xs p-2"
                            )}
                          >
                            Symbol
                          </TableHead>
                          <TableHead
                            className={cn(
                              "text-right font-semibold text-foreground",
                              isMobile
                                ? "text-xs py-2 px-2"
                                : "text-right text-xs p-2"
                            )}
                          >
                            Price
                          </TableHead>
                          <TableHead
                            className={cn(
                              "text-right font-semibold text-foreground hidden sm:table-cell",
                              isMobile
                                ? "text-xs py-2 px-2"
                                : "text-right text-xs p-2"
                            )}
                          >
                            Market Cap
                          </TableHead>
                          <TableHead
                            className={cn(
                              "text-right font-semibold text-foreground",
                              isMobile
                                ? "text-xs py-2 px-2 w-[60px]"
                                : "text-right text-xs p-2"
                            )}
                          >
                            24h
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {isLoadingCurrencies ? (
                          <TableRow>
                            <TableCell
                              colSpan={isMobile ? 3 : 4}
                              className={cn(
                                "text-center h-[200px]",
                                isMobile ? "text-sm" : "text-center text-xs"
                              )}
                            >
                              <InlineLoading
                                message="Loading market data..."
                                size="sm"
                              />
                            </TableCell>
                          </TableRow>
                        ) : displayedCurrencies.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={isMobile ? 3 : 4}
                              className={cn(
                                "text-center h-[200px] text-muted-foreground",
                                isMobile ? "text-sm" : "text-center text-xs"
                              )}
                            >
                              {searchTerm
                                ? "No currencies found"
                                : "No data available"}
                            </TableCell>
                          </TableRow>
                        ) : (
                          displayedCurrencies.map((currency) => (
                            <TableRow
                              key={currency.symbol}
                              className={cn(
                                "cursor-pointer hover:bg-muted/50 transition-colors border-b",
                                selectedCurrency === currency.symbol &&
                                "bg-muted/30",
                                isMobile ? "h-14" : "h-12 sm:h-auto"
                              )}
                              onClick={() =>
                                handleCurrencySelect(currency.symbol)
                              }
                            >
                              <TableCell
                                className={cn(
                                  "font-medium",
                                  isMobile
                                    ? "py-2 px-2"
                                    : "font-medium text-xs p-2"
                                )}
                              >
                                <div className="flex flex-col">
                                  <span
                                    className={cn(
                                      "font-semibold",
                                      isMobile
                                        ? "text-xs leading-tight"
                                        : "text-xs"
                                    )}
                                  >
                                    {currency.symbol}
                                  </span>
                                  <span
                                    className={cn(
                                      "text-muted-foreground truncate leading-tight",
                                      isMobile
                                        ? "text-[10px] max-w-[55px]"
                                        : "text-[10px] max-w-[50px]"
                                    )}
                                  >
                                    {currency.name}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right",
                                  isMobile
                                    ? "py-2 px-2"
                                    : "text-right text-xs p-2"
                                )}
                              >
                                <span
                                  className={cn(
                                    "font-medium",
                                    isMobile ? "text-xs" : ""
                                  )}
                                >
                                  {formatCurrency(currency.price)}
                                </span>
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right hidden sm:table-cell",
                                  isMobile
                                    ? "py-2 px-2"
                                    : "text-right text-xs p-2"
                                )}
                              >
                                <span
                                  className={cn(
                                    "text-muted-foreground",
                                    isMobile ? "text-xs" : ""
                                  )}
                                >
                                  {formatCurrency(currency.marketCap, true)}
                                </span>
                              </TableCell>
                              <TableCell
                                className={cn(
                                  "text-right",
                                  isMobile
                                    ? "py-2 px-2"
                                    : "text-right text-xs p-2"
                                )}
                              >
                                <div className="flex items-center justify-end gap-1">
                                  {currency.change24h > 0 ? (
                                    <ArrowUp
                                      className={cn(
                                        "text-green-500",
                                        isMobile ? "h-3 w-3" : "h-3 w-3"
                                      )}
                                    />
                                  ) : (
                                    <ArrowDown
                                      className={cn(
                                        "text-red-400",
                                        isMobile ? "h-3 w-3" : "h-3 w-3"
                                      )}
                                    />
                                  )}
                                  <Badge
                                    variant={
                                      currency.change24h > 0
                                        ? "success"
                                        : "destructive"
                                    }
                                    className={cn(
                                      currency.change24h < 0 &&
                                      "bg-red-500/10 text-red-400 dark:text-red-400 dark:bg-red-500/20",
                                      isMobile
                                        ? "text-[9px] px-1 py-0"
                                        : "text-[10px] px-1 py-0"
                                    )}
                                  >
                                    {Math.abs(currency.change24h).toFixed(1)}%
                                  </Badge>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
                {/* Responsive Pagination */}
                <CardFooter
                  className={cn(
                    "flex-shrink-0 border-t bg-card/50",
                    isMobile ? "p-2" : "p-3 sm:p-2"
                  )}
                >
                  {/* Mobile Layout Only - Optimized for touch */}
                  <div className="block sm:hidden w-full">
                    <div className="space-y-2">
                      {/* Top row: Navigation with compact spacing */}
                      <div className="flex items-center justify-between w-full gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePageChange(currentPage - 1)}
                          disabled={currentPage === 1}
                          className="h-7 px-2 min-w-[50px] flex items-center gap-1 text-xs"
                        >
                          <ChevronLeft className="h-3 w-3" />
                          <span>Prev</span>
                        </Button>

                        <div className="flex items-center justify-center min-w-[40px] px-2 py-1 bg-muted/30 rounded text-xs font-semibold">
                          {currentPage}/{totalPages}
                        </div>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePageChange(currentPage + 1)}
                          disabled={currentPage === totalPages}
                          className="h-7 px-2 min-w-[50px] flex items-center gap-1 text-xs"
                        >
                          <span>Next</span>
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                      </div>

                      {/* Bottom row: Controls with compact spacing */}
                      <div className="flex items-center justify-between w-full gap-2">
                        <div className="flex items-center">
                          <span
                            className="text-xs text-foreground bg-muted/30 rounded px-2 py-1 min-w-[24px] text-center cursor-pointer hover:bg-muted/50 transition-colors border border-muted"
                            onClick={() => {
                              const options = [5, 10, 25, 50];
                              const currentIndex = options.indexOf(rowsPerPage);
                              const nextIndex =
                                (currentIndex + 1) % options.length;
                              handleRowsPerPageChange(
                                options[nextIndex].toString()
                              );
                            }}
                            title="Click to cycle through page sizes"
                          >
                            {rowsPerPage}
                          </span>
                        </div>

                        <div className="text-xs text-muted-foreground text-right">
                          <div className="leading-tight">
                            {startIndex + 1}-
                            {Math.min(endIndex, filteredCurrencies.length)}
                          </div>
                          <div className="text-[10px] leading-tight">
                            of {filteredCurrencies.length}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Desktop Layout Only */}
                  <div className="hidden sm:block w-full">
                    <div className="flex items-center justify-between w-full">
                      {/* Left: Rows per page */}
                      <div className="flex items-center gap-2 text-sm">
                        <span>Rows per page:</span>
                        <Select
                          value={rowsPerPage.toString()}
                          onValueChange={handleRowsPerPageChange}
                        >
                          <SelectTrigger className="h-8 w-20 px-3">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CURRENCIES_PER_PAGE_OPTIONS.map((option) => (
                              <SelectItem
                                key={option}
                                value={option.toString()}
                              >
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Right: Info and Navigation */}
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-muted-foreground">
                          {(currentPage - 1) * rowsPerPage + 1}-
                          {Math.min(
                            currentPage * rowsPerPage,
                            allCurrencies.length
                          )}{" "}
                          of {allCurrencies.length}
                        </span>

                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(1)}
                            disabled={currentPage === 1}
                            className="h-8 w-8 p-0"
                            title="First page"
                          >
                            <ChevronLeft className="h-4 w-4" />
                            <ChevronLeft className="h-4 w-4 -ml-1" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(currentPage - 1)}
                            disabled={currentPage === 1}
                            className="h-8 w-8 p-0"
                            title="Previous page"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(currentPage + 1)}
                            disabled={currentPage === totalPages}
                            className="h-8 w-8 p-0"
                            title="Next page"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePageChange(totalPages)}
                            disabled={currentPage === totalPages}
                            className="h-8 w-8 p-0"
                            title="Last page"
                          >
                            <ChevronRight className="h-4 w-4" />
                            <ChevronRight className="h-4 w-4 -ml-1" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </CardFooter>
              </Card>
            </div>
          </div>
          {/* Row 3: Live Trading Positions, Trade History, News/Tips */}
          <div
            className={cn(
              "grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mt-4",
              isMobile && "mobile-section-padding"
            )}
          >
            {/* LEFT COLUMN: Live Trading Positions + Trade History */}
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader className="p-3 sm:p-4 pb-0">
                  <CardTitle className="text-base sm:text-lg">
                    Live Trading Positions
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table className="w-full">
                      <TableHeader className="sticky top-0 bg-background z-10">
                        <TableRow>
                          <TableHead className="text-xs whitespace-nowrap">
                            Bot
                          </TableHead>
                          <TableHead className="text-xs whitespace-nowrap">
                            Pair
                          </TableHead>
                          <TableHead className="text-xs whitespace-nowrap">
                            Side
                          </TableHead>
                          <TableHead className="text-xs text-right whitespace-nowrap">
                            Amount
                          </TableHead>
                          <TableHead className="text-xs text-right whitespace-nowrap">
                            Entry Price
                          </TableHead>
                          <TableHead className="text-xs text-right whitespace-nowrap">
                            Current Price 📈
                          </TableHead>
                          <TableHead className="text-xs text-right whitespace-nowrap">
                            Live P&L 💰
                          </TableHead>
                          <TableHead className="text-xs text-right whitespace-nowrap">
                            P&L %
                          </TableHead>
                          <TableHead className="text-xs text-center whitespace-nowrap">
                            Mode
                          </TableHead>
                          <TableHead className="text-xs text-center whitespace-nowrap">
                            Last Change
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                    </Table>
                    <div className="max-h-[200px] overflow-y-auto">
                      <Table className="w-full">
                        <TableBody>
                          <Suspense fallback={<TableRow><TableCell colSpan={8}><InlineLoading message="Loading positions..." size="sm" /></TableCell></TableRow>}>
                            <PositionsTable
                              isConnected={freqTradeConnected}
                            />
                          </Suspense>
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-3 sm:p-4 pb-0">
                  <CardTitle className="text-base sm:text-lg flex items-center gap-2">
                    Trade History
                    {freqTradeConnected && (
                      <Badge variant="outline" className="text-xs">
                        Live
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="max-h-[300px] overflow-y-auto">
                    <Table className="w-full">
                      <TableHeader className="sticky top-0 bg-background z-10">
                        <TableRow>
                          <TableHead className="text-xs">Pair</TableHead>
                          <TableHead className="text-xs">Side</TableHead>
                          <TableHead className="text-xs text-right">Profit</TableHead>
                          <TableHead className="text-xs text-right">Date</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tradesLoading ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center py-4">
                              <div className="flex items-center justify-center gap-2">
                                <RefreshCw className="h-4 w-4 animate-spin" />
                                <span className="text-sm text-muted-foreground">Loading trades...</span>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : freqTradeTrades.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                              No trade history yet
                            </TableCell>
                          </TableRow>
                        ) : (
                          freqTradeTrades.slice(0, 50).map((trade, index) => (
                            <TableRow key={trade.id || index}>
                              <TableCell className="text-xs font-medium">
                                {trade.pair || trade.symbol || 'N/A'}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-xs",
                                    trade.side === 'buy' || trade.type === 'buy'
                                      ? "bg-green-500/10 text-green-500 border-green-500/20"
                                      : "bg-red-500/10 text-red-500 border-red-500/20"
                                  )}
                                >
                                  {trade.side || trade.type || 'N/A'}
                                </Badge>
                              </TableCell>
                              <TableCell className={cn(
                                "text-xs text-right font-medium",
                                (trade.profit || trade.pnl || 0) >= 0 ? "text-green-500" : "text-red-500"
                              )}>
                                {(trade.profit || trade.pnl || 0) >= 0 ? '+' : ''}{(trade.profit || trade.pnl || 0).toFixed(2)}
                              </TableCell>
                              <TableCell className="text-xs text-right text-muted-foreground">
                                {trade.closeDate || trade.timestamp
                                  ? new Date(trade.closeDate || trade.timestamp).toLocaleDateString([], {
                                      month: 'short',
                                      day: 'numeric',
                                      hour: '2-digit',
                                      minute: '2-digit'
                                    })
                                  : 'N/A'}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
            {/* RIGHT COLUMN: News/Tips */}
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader className="p-3 sm:p-4 pb-0">
                  <CardTitle className="text-base sm:text-lg">
                    News & Tips
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 sm:p-4">
                  {loadingNews ? (
                    <div className="flex justify-center items-center h-[100px]">
                      <p className="text-sm text-muted-foreground">
                        Loading news...
                      </p>
                    </div>
                  ) : newsItems.length === 0 ? (
                    <p className="text-xs">No news items available</p>
                  ) : (
                    <div className="h-[250px] sm:h-[300px] overflow-y-auto pr-1 scrollbar-thin">
                      <ul className="list-none text-xs sm:text-sm space-y-4">
                        {newsItems.map((item) => (
                          <li
                            key={item.id}
                            className="border-b pb-3 last:border-b-0"
                          >
                            <div className="flex gap-2">
                              {item.imageUrl && (
                                <div className="hidden sm:block flex-shrink-0">
                                  <img
                                    src={item.imageUrl}
                                    alt={item.title}
                                    className="h-12 w-12 rounded object-cover"
                                  />
                                </div>
                              )}
                              <div>
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-semibold mb-1 hover:text-primary transition-colors"
                                >
                                  {item.title}
                                </a>
                                <p className="text-muted-foreground text-xs mt-1">
                                  {item.snippet}
                                </p>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                  {item.source} · {item.publishedAt}
                                </div>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
        {/* Footer / Disclaimer */}
        <div
          className={cn(
            "mt-6 text-xs text-muted-foreground",
            isMobile && "mobile-footer"
          )}
        >
          <p>
            Disclaimer: This is a paper-trading bot dashboard for demonstration
            only. It does not constitute financial advice. Always do your own
            research.
          </p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
