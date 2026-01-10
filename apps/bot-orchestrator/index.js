const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const fs = require('fs-extra'); // Use fs-extra for ensureDir etc.
const path = require('path');
const dotenv = require('dotenv');
const util = require('util');
const execPromise = util.promisify(exec);

// ----------------------------------------------------------------------
// DEPLOYMENT WARNING:
// 1. This app MUST run on PORT 5000 in production.
// 2. Do NOT add CORS headers in Nginx (this app handles CORS).
// 3. See DEPLOYMENT.md for systemd setup (No quotes in env vars!).
// ----------------------------------------------------------------------

// IMPORTANT: Load environment variables BEFORE any module that uses them
dotenv.config({ path: path.join(__dirname, '.env') });

const { formatDbUrl } = require('./lib/urlFormatter');
const { URL } = require('url');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch'); // Added for FreqTrade API proxy functionality
const UniversalRiskManager = require('./universal-risk-manager');
const { UniversalFeatures, DEFAULT_FEATURES } = require('./universal-features');
const { ActiveTradeMonitor, getMonitor } = require('./active-trade-monitor');
const { apiInterceptor } = require('./freqtrade-api-interceptor');
const { universalStakeOverride } = require('./universal-stake-override');
// Cache FreqTrade JWTs per bot to avoid re-auth on every proxied call
const freqtradeTokenCache = new Map();

// ======================================================================
// PHASE 2: Multi-Tenant Container Pool System
// ======================================================================
const {
  initPoolSystem,
  shutdownPoolSystem,
  poolProvisioner,
  getPoolAwareBotUrl,
  isInstancePooled,
  getPoolComponents,
  POOL_MODE_ENABLED
} = require('./lib/pool-integration');

// Pool system initialization flag
let poolSystemInitialized = false;

/**
 * Clean up orphaned bots for a specific user
 * Removes bots that exist in state but not in supervisor/filesystem
 */
async function cleanupUserOrphanedBots(userId) {
  const results = {
    checkedBots: 0,
    removedBots: 0,
    removedFromState: [],
    removedFromFilesystem: [],
    errors: []
  };

  try {
    if (!poolSystemInitialized) {
      return results;
    }

    const { poolManager } = getPoolComponents();
    
    // Get all bots mapped to this user's pools
    const userPools = [];
    for (const [poolId, pool] of poolManager.pools) {
      if (pool.userId === userId) {
        userPools.push(pool);
      }
    }

    // Check each bot in user's pools
    for (const pool of userPools) {
      for (const botId of [...pool.bots]) {
        results.checkedBots++;
        
        try {
          // Check if bot is actually running in supervisor
          const { stdout: status } = await execPromise(
            `docker exec ${pool.containerName} supervisorctl status bot-${botId} 2>/dev/null || echo "NOT_FOUND"`
          ).catch(() => ({ stdout: 'NOT_FOUND' }));

          const isOrphaned = status.includes('NOT_FOUND') || status.includes('no such process');
          
          if (isOrphaned) {
            console.log(`[Cleanup] Found orphaned bot ${botId} in pool ${pool.id}`);
            
            // Remove from pool state
            pool.bots = pool.bots.filter(id => id !== botId);
            poolManager.botMapping.delete(botId);
            results.removedFromState.push(botId);
            
            // Clean up bot directory in pool
            const botConfigDir = path.join(pool.poolDir, 'bots', botId);
            if (await fs.pathExists(botConfigDir)) {
              await fs.remove(botConfigDir);
              results.removedFromFilesystem.push(botId);
            }
            
            // Remove supervisor config if exists
            try {
              await runDockerCommand(['exec', pool.containerName, 'rm', '-f', `/etc/supervisor/conf.d/bot-${botId}.conf`]);
            } catch (e) { /* ignore */ }
            
            results.removedBots++;
          }
        } catch (checkErr) {
          results.errors.push({ botId, error: checkErr.message });
        }
      }
    }

    // Also check user's filesystem for orphaned directories
    const userDir = path.join(BOT_BASE_DIR, userId);
    if (await fs.pathExists(userDir)) {
      const entries = await fs.readdir(userDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const instanceId = entry.name;
        
        // Skip if bot is tracked in pool state
        if (poolManager.botMapping.has(instanceId)) continue;
        
        // Check if this looks like a bot directory with no running process
        const configPath = path.join(userDir, instanceId, 'config.json');
        if (await fs.pathExists(configPath)) {
          // Check if there's a container for this bot
          const containerName = `freqtrade-${instanceId}`;
          const { stdout } = await execPromise(
            `docker ps -q -f name=${containerName}`
          ).catch(() => ({ stdout: '' }));
          
          if (!stdout.trim()) {
            console.log(`[Cleanup] Found orphaned legacy bot directory: ${instanceId}`);
            // Don't auto-delete filesystem, just report
            results.removedFromState.push(`legacy:${instanceId}`);
          }
        }
      }
    }

    // Save updated state
    if (results.removedBots > 0) {
      await poolManager._saveState();
    }

  } catch (err) {
    results.errors.push({ error: err.message });
  }

  return results;
}

// Turso CLI command (allow overriding via env if path differs)
const TURSO_CMD = process.env.TURSO_CMD || 'turso';
// Log which Turso CLI binary will be used
console.log(`Using TURSO_CMD: ${TURSO_CMD}`);

// Portfolio snapshot throttling - track last save time per user
const userLastSnapshotTime = new Map();
const savingInProgress = new Map(); // Track concurrent saves per user

// Turso configuration: API key, organization, and region for remote SQLite DB
const TURSO_API_KEY = process.env.TURSO_API_KEY;
const TURSO_ORG = process.env.TURSO_ORG;
const TURSO_REGION = process.env.TURSO_REGION || 'us-east-1';

// Global reference to portfolio monitor for tracking bot creation
let globalPortfolioMonitor = null;

// Set portfolio monitor reference (to be called by portfolio monitor service)
function setPortfolioMonitor(monitor) {
  globalPortfolioMonitor = monitor;
  console.log('✓ Portfolio monitor reference set for bot tracking');
}

// Global variable for Firebase initialization status
let firebaseInitialized = false;

// Initialize Firebase Admin SDK with service account
try {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    // Load the service account file directly instead of using require
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized with service account");
    firebaseInitialized = true;
  } else {
    console.warn("Service account file not found at:", serviceAccountPath);
    firebaseInitialized = false;
  }
} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK:", error);
  firebaseInitialized = false;
}

// Now import authentication middlewares after Firebase initialization
const { authenticateToken, authorize, checkInstanceOwnership } = require('./auth');

// Add JWKS client for Firebase token verification without Admin SDK
const jwksRsa = require('jwks-rsa');
const firebaseJwksClient = jwksRsa({
  jwksUri: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  cache: true,
  cacheMaxEntries: 10,
  cacheMaxAge: 24 * 60 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10
});

async function verifyFirebaseIdTokenWithoutAdmin(token) {
  try {
    const decodedHeader = jwt.decode(token, { complete: true });
    const kid = decodedHeader?.header?.kid;
    if (!kid) throw new Error('Missing kid in token header');

    const key = await firebaseJwksClient.getSigningKeyAsync(kid);
    const publicKey = key.getPublicKey();

    // Prefer configured project id, else fall back to token aud
    const prelimPayload = jwt.decode(token);
    const projectId = process.env.FIREBASE_PROJECT_ID || prelimPayload?.aud;
    if (!projectId) throw new Error('Unknown Firebase projectId (set FIREBASE_PROJECT_ID)');
    const issuer = `https://securetoken.google.com/${projectId}`;

    const verified = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer
    });

    return {
      id: verified.user_id || verified.uid || verified.sub,
      uid: verified.user_id || verified.uid || verified.sub,
      email: verified.email,
      role: verified.admin ? 'admin' : 'user'
    };
  } catch (err) {
    console.warn(`[Auth] Firebase JWKS verification failed: ${err.message}`);
    return null;
  }
}

// --- Constants ---
const PORT = parseInt(process.env.PORT, 10) || 5000; // Use PORT from .env, default to 5000

// Detect if running in WSL and accessing Windows files
const isWSL = process.platform === 'linux' && process.env.WSL_DISTRO_NAME;
const isWindows = process.platform === 'win32';

// Use explicit path resolution - prefer env var, then relative path
// CRITICAL: Use path.resolve() to get ABSOLUTE paths - Docker on Windows fails with relative paths
let BOT_BASE_DIR;
if (process.env.BOT_BASE_DIR) {
  BOT_BASE_DIR = path.resolve(process.env.BOT_BASE_DIR);
} else {
  // Default to data/bot-instances relative to project root - MUST be absolute for Docker
  BOT_BASE_DIR = path.resolve(__dirname, '../../data/bot-instances');
}
console.log('[Config] BOT_BASE_DIR (absolute):', BOT_BASE_DIR);
console.log('[Config] Platform:', process.platform, 'isWSL:', isWSL);
const FREQTRADE_IMAGE = 'freqtradeorg/freqtrade:stable'; // Always use stable FreqTrade image for local SQLite
console.log(`Using FREQTRADE_IMAGE: ${FREQTRADE_IMAGE}`);
console.log(`CRITICAL: All new bots will use the stable image with local SQLite DB: ${FREQTRADE_IMAGE}`);
// Shared strategies dir (used ONLY for fallback default strategy creation if main source is empty/missing)
// CRITICAL: All paths must be absolute for Docker on Windows
const STRATEGIES_DIR = path.resolve(process.env.STRATEGIES_DIR || path.join(__dirname, 'freqtrade-shared', 'strategies'));
// Main source directory on HOST where strategies are copied FROM during provisioning
const MAIN_STRATEGIES_SOURCE_DIR = path.resolve(process.env.MAIN_STRATEGIES_SOURCE_DIR || path.join(__dirname, '../../data/strategies'));
// SHARED data directory on HOST where historical data resides (must be managed separately)
const SHARED_DATA_DIR = path.resolve(process.env.SHARED_DATA_DIR || path.join(__dirname, '../../data/shared-market-data'));

// --- Queue System for Provisioning ---
const provisioningQueue = [];
let isProvisioning = false;

// --- Create Express App ---
const app = express();

// Configure Express to trust proxy headers for rate limiting (localhost + nginx only)
app.set('trust proxy', 'loopback');

// --- Middleware ---
// Apply Helmet security headers with enhanced CSP for API access
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for test client
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers
      styleSrc: ["'self'", "https:", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'", "https://api.crypto-pilot.dev", "wss://api.crypto-pilot.dev"], // Allow EventSource, API, and WebSocket connections
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// Configure global rate limiter
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per 15-minute window (more reasonable for API usage)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    message: "Too many requests, please try again later."
  }
});

// Apply global rate limiter to all requests except critical endpoints
app.use((req, res, next) => {
  // Skip rate limiting for critical endpoints that need frequent access
  const exemptPaths = [
    '/api/stream',           // SSE streaming endpoint
    '/api/verify-token',     // Token verification
    '/api/bots',             // Bot listing (needed for dashboard)
    '/api/portfolio/history', // Portfolio history (needed for charts)
    '/api/charts/portfolio',  // Portfolio charts
    '/api/strategies'         // Strategy management endpoints
  ];

  if (exemptPaths.some(path => req.path.startsWith(path))) {
    return next();
  }

  // Apply rate limiting to other endpoints
  return globalLimiter(req, res, next);
});

// Additional strict rate limiter for token verification endpoint
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 verify attempts per 15-minute window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many token verification attempts, please try again later."
  }
});

// Implement proper CORS with allowed origins from environment variable
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
    'https://crypto-pilot.dev',
    'https://www.crypto-pilot.dev',
    'https://api.crypto-pilot.dev'
  ];

console.log('🌐 CORS allowed origins:', allowedOrigins);

// CORS enabled for local development (disable when using Nginx proxy in production)
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman, etc)
    if (!origin) {
      console.log('🌐 CORS: Allowing request with no origin (direct API call)');
      return callback(null, true);
    }

    console.log(`🌐 CORS: Checking origin: ${origin}`);

    if (allowedOrigins.indexOf(origin) !== -1) {
      console.log(`✅ CORS: Origin ${origin} allowed`);
      callback(null, true);
    } else {
      console.warn(`❌ CORS: Policy violation from origin: ${origin}`);
      console.warn(`   Allowed origins: ${allowedOrigins.join(', ')}`);
      callback(new Error('CORS policy violation'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200 // For legacy browser support
}));
// Handle OPTIONS manually in case Nginx passes them through
// Handle OPTIONS manually using middleware (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json()); // Parse JSON request bodies

// Serve static files from tests directory
app.use('/tests', express.static(path.join(__dirname, 'tests')));

// Healthcheck endpoints
function healthPayload() {
  return {
    ok: true,
    status: 'ok',
    service: 'bot-manager',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
}
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json(healthPayload());
});
app.head('/health', (req, res) => res.status(200).end());
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json(healthPayload());
});
app.head('/api/health', (req, res) => res.status(200).end());

// ======================================================================
// PHASE 2: Container Pool Management API
// ======================================================================

// Get pool system status
app.get('/api/pool/status', authenticateToken, authorize(['admin']), async (req, res) => {
  try {
    if (!poolSystemInitialized) {
      return res.json({
        success: true,
        poolMode: false,
        message: 'Pool mode is disabled or not initialized',
        legacyMode: true
      });
    }
    
    const stats = poolProvisioner.getPoolStats();
    res.json({
      success: true,
      poolMode: true,
      ...stats
    });
  } catch (err) {
    console.error('[Pool API] Error getting pool status:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// User-specific health check (checks only user's pools)
app.post('/api/pool/my-health-check', authenticateToken, async (req, res) => {
  try {
    if (!poolSystemInitialized) {
      return res.status(400).json({
        success: false,
        error: 'Pool system not initialized'
      });
    }

    const userId = req.user.uid;
    const results = await poolProvisioner.runHealthCheck(userId);
    res.json({
      success: true,
      ...results
    });
  } catch (err) {
    console.error('[Pool API] Error running health check:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manually trigger health check (admin only - all pools)
app.post('/api/pool/health-check', authenticateToken, authorize(['admin']), async (req, res) => {
  try {
    if (!poolSystemInitialized) {
      return res.status(400).json({
        success: false,
        error: 'Pool system not initialized'
      });
    }

    const results = await poolProvisioner.runHealthCheck();
    res.json({
      success: true,
      ...results
    });
  } catch (err) {
    console.error('[Pool API] Error running health check:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clean up user's own orphaned bots (user-accessible)
app.post('/api/pool/my-cleanup', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.uid || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }

    if (!poolSystemInitialized) {
      return res.status(400).json({
        success: false,
        error: 'Pool system not initialized'
      });
    }

    console.log(`[Pool API] User ${userId} requesting cleanup of their orphaned bots`);

    // Get user's bots and clean up orphaned ones
    const cleanupResults = await cleanupUserOrphanedBots(userId);
    
    res.json({
      success: true,
      userId,
      ...cleanupResults,
      message: `Cleaned up ${cleanupResults.removedBots || 0} orphaned bots`
    });
  } catch (err) {
    console.error('[Pool API] Error cleaning up user bots:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clean up empty pools (admin only)
app.post('/api/pool/cleanup', authenticateToken, authorize(['admin']), async (req, res) => {
  try {
    if (!poolSystemInitialized) {
      return res.status(400).json({
        success: false,
        error: 'Pool system not initialized'
      });
    }

    // Also sync state first to find orphaned bots
    const syncResults = await poolProvisioner.syncPoolState();
    const removedCount = await poolProvisioner.cleanupEmptyPools();
    
    res.json({
      success: true,
      removedPools: removedCount,
      syncResults,
      message: `Synced state and cleaned up ${removedCount} empty pool containers`
    });
  } catch (err) {
    console.error('[Pool API] Error cleaning up pools:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync pool state with reality (admin only)
app.post('/api/pool/sync', authenticateToken, authorize(['admin']), async (req, res) => {
  try {
    if (!poolSystemInitialized) {
      return res.status(400).json({
        success: false,
        error: 'Pool system not initialized'
      });
    }

    const syncResults = await poolProvisioner.syncPoolState();
    res.json({
      success: true,
      ...syncResults
    });
  } catch (err) {
    console.error('[Pool API] Error syncing pool state:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get bot's pool assignment
app.get('/api/pool/bot/:instanceId', authenticateToken, async (req, res) => {
  try {
    const { instanceId } = req.params;

    if (!poolSystemInitialized) {
      return res.json({
        success: true,
        instanceId,
        isPooled: false,
        mode: 'legacy'
      });
    }

    const isPooled = isInstancePooled(instanceId);

    if (isPooled) {
      const connection = await poolProvisioner.getBotConnection(instanceId);
      res.json({
        success: true,
        instanceId,
        isPooled: true,
        mode: 'pooled',
        connection
      });
    } else {
      res.json({
        success: true,
        instanceId,
        isPooled: false,
        mode: 'legacy'
      });
    }
  } catch (err) {
    console.error('[Pool API] Error getting bot pool info:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get user's pool statistics (user-specific pools)
app.get('/api/pool/user/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserId = req.user.uid || req.user.id;
    
    // Users can only view their own pools unless they're admin
    if (requestingUserId !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Can only view your own pool statistics'
      });
    }
    
    if (!poolSystemInitialized) {
      return res.json({
        success: true,
        userId,
        poolMode: false,
        message: 'Pool mode is disabled',
        totalPools: 0,
        totalBots: 0,
        pools: []
      });
    }
    
    const stats = poolProvisioner.getUserPoolStats(userId);
    res.json({
      success: true,
      poolMode: true,
      ...stats
    });
  } catch (err) {
    console.error('[Pool API] Error getting user pool stats:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get current user's pool statistics (convenience endpoint)
app.get('/api/pool/my-pools', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.uid || req.user.id;
    
    if (!poolSystemInitialized) {
      return res.json({
        success: true,
        userId,
        poolMode: false,
        message: 'Pool mode is disabled',
        totalPools: 0,
        totalBots: 0,
        pools: []
      });
    }
    
    const stats = poolProvisioner.getUserPoolStats(userId);
    res.json({
      success: true,
      poolMode: true,
      ...stats
    });
  } catch (err) {
    console.error('[Pool API] Error getting user pool stats:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ======================================================================

// Serve the test streaming client
app.get('/test-streaming-client.html', (req, res) => {
  const clientPath = path.join(__dirname, 'tests', 'test-streaming-client.html');
  res.sendFile(clientPath);
});

// Serve the test streaming client (alternate path)
app.get('/api/tests/test-streaming-client.html', (req, res) => {
  const clientPath = path.join(__dirname, 'tests', 'test-streaming-client.html');
  res.sendFile(clientPath);
});

// --- Authentication Endpoints ---

// Verify token endpoint - validates Firebase tokens
app.get('/api/auth/verify-token', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'No authorization header' });
    }

    // Extract token - support both "Bearer <token>" and "Firebase <token>" formats
    let token = authHeader;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (authHeader.startsWith('Firebase ')) {
      token = authHeader.slice(9);
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    // Try Firebase Admin SDK first if available
    if (firebaseInitialized) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        return res.json({
          success: true,
          user: {
            uid: decodedToken.uid,
            email: decodedToken.email,
            role: decodedToken.admin ? 'admin' : 'user'
          }
        });
      } catch (adminErr) {
        console.log('[Auth] Firebase Admin verification failed, trying JWKS:', adminErr.message);
      }
    }

    // Fallback to JWKS verification
    const user = await verifyFirebaseIdTokenWithoutAdmin(token);
    if (user) {
      return res.json({ success: true, user });
    }

    return res.status(401).json({ success: false, message: 'Invalid token' });
  } catch (e) {
    console.error('[API] /api/auth/verify-token error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Google auth verification endpoint
app.post('/api/auth/google-verify', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      // Also check Authorization header
      const authHeader = req.headers['authorization'];
      if (!authHeader) {
        return res.status(400).json({ success: false, message: 'No token provided' });
      }

      let token = authHeader;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      } else if (authHeader.startsWith('Firebase ')) {
        token = authHeader.slice(9);
      }

      // Verify the token
      if (firebaseInitialized) {
        try {
          const decodedToken = await admin.auth().verifyIdToken(token);
          return res.json({
            success: true,
            user: {
              uid: decodedToken.uid,
              email: decodedToken.email,
              displayName: decodedToken.name || decodedToken.email?.split('@')[0],
              photoURL: decodedToken.picture,
              role: decodedToken.admin ? 'admin' : 'user'
            },
            token: token
          });
        } catch (adminErr) {
          console.log('[Auth] Firebase Admin verification failed:', adminErr.message);
        }
      }

      // Fallback to JWKS
      const user = await verifyFirebaseIdTokenWithoutAdmin(token);
      if (user) {
        return res.json({ success: true, user, token });
      }

      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Verify the provided idToken
    if (firebaseInitialized) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return res.json({
          success: true,
          user: {
            uid: decodedToken.uid,
            email: decodedToken.email,
            displayName: decodedToken.name || decodedToken.email?.split('@')[0],
            photoURL: decodedToken.picture,
            role: decodedToken.admin ? 'admin' : 'user'
          },
          token: idToken
        });
      } catch (adminErr) {
        console.log('[Auth] Firebase Admin verification failed:', adminErr.message);
      }
    }

    // Fallback to JWKS verification
    const user = await verifyFirebaseIdTokenWithoutAdmin(idToken);
    if (user) {
      return res.json({ success: true, user, token: idToken });
    }

    return res.status(401).json({ success: false, message: 'Invalid token' });
  } catch (e) {
    console.error('[API] /api/auth/google-verify error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Helper: collect used bot API ports from existing instance configs
async function getUsedBotPorts() {
  const used = new Set();
  if (!(await fs.pathExists(BOT_BASE_DIR))) return used;
  const users = await fs.readdir(BOT_BASE_DIR);
  for (const uid of users) {
    const userDir = path.join(BOT_BASE_DIR, uid);
    try {
      const insts = await fs.readdir(userDir);
      for (const inst of insts) {
        const cfg = path.join(userDir, inst, 'config.json');
        if (await fs.pathExists(cfg)) {
          try {
            const data = JSON.parse(await fs.readFile(cfg, 'utf8'));
            const p = data?.api_server?.listen_port;
            if (p) used.add(Number(p));
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  return used;
}

async function getNextAvailablePort(start = 8100) {
  const used = await getUsedBotPorts();
  let p = start;
  while (used.has(p)) p += 1;
  return p;
}

function defaultInstanceIdForUser(user) {
  const prefix = (user?.email?.split('@')[0] || user?.uid || user?.id || 'user').replace(/[^a-zA-Z0-9_-]/g, '');
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-bot-${suffix}`;
}

// Retrieve (or fetch) a FreqTrade JWT for a bot using Basic auth credentials
async function getInstanceApiToken(instanceId, baseUrl, username, password) {
  const cached = freqtradeTokenCache.get(instanceId);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30000) {
    console.log(`[Proxy] Using cached token for ${instanceId} (expires in ${Math.round((cached.expiresAt - now) / 1000)}s)`);
    return cached.token;
  }

  console.log(`[Proxy] Fetching fresh token for ${instanceId} from ${baseUrl}`);
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  const tokenResp = await fetch(`${baseUrl}/api/v1/token/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` }
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text().catch(() => '');
    console.error(`[Proxy] Token fetch failed for ${instanceId}: ${tokenResp.status} - ${errText.slice(0, 100)}`);
    throw new Error(`Token fetch failed (${tokenResp.status}): ${errText.slice(0, 200)}`);
  }

  const tokenJson = await tokenResp.json();
  const token = tokenJson?.access_token || tokenJson?.token;
  if (!token) {
    throw new Error('Token missing in FreqTrade response');
  }

  console.log(`[Proxy] Got fresh token for ${instanceId}: ${token.slice(0, 30)}...`);

  // FreqTrade default JWT expiry is 1 day; refresh a bit early
  freqtradeTokenCache.set(instanceId, {
    token,
    expiresAt: now + 55 * 60 * 1000
  });

  return token;
}

// --- Enhanced Provisioning API with Risk Management ---
app.post('/api/provision-enhanced', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let {
      instanceId,
      port,
      apiUsername,
      apiPassword,
      strategy,
      riskTemplate,
      customRiskConfig,
      tradingPairs,
      initialBalance,
      exchangeConfig,
      // Additional bot config options from frontend
      stake_amount,
      max_open_trades,
      timeframe,
      exchange,
      stake_currency
    } = req.body || {};

    // Set defaults
    if (!instanceId) instanceId = defaultInstanceIdForUser(user);
    if (!port) port = await getNextAvailablePort(8100);
    if (!apiUsername) apiUsername = process.env.DEFAULT_BOT_API_USERNAME || 'admin';
    if (!apiPassword) apiPassword = process.env.DEFAULT_BOT_API_PASSWORD || 'password';
    if (!strategy) strategy = 'EnhancedRiskManagedStrategy'; // Default to enhanced strategy
    if (!riskTemplate) riskTemplate = 'balanced'; // Default risk template
    if (!tradingPairs) tradingPairs = ["BTC/USD", "ETH/USD", "ADA/USD", "SOL/USD"];
    if (!stake_amount) stake_amount = 100;
    if (!max_open_trades) max_open_trades = 3;
    if (!timeframe) timeframe = '15m';
    if (!exchange) exchange = 'kraken';
    if (!stake_currency) stake_currency = 'USD';
    
    initialBalance = Number(initialBalance);
    if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
      return res.status(400).json({ success: false, message: 'initialBalance is required and must be > 0' });
    }

    // Enhanced provisioning parameters
    const enhancedParams = {
      instanceId,
      port,
      userId,
      apiUsername,
      apiPassword,
      strategy,
      riskTemplate,
      customRiskConfig,
      tradingPairs,
      initialBalance,
      exchangeConfig,
      stake_amount: Number(stake_amount),
      max_open_trades: Number(max_open_trades),
      timeframe,
      exchange,
      stake_currency,
      enhanced: true
    };

    provisioningQueue.push({ params: enhancedParams, res });

    // Kick the processor if idle
    if (!isProvisioning) processProvisioningQueue();
  } catch (e) {
    console.error('[API] /api/provision-enhanced error:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
  }
});

// --- Original Provisioning API (maintained for compatibility) ---
app.post('/api/provision', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let { instanceId, port, apiUsername, apiPassword, strategy } = req.body || {};
    if (!instanceId) instanceId = defaultInstanceIdForUser(user);
    if (!port) port = await getNextAvailablePort(8100);
    if (!apiUsername) apiUsername = process.env.DEFAULT_BOT_API_USERNAME || 'admin';
    if (!apiPassword) apiPassword = process.env.DEFAULT_BOT_API_PASSWORD || 'password';
    if (!strategy) strategy = 'EmaRsiStrategy'; // Keep original default for compatibility

    provisioningQueue.push({ params: { instanceId, port, userId, apiUsername, apiPassword, strategy }, res });

    // Kick the processor if idle
    if (!isProvisioning) processProvisioningQueue();
  } catch (e) {
    console.error('[API] /api/provision error:', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
  }
});

// --- Get enhanced strategy options ---
app.get('/api/strategies/enhanced', authenticateToken, async (req, res) => {
  try {
    console.log('[API] Getting enhanced strategy options');

    const strategies = [
      {
        name: 'EnhancedRiskManagedStrategy',
        displayName: 'Enhanced Risk Management',
        description: 'Advanced strategy with dynamic position sizing, risk management, and DCA capabilities',
        features: ['Dynamic Position Sizing', 'Advanced Risk Management', 'Volatility-based Stops', 'Portfolio Risk Assessment'],
        riskLevel: 'Medium',
        recommendedFor: 'Experienced traders who want comprehensive risk management',
        defaultRiskTemplate: 'balanced'
      },
      {
        name: 'DCAStrategy',
        displayName: 'Dollar Cost Averaging',
        description: 'Systematic buying strategy that averages down on dips with multiple entry levels',
        features: ['Multi-level DCA', 'Smart Entry Timing', 'Position Size Scaling', 'Time-based Spacing'],
        riskLevel: 'Medium-Low',
        recommendedFor: 'Long-term investors who prefer systematic accumulation',
        defaultRiskTemplate: 'dcaFocused'
      },
      {
        name: 'PortfolioRebalancingStrategy',
        displayName: 'Portfolio Rebalancing',
        description: 'Maintains target allocations across multiple assets with automatic rebalancing',
        features: ['Target Allocation Management', 'Drift Detection', 'Automated Rebalancing', 'Risk Parity'],
        riskLevel: 'Low-Medium',
        recommendedFor: 'Portfolio managers who want automated allocation management',
        defaultRiskTemplate: 'portfolioRebalancing'
      },
      {
        name: 'EmaRsiStrategy',
        displayName: 'EMA-RSI Classic',
        description: 'Traditional EMA crossover strategy with RSI confirmation (original strategy)',
        features: ['EMA Crossover', 'RSI Filter', 'Simple Logic', 'Proven Approach'],
        riskLevel: 'Medium',
        recommendedFor: 'Beginners who want a simple, well-tested strategy',
        defaultRiskTemplate: 'conservative'
      },
      {
        name: 'HighFrequencyStrategy',
        displayName: 'High Frequency Trading',
        description: 'Fast-moving strategy for quick trades and scalping opportunities',
        features: ['Fast Execution', 'Short Timeframes', 'Quick Profits', 'High Turnover'],
        riskLevel: 'High',
        recommendedFor: 'Active traders comfortable with high-frequency trading',
        defaultRiskTemplate: 'aggressive'
      }
    ];

    console.log(`[API] Returning ${strategies.length} enhanced strategies`);
    res.json({ success: true, strategies });
  } catch (e) {
    console.error('[API] Error getting enhanced strategies:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Bot proxy convenience endpoints ---
app.get('/api/bots/:instanceId/balance', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const data = await proxyFreqtradeApiRequest(req.params.instanceId, '/api/v1/balance');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Universal Stake Override Status API ---
app.get('/api/universal-stake-status', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const status = universalStakeOverride.getStatus();

    // Filter status to show only user's bots
    const userStatus = {
      ...status,
      bots: status.bots.filter(bot => bot.key.startsWith(userId))
    };

    res.json({
      success: true,
      data: userStatus,
      message: `Universal stake override monitoring ${userStatus.bots.length} bots for user ${userId}`
    });
  } catch (e) {
    console.error('[API] /api/universal-stake-status error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Initialize Universal Stake Override for Existing Bots ---
app.post('/api/initialize-universal-stake', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    console.log(`[API] Initializing universal stake override for all bots of user ${userId}`);

    await universalStakeOverride.initializeAllUserBots(userId, BOT_BASE_DIR);

    const status = universalStakeOverride.getStatus();
    const userBots = status.bots.filter(bot => bot.key.startsWith(userId));

    res.json({
      success: true,
      message: `Universal stake override initialized for ${userBots.length} bots`,
      data: {
        monitoredBots: userBots.length,
        bots: userBots
      }
    });
  } catch (e) {
    console.error('[API] /api/initialize-universal-stake error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/bots/:instanceId/status', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const data = await proxyFreqtradeApiRequest(req.params.instanceId, '/api/v1/status');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/bots/:instanceId/profit', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const data = await proxyFreqtradeApiRequest(req.params.instanceId, '/api/v1/profit');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- List all bots for authenticated user ---
app.get('/api/bots', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    console.log('[API /api/bots] User:', userId);
    console.log('[API /api/bots] BOT_BASE_DIR:', BOT_BASE_DIR);

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const bots = await listUserBotInstances(userId);
    console.log('[API /api/bots] Found bots:', bots.length, bots.map(b => b.instanceId));
    res.json({ success: true, bots });
  } catch (e) {
    console.error('[API] /api/bots error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Stop a bot ---
app.post('/api/bots/:instanceId/stop', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const containerName = `freqtrade-${instanceId}`;

    console.log(`[API] Stopping bot ${instanceId} (container: ${containerName})`);

    // Stop the Docker container
    await runDockerCommand(['stop', containerName]);
    console.log(`[API] ✓ Container ${containerName} stopped successfully`);

    res.json({ success: true, message: `Bot ${instanceId} stopped successfully` });
  } catch (e) {
    console.error(`[API] Error stopping bot ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Start a bot ---
app.post('/api/bots/:instanceId/start', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const containerName = `freqtrade-${instanceId}`;

    console.log(`[API] Starting bot ${instanceId} (container: ${containerName})`);

    // Start the Docker container
    await runDockerCommand(['start', containerName]);
    console.log(`[API] ✓ Container ${containerName} started successfully`);

    res.json({ success: true, message: `Bot ${instanceId} started successfully` });
  } catch (e) {
    console.error(`[API] Error starting bot ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});
// --- Restart a bot ---
app.post('/api/bots/:instanceId/restart', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const containerName = `freqtrade-${instanceId}`;

    console.log(`[API] Restarting bot ${instanceId} (container: ${containerName})`);

    // Restart the Docker container
    await runDockerCommand(['restart', containerName]);
    console.log(`[API] ✓ Container ${containerName} restarted successfully`);

    res.json({ success: true, message: `Bot ${instanceId} restarted successfully` });
  } catch (e) {
    console.error(`[API] Error restarting bot ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Delete a bot ---
app.delete('/api/bots/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const user = req.user || {};
    const userId = user.uid || user.id;

    console.log(`[API] Deleting bot ${instanceId} for user ${userId}`);

    // --- 0. Cash Out / Graceful Exit Logic ---
    let cashedOutAmount = 0;
    let currency = 'USD';
    let gracefulExitMessage = '';

    try {
      // Use instanceDir from middleware (supports pool structure)
      const instanceDir = req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId);
      const configPath = path.join(instanceDir, 'config.json');

      if (await fs.pathExists(configPath)) {
        const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        currency = config.stake_currency || 'USD';

        // Attempt to get final balance from running bot
        try {
          if (!config.dry_run) {
            console.log(`[API] Live trading bot ${instanceId} deletion requested.`);
            gracefulExitMessage = ' (Live bot stopped - funds remain on exchange)';
          }

          // Fetch balance
          const balanceData = await proxyFreqtradeApiRequest(instanceId, '/api/v1/balance');
          if (balanceData && balanceData.total) {
            cashedOutAmount = balanceData.total;
            console.log(`[API] Bot ${instanceId} cash out value: ${cashedOutAmount} ${currency}`);
          }
        } catch (apiErr) {
          console.log(`[API] Could not fetch final balance (bot might be stopped): ${apiErr.message}`);
        }
      }
    } catch (cashOutErr) {
      console.warn(`[API] Error during cash out phase: ${cashOutErr.message}`);
    }

    // 1. Check if bot is pooled and handle appropriately
    let isPooled = false;
    if (poolSystemInitialized) {
      try {
        isPooled = isInstancePooled(instanceId);
      } catch (poolCheckErr) {
        console.log(`[API] Could not check pool status: ${poolCheckErr.message}`);
      }
    }

    if (isPooled) {
      // POOLED BOT: Stop and remove from supervisor in the pool container
      console.log(`[API] Bot ${instanceId} is pooled - removing from pool container`);
      try {
        const { poolManager } = getPoolComponents();
        const connection = await poolManager.getBotConnectionInfo(instanceId);
        
        if (connection) {
          const containerName = connection.host;
          const supervisorName = `bot-${instanceId}`;
          
          console.log(`[API] Stopping bot in pool container ${containerName} (supervisor: ${supervisorName})`);
          
          // Stop the bot process in supervisor
          try {
            await runDockerCommand(['exec', containerName, 'supervisorctl', 'stop', supervisorName]);
            console.log(`[API] ✓ Bot process ${supervisorName} stopped`);
          } catch (stopErr) {
            console.log(`[API] Bot process stop failed (may already be stopped): ${stopErr.message}`);
          }
          
          // Remove the bot from supervisor
          try {
            await runDockerCommand(['exec', containerName, 'supervisorctl', 'remove', supervisorName]);
            console.log(`[API] ✓ Bot process ${supervisorName} removed from supervisor`);
          } catch (removeErr) {
            console.log(`[API] Bot process removal failed: ${removeErr.message}`);
          }
          
          // Remove the supervisor config file
          try {
            await runDockerCommand(['exec', containerName, 'rm', '-f', `/etc/supervisor/conf.d/${supervisorName}.conf`]);
            console.log(`[API] ✓ Supervisor config file removed`);
          } catch (rmConfErr) {
            console.log(`[API] Supervisor config removal failed: ${rmConfErr.message}`);
          }
          
          // Update supervisor to pick up changes
          try {
            await runDockerCommand(['exec', containerName, 'supervisorctl', 'reread']);
            await runDockerCommand(['exec', containerName, 'supervisorctl', 'update']);
          } catch (updateErr) {
            console.log(`[API] Supervisor update failed: ${updateErr.message}`);
          }
        }
      } catch (poolErr) {
        console.warn(`[API] Error removing bot from pool: ${poolErr.message}`);
      }
    } else {
      // LEGACY BOT: Stop and remove standalone Docker container
      const containerName = `freqtrade-${instanceId}`;
      console.log(`[API] Bot ${instanceId} is legacy - removing standalone container ${containerName}`);
      
      try {
        await runDockerCommand(['stop', containerName]);
        console.log(`[API] ✓ Container ${containerName} stopped`);
      } catch (stopErr) {
        console.log(`[API] Container ${containerName} was not running: ${stopErr.message}`);
      }

      try {
        await runDockerCommand(['rm', '-f', containerName]);
        console.log(`[API] ✓ Container ${containerName} removed`);
      } catch (rmErr) {
        console.log(`[API] Container ${containerName} removal failed: ${rmErr.message}`);
      }
    }

    // 2. Remove the instance directory (use req.instanceDir for pool support)
    const instanceDirToRemove = req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId);
    if (await fs.pathExists(instanceDirToRemove)) {
      await fs.remove(instanceDirToRemove);
      console.log(`[API] ✓ Instance directory removed: ${instanceDirToRemove}`);
    } else {
      console.log(`[API] Instance directory not found: ${instanceDirToRemove}`);
    }

    // 3. Optional: Clean up Turso database if it exists
    if (TURSO_API_KEY && TURSO_ORG && !tursoGloballyDisabled) {
      try {
        const tursoName = `bot-${userId}-${instanceId}`.toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/(^-|-$)/g, '');

        const deleteResponse = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG}/databases/${tursoName}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${TURSO_API_KEY}`,
          }
        });

        if (deleteResponse.ok) {
          console.log(`[API] ✓ Turso database ${tursoName} deleted`);
        } else {
          console.log(`[API] Turso database deletion failed (non-critical): ${deleteResponse.status}`);
        }
      } catch (tursoErr) {
        console.log(`[API] Turso cleanup failed (non-critical): ${tursoErr.message}`);
      }
    }

    console.log(`[API] ✓ Bot ${instanceId} deleted successfully`);
    res.json({
      success: true,
      message: `Bot ${instanceId} deleted successfully.${gracefulExitMessage}`,
      cashedOut: {
        amount: cashedOutAmount,
        currency: currency
      }
    });
  } catch (e) {
    console.error(`[API] Error deleting bot ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Get bot details ---
app.get('/api/bots/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const user = req.user || {};
    const userId = user.uid || user.id;

    // Get bot configuration (use req.instanceDir for pool support)
    const instanceDir = req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId);
    const configPath = path.join(instanceDir, 'config.json');

    if (!await fs.pathExists(configPath)) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }

    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    
    // Check if bot is pooled and get appropriate container info
    let containerName, containerStatus = 'unknown', isPooled = false, poolId = null;
    
    if (poolSystemInitialized && isInstancePooled(instanceId)) {
      isPooled = true;
      try {
        const connection = await poolProvisioner.getBotConnection(instanceId);
        if (connection) {
          containerName = connection.host; // Pool container name
          poolId = connection.poolId;
          // Check pool container status
          const statusOutput = await runDockerCommand(['ps', '-f', `name=${containerName}`, '--format', '{{.Names}}']);
          containerStatus = statusOutput.includes(containerName) ? 'running' : 'stopped';
        }
      } catch (poolErr) {
        console.warn(`[API] Could not get pool connection: ${poolErr.message}`);
        containerName = `freqtrade-${instanceId}`;
      }
    } else {
      containerName = `freqtrade-${instanceId}`;
      // Check legacy container status
      try {
        const statusOutput = await runDockerCommand(['ps', '-f', `name=${containerName}`, '--format', '{{.Names}}']);
        containerStatus = statusOutput.includes(containerName) ? 'running' : 'stopped';
      } catch (statusErr) {
        console.warn(`[API] Could not check container status: ${statusErr.message}`);
      }
    }

    const botInfo = {
      instanceId,
      userId,
      strategy: config.strategy,
      port: config.api_server?.listen_port,
      containerName,
      containerStatus,
      isPooled,
      poolId,
      exchange: config.exchange?.name,
      dry_run: config.dry_run,
      stake_currency: config.stake_currency,
      stake_amount: config.stake_amount,
      max_open_trades: config.max_open_trades,
      created: instanceDir // You might want to add actual creation timestamp
    };

    res.json({ success: true, bot: botInfo });
  } catch (e) {
    console.error(`[API] Error getting bot details ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Strategy Management Endpoints ---

// Get all available strategies
app.get('/api/strategies', authenticateToken, async (req, res) => {
  try {
    console.log('[API] Getting available strategies');

    const strategies = [];

    // Read strategies from main source directory
    if (await fs.pathExists(MAIN_STRATEGIES_SOURCE_DIR)) {
      const files = await fs.readdir(MAIN_STRATEGIES_SOURCE_DIR);
      const pyFiles = files.filter(f => f.endsWith('.py'));

      for (const file of pyFiles) {
        const strategyName = file.replace('.py', '');
        const filePath = path.join(MAIN_STRATEGIES_SOURCE_DIR, file);

        try {
          const content = await fs.readFile(filePath, 'utf8');

          // Extract class name and basic info from strategy file
          const classMatch = content.match(/class\s+(\w+)\s*\(/);
          const className = classMatch ? classMatch[1] : strategyName;

          // Extract docstring if available
          const docMatch = content.match(/class\s+\w+\s*\([^)]*\):\s*"""([^"]+)"""/);
          const description = docMatch ? docMatch[1].trim() : `${strategyName} trading strategy`;

          strategies.push({
            name: strategyName,
            className: className,
            description: description,
            fileName: file
          });
        } catch (err) {
          console.warn(`[API] Error reading strategy file ${file}: ${err.message}`);
          strategies.push({
            name: strategyName,
            className: strategyName,
            description: `${strategyName} trading strategy`,
            fileName: file
          });
        }
      }
    }

    console.log(`[API] Found ${strategies.length} strategies`);
    res.json({ success: true, strategies });
  } catch (e) {
    console.error('[API] Error getting strategies:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Get current strategy for a specific bot
app.get('/api/bots/:instanceId/strategy', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const user = req.user || {};
    const userId = user.uid || user.id;

    console.log(`[API] Getting strategy for bot ${instanceId}`);

    // Use instanceDir attached by checkInstanceOwnership (supports pool structure)
    const instanceDir = req.instanceDir;
    if (!instanceDir) {
      // Fallback to legacy path if middleware didn't attach it
      const legacyDir = path.join(BOT_BASE_DIR, userId, instanceId);
      if (await fs.pathExists(legacyDir)) {
        req.instanceDir = legacyDir;
      }
    }
    
    const configPath = path.join(req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId), 'config.json');

    if (!await fs.pathExists(configPath)) {
      return res.status(404).json({ success: false, message: 'Bot configuration not found' });
    }

    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));

    res.json({
      success: true,
      strategy: {
        current: config.strategy,
        instanceId: instanceId
      }
    });
  } catch (e) {
    console.error(`[API] Error getting bot strategy ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// Update strategy for a specific bot and restart it
app.put('/api/bots/:instanceId/strategy', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { strategy } = req.body;
    const user = req.user || {};
    const userId = user.uid || user.id;

    if (!strategy) {
      return res.status(400).json({ success: false, message: 'Strategy name is required' });
    }

    console.log(`[API] Updating strategy for bot ${instanceId} to ${strategy}`);

    // Use req.instanceDir for pool structure support
    const instanceDir = req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId);
    const configPath = path.join(instanceDir, 'config.json');

    if (!await fs.pathExists(configPath)) {
      return res.status(404).json({ success: false, message: 'Bot configuration not found' });
    }

    // Verify the strategy exists
    const strategyFile = path.join(MAIN_STRATEGIES_SOURCE_DIR, `${strategy}.py`);
    if (!await fs.pathExists(strategyFile)) {
      return res.status(400).json({ success: false, message: 'Strategy not found' });
    }

    // Update the config file
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const oldStrategy = config.strategy;
    config.strategy = strategy;

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log(`[API] ✓ Updated config.json strategy from ${oldStrategy} to ${strategy}`);

    // Copy the new strategy file to the bot's strategies directory
    const instanceStrategiesDir = path.join(instanceDir, 'user_data', 'strategies');
    await fs.ensureDir(instanceStrategiesDir);

    const destStrategyFile = path.join(instanceStrategiesDir, `${strategy}.py`);
    await fs.copy(strategyFile, destStrategyFile);
    console.log(`[API] ✓ Copied strategy file to ${destStrategyFile}`);

    // Restart the bot to apply the new strategy
    const containerName = `freqtrade-${instanceId}`;

    try {
      // Check if container is running
      const statusOutput = await runDockerCommand(['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
      const isRunning = statusOutput.includes(containerName);

      if (isRunning) {
        console.log(`[API] Restarting bot ${instanceId} to apply new strategy...`);
        await runDockerCommand(['restart', containerName]);
        console.log(`[API] ✓ Container ${containerName} restarted successfully`);
      } else {
        console.log(`[API] Bot ${instanceId} is not running, strategy updated but not restarted`);
      }

      res.json({
        success: true,
        message: `Strategy updated to ${strategy}${isRunning ? ' and bot restarted' : ' (bot was not running)'}`,
        strategy: {
          previous: oldStrategy,
          current: strategy,
          restarted: isRunning
        }
      });
    } catch (restartErr) {
      console.error(`[API] Error restarting bot ${instanceId}:`, restartErr.message);
      res.json({
        success: true,
        message: `Strategy updated to ${strategy} but failed to restart bot: ${restartErr.message}`,
        strategy: {
          previous: oldStrategy,
          current: strategy,
          restarted: false
        }
      });
    }
  } catch (e) {
    console.error(`[API] Error updating bot strategy ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Update bot wallet balance (dry_run_wallet) ---
app.put('/api/bots/:instanceId/wallet-balance', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { newBalance, currency = 'USD' } = req.body;
    const user = req.user || {};
    const userId = user.uid || user.id;

    if (newBalance === undefined || newBalance < 0) {
      return res.status(400).json({ success: false, message: 'Valid newBalance is required (must be >= 0)' });
    }

    console.log(`[API] Updating wallet balance for bot ${instanceId} to ${newBalance} ${currency}`);

    // Use req.instanceDir for pool structure support
    const instanceDir = req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId);
    const configPath = path.join(instanceDir, 'config.json');

    if (!await fs.pathExists(configPath)) {
      return res.status(404).json({ success: false, message: 'Bot configuration not found' });
    }

    // Update the config file
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const oldBalance = config.dry_run_wallet?.[currency] || 0;
    
    if (!config.dry_run_wallet) {
      config.dry_run_wallet = {};
    }
    config.dry_run_wallet[currency] = newBalance;

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log(`[API] ✓ Updated dry_run_wallet.${currency} from ${oldBalance} to ${newBalance}`);

    // Use the pool system to determine if bot is pooled and get connection info
    let containerName;
    let isPooled = false;
    
    // Use the proper pool system to check if bot is pooled
    if (poolSystemInitialized && isInstancePooled(instanceId)) {
      isPooled = true;
      const { poolManager } = getPoolComponents();
      const connectionInfo = poolManager.getBotConnectionInfo(instanceId);
      if (connectionInfo) {
        containerName = connectionInfo.containerName;
        console.log(`[API] Bot ${instanceId} is pooled in container ${containerName}`);
      } else {
        // Fallback: construct container name from user ID
        containerName = `freqtrade-pool-${userId}-pool-1`;
        console.log(`[API] Bot ${instanceId} is pooled, using fallback container ${containerName}`);
      }
    } else {
      containerName = `freqtrade-${instanceId}`;
      console.log(`[API] Bot ${instanceId} is legacy (non-pooled), container ${containerName}`);
    }

    // For FreqTrade to pick up balance changes, we need to restart the bot
    // The balance is read from config on startup
    
    // Check if bot is running and restart it
    let wasRestarted = false;
    try {
      const statusOutput = await runDockerCommand(['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
      const isRunning = statusOutput.includes(containerName);
      console.log(`[API] Container ${containerName} running: ${isRunning}`);

      if (isRunning && !isPooled) {
        // For non-pooled bots, restart the container
        console.log(`[API] Restarting bot ${instanceId} to apply new balance...`);
        await runDockerCommand(['restart', containerName]);
        wasRestarted = true;
        console.log(`[API] ✓ Container ${containerName} restarted successfully`);
      } else if (isRunning && isPooled) {
        // For pooled bots, restart just this bot via supervisorctl
        const supervisorBotName = `bot-${instanceId}`;
        console.log(`[API] Restarting pooled bot ${instanceId} via supervisorctl (${supervisorBotName})...`);
        try {
          await runDockerCommand(['exec', containerName, 'supervisorctl', 'restart', supervisorBotName]);
          wasRestarted = true;
          console.log(`[API] ✓ Pooled bot ${instanceId} restarted successfully`);
        } catch (supervisorErr) {
          console.warn(`[API] Could not restart via supervisorctl restart: ${supervisorErr.message}`);
          // Try alternative: stop and start
          try {
            console.log(`[API] Trying stop/start for ${supervisorBotName}...`);
            await runDockerCommand(['exec', containerName, 'supervisorctl', 'stop', supervisorBotName]);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
            await runDockerCommand(['exec', containerName, 'supervisorctl', 'start', supervisorBotName]);
            wasRestarted = true;
            console.log(`[API] ✓ Pooled bot ${instanceId} restarted via stop/start`);
          } catch (altErr) {
            console.warn(`[API] Could not restart pooled bot via stop/start: ${altErr.message}`);
          }
        }
      }
    } catch (restartErr) {
      console.warn(`[API] Could not check/restart container: ${restartErr.message}`);
    }

    res.json({
      success: true,
      message: `Bot wallet balance updated to ${newBalance} ${currency}${wasRestarted ? ' and bot restarted' : ''}`,
      wallet: {
        currency,
        previousBalance: oldBalance,
        newBalance,
        restarted: wasRestarted
      }
    });
  } catch (e) {
    console.error(`[API] Error updating bot wallet balance ${req.params.instanceId}:`, e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Get current portfolio snapshot (aggregated) ---
app.get('/api/portfolio', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const portfolioData = await aggregateUserPortfolio(userId);
    res.json({
      success: true,
      ...portfolioData
    });
  } catch (e) {
    console.error('[API] /api/portfolio error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Get historical portfolio data ---
app.get('/api/portfolio/history', authenticateToken, async (req, res) => {
  try {
    const user = req.user || {};
    const userId = user.uid || user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    // Parse query parameters
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000); // Max 1000 snapshots
    const from = req.query.from ? parseInt(req.query.from) : null;
    const to = req.query.to ? parseInt(req.query.to) : null;

    // Get portfolio snapshots
    const userDir = path.join(BOT_BASE_DIR, userId);
    const snapshotsFile = path.join(userDir, 'portfolio_snapshots.json');

    if (!await fs.pathExists(snapshotsFile)) {
      return res.json({
        success: true,
        snapshots: [],
        count: 0,
        period: { from: null, to: null }
      });
    }

    const snapshotsData = JSON.parse(await fs.readFile(snapshotsFile, 'utf8'));
    let snapshots = snapshotsData.snapshots || [];

    // Filter by time range if specified
    if (from || to) {
      snapshots = snapshots.filter(snapshot => {
        const ts = snapshot.timestamp;
        if (from && ts < from) return false;
        if (to && ts > to) return false;
        return true;
      });
    }

    // Apply limit (get most recent)
    if (snapshots.length > limit) {
      snapshots = snapshots.slice(-limit);
    }

    const period = {
      from: snapshots.length > 0 ? snapshots[0].timestamp : null,
      to: snapshots.length > 0 ? snapshots[snapshots.length - 1].timestamp : null
    };

    res.json({
      success: true,
      snapshots,
      count: snapshots.length,
      period
    });

  } catch (e) {
    console.error('[API] /api/portfolio/history error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Ensure Base Directories Exist ---
(async () => {
  try {
    console.log(`Ensuring bot instance base directory exists: ${BOT_BASE_DIR}`);
    await fs.ensureDir(BOT_BASE_DIR);
    console.log(`Ensuring shared strategies directory exists (for fallback): ${STRATEGIES_DIR}`);
    await fs.ensureDir(STRATEGIES_DIR);
    console.log(`Checking main strategies source directory: ${MAIN_STRATEGIES_SOURCE_DIR}`);
    if (!await fs.pathExists(MAIN_STRATEGIES_SOURCE_DIR)) {
      console.warn(`WARNING: Main strategies source directory (${MAIN_STRATEGIES_SOURCE_DIR}) does not exist.`);
    } else { console.log(`Main strategies source directory found.`); }
    console.log(`Ensuring base shared data directory exists: ${SHARED_DATA_DIR}`);
    await fs.ensureDir(SHARED_DATA_DIR); // Create the base shared data dir if it doesn't exist
    console.log("Base directories ensured/checked.");

    // Validate Turso API token on startup
    if (TURSO_API_KEY && TURSO_ORG) {
      console.log("Validating Turso API token on startup...");
      const tokenValid = await validateAndRefreshTursoToken();
      if (!tokenValid) {
        console.warn('⚠️  Turso API token validation failed on startup');
        console.warn('   Turso sync is globally disabled to prevent repeated failed API calls');
        console.warn('   To resolve: node refresh-turso-token.js --renew');
      }
    } else {
      console.log("Turso API configuration not found (TURSO_API_KEY or TURSO_ORG missing)");
      console.log("Turso sync will be disabled");
      tursoGloballyDisabled = true;
    }

    // Create fallback default strategy in SHARED strategy dir if it's empty
    const sharedStrategyFiles = await fs.readdir(STRATEGIES_DIR);
    if (sharedStrategyFiles.filter(f => f.endsWith('.py')).length === 0) {
      const dummyStrategyPath = path.join(STRATEGIES_DIR, 'DefaultStrategy.py');
      const dummyStrategyContent = `
import talib.abstract as ta
from pandas import DataFrame # Ensure DataFrame is imported
from freqtrade.strategy import IStrategy, IntParameter
import freqtrade.vendor.qtpylib.indicators as qtpylib
class DefaultStrategy(IStrategy):
    INTERFACE_VERSION = 3; minimal_roi = {"0": 0.01}; stoploss = -0.10; timeframe = '5m'
    process_only_new_candles = True; startup_candle_count: int = 20; use_exit_signal = True; exit_profit_only = False
    buy_rsi = IntParameter(10, 40, default=30, space='buy'); sell_rsi = IntParameter(60, 90, default=70, space='sell')
    def populate_indicators(self, df: DataFrame, md: dict) -> DataFrame: df['rsi'] = ta.RSI(df); return df
    def populate_entry_trend(self, df: DataFrame, md: dict) -> DataFrame: df.loc[(qtpylib.crossed_below(df['rsi'], self.buy_rsi.value)), 'enter_long'] = 1; return df
    def populate_exit_trend(self, df: DataFrame, md: dict) -> DataFrame: df.loc[(qtpylib.crossed_above(df['rsi'], self.sell_rsi.value)), 'exit_long'] = 1; return df
`;
      if (!await fs.pathExists(dummyStrategyPath)) { await fs.writeFile(dummyStrategyPath, dummyStrategyContent); console.log(`Created fallback DefaultStrategy: ${dummyStrategyPath}`); }
    }
  } catch (err) { console.error("FATAL: Directory setup failed.", err); process.exit(1); }
})();


// --- Process the Provisioning Queue (Using Strategy Copy & CORRECTED Shared Data Volume) ---
async function processProvisioningQueue() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Queue Processor] processProvisioningQueue called. isProvisioning: ${isProvisioning}, Queue length: ${provisioningQueue.length}`);

  if (isProvisioning || provisioningQueue.length === 0) {
    console.log(`[${timestamp}] [Queue Processor] Exiting early - isProvisioning: ${isProvisioning}, queue empty: ${provisioningQueue.length === 0}`);
    return;
  }

  isProvisioning = true;
  const task = provisioningQueue.shift();
  console.log(`[${timestamp}] [Queue Processor] Dequeued task. Params:`, JSON.stringify(task?.params, null, 2));

  const {
    instanceId = 'ERR_ID',
    port = -1,
    userId = 'ERR_USR',
    apiUsername = 'ERR_API',
    apiPassword = 'ERR_PW',
    strategy = 'EmaRsiStrategy',
    riskTemplate = null,
    customRiskConfig = null,
    tradingPairs = ["BTC/USD", "ETH/USD", "ADA/USD", "SOL/USD"],
    initialBalance = 10000,
    exchangeConfig = null,
    enhanced = false,
    // Additional config options from frontend
    stake_amount = 100,
    max_open_trades = 3,
    timeframe = '15m',
    exchange = 'kraken',
    stake_currency = 'USD'
  } = task?.params || {};

  console.log(`[${timestamp}] [${instanceId}] PROVISIONING START - userId: ${userId}, port: ${port}, strategy: ${strategy}, enhanced: ${enhanced}`);

  if (enhanced) {
    console.log(`[${timestamp}] [${instanceId}] Enhanced provisioning with risk template: ${riskTemplate}, pairs: ${tradingPairs.join(', ')}`);
  }

  // ======================================================================
  // POOL MODE PROVISIONING (REQUIRED)
  // Legacy one-container-per-bot mode has been removed
  // All bots MUST be provisioned in pool mode for proper organization
  // ======================================================================
  if (!POOL_MODE_ENABLED || !poolProvisioner.isPoolModeEnabled()) {
    console.error(`[${instanceId}] ERROR: Pool mode is REQUIRED but not enabled`);
    console.error(`[${instanceId}] Set POOL_MODE_ENABLED=true in environment`);
    
    if (!task.res.headersSent) {
      task.res.status(500).json({ 
        success: false, 
        message: 'Pool mode is required for bot provisioning' 
      });
    }
    
    isProvisioning = false;
    if (provisioningQueue.length > 0) {
      processProvisioningQueue();
    }
    return;
  }
  
  console.log(`[${instanceId}] Using POOL MODE provisioning...`);
  try {
      const poolResult = await poolProvisioner.provisionBot({
        instanceId,
        userId,
        port,
        strategy,
        tradingPairs,
        initialBalance,
        exchangeConfig,
        apiUsername,
        apiPassword,
        enhanced,
        riskTemplate,
        customRiskConfig,
        stake_amount,
        max_open_trades,
        timeframe,
        exchange,
        stake_currency
      });

      console.log(`[${instanceId}] Pool provisioning result:`, JSON.stringify(poolResult, null, 2));

      // Send success response
      if (!task.res.headersSent) {
        task.res.json({
          success: true,
          message: poolResult.isPooled ? 'Bot provisioned in container pool' : 'Bot provisioned successfully',
          instanceId: poolResult.instanceId,
          port: poolResult.port,
          containerName: poolResult.containerName,
          strategy: poolResult.config?.strategy || strategy,
          isPooled: poolResult.isPooled,
          poolId: poolResult.poolId
        });
      }

      console.log(`[${instanceId}] ✓ Pool provisioning COMPLETE`);
  } catch (poolErr) {
    console.error(`[${instanceId}] Pool provisioning error:`, poolErr);
    if (!task.res.headersSent) {
      task.res.status(500).json({ success: false, message: poolErr.message });
    }
  } finally {
    isProvisioning = false;
    if (provisioningQueue.length > 0) {
      console.log(`[${instanceId}] More tasks in queue, continuing...`);
      processProvisioningQueue();
    }
  }
}


// --- Start processing the queue periodically (Fallback) ---
setInterval(() => {
  if (!isProvisioning && provisioningQueue.length > 0) {
    console.log("[Queue Interval] Interval check found tasks. Starting processing.");
    processProvisioningQueue();
  }
}, 5000);

// Global flag to prevent repeated Turso calls
let tursoGloballyDisabled = false; // Reset this flag 
let lastTursoValidationAttempt = 0;
const TURSO_VALIDATION_COOLDOWN = 5 * 60 * 1000; // 5 minutes

// Helper function to check if Turso operations should be skipped
function shouldSkipTurso() {
  if (!TURSO_API_KEY || !TURSO_ORG) {
    return true;
  }
  return tursoGloballyDisabled;
}

// Helper function to reset Turso global disable flag (for admin use)
function resetTursoGlobalDisable() {
  tursoGloballyDisabled = false;
  lastTursoValidationAttempt = 0;
  console.log('✓ Turso global disable flag reset');
}

// --- Helper Function to Validate and Refresh Turso Token ---
async function validateAndRefreshTursoToken() {
  if (!TURSO_API_KEY || !TURSO_ORG) {
    tursoGloballyDisabled = true;
    return false;
  }

  // Check if globally disabled
  if (tursoGloballyDisabled) {
    console.log('⚠️  Turso operations are globally disabled due to previous failures');
    return false;
  }

  // Rate limiting: prevent too frequent validation attempts
  const now = Date.now();
  if (now - lastTursoValidationAttempt < TURSO_VALIDATION_COOLDOWN) {
    console.log('⚠️  Turso validation skipped due to rate limiting');
    return false;
  }
  lastTursoValidationAttempt = now;

  try {
    // Use the refresh-turso-token.js utility to validate and renew if needed
    console.log('Using refresh-turso-token.js for validation and renewal...');

    const { spawn } = require('child_process');
    const validationProcess = spawn('node', ['refresh-turso-token.js', '--check'], {
      cwd: __dirname,
      stdio: 'pipe'
    });

    return new Promise((resolve) => {
      let output = '';
      let errorOutput = '';

      validationProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      validationProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      validationProcess.on('error', (err) => {
        console.log('⚠️  Turso validation process failed:', err.message);
        tursoGloballyDisabled = true;
        resolve(false);
      });

      validationProcess.on('close', (code) => {
        if (code === 0) {
          console.log('✓ Turso token validation successful');
          resolve(true);
        } else {
          console.log('⚠️  Turso token validation failed, disabling Turso operations globally');
          console.log('   To resolve: node refresh-turso-token.js --renew');
          console.log('   Output:', output);
          console.log('   Error:', errorOutput);
          tursoGloballyDisabled = true;
          resolve(false);
        }
      });
    });
  } catch (error) {
    console.log('⚠️  Turso validation failed:', error.message);
    tursoGloballyDisabled = true;
    return false;
  }
}

// --- Helper Function to Run Docker Commands ---
async function runDockerCommand(args, cwd = null, cmdName = 'docker') {
  return new Promise((resolve, reject) => {
    const cmd = cmdName;
    const cmdArgs = args;
    const options = cwd ? { cwd } : {};
    options.encoding = 'utf8';

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [Docker Helper] Starting command: ${cmd} ${cmdArgs.join(' ')} ${cwd ? `(in ${cwd})` : ''}`);

    const command = spawn(cmd, cmdArgs, options);
    let stdout = '';
    let stderr = '';

    command.stdout.on('data', (data) => {
      stdout += data;
      console.log(`[${timestamp}] [Docker Helper] stdout: ${data.toString().trim()}`);
    });

    command.stderr.on('data', (data) => {
      stderr += data;
      console.error(`[${timestamp}] [Docker Helper] stderr: ${data.toString().trim()}`);
    });

    command.on('error', (err) => {
      console.error(`[${timestamp}] [Docker Helper] Spawn Error: ${cmd} ${cmdArgs.join(' ')}`, err);
      reject(err);
    });

    command.on('close', (code) => {
      console.log(`[${timestamp}] [Docker Helper] Command finished: ${cmd} ${cmdArgs.join(' ')} (Exit Code: ${code})`);

      if (stderr && code !== 0) {
        console.error(`[${timestamp}] [Docker Helper] Final stderr: ${stderr.trim()}`);
      }

      if (stdout.trim()) {
        console.log(`[${timestamp}] [Docker Helper] Final stdout: ${stdout.trim()}`);
      }

      if (code !== 0) {
        const errorMsg = `Docker command failed with exit code ${code}: ${stderr.trim() || stdout.trim() || 'No output'}`;
        console.error(`[${timestamp}] [Docker Helper] ${errorMsg}`);
        reject(new Error(errorMsg));
      } else {
        console.log(`[${timestamp}] [Docker Helper] Command succeeded.`);
        resolve(stdout.trim());
      }
    });
  });
}

// --- Simple helpers for API Gateway aggregation (new) ---
async function listUserBotInstances(userId) {
  const bots = [];
  const userDir = path.join(BOT_BASE_DIR, userId);
  console.log('[listUserBotInstances] Checking userDir:', userDir);
  console.log('[listUserBotInstances] Path exists:', await fs.pathExists(userDir));

  if (!(await fs.pathExists(userDir))) return bots;

  try {
    // If pool mode is enabled, get bots from pool manager
    if (poolSystemInitialized && poolProvisioner.isPoolModeEnabled()) {
      console.log('[listUserBotInstances] Pool mode enabled, getting bots from pool manager');
      const poolStats = poolProvisioner.getUserPoolStats(userId);
      
      // For each pool, get the bots
      for (const pool of poolStats.pools) {
        const poolDir = path.join(userDir, pool.id);
        
        for (const botInstanceId of pool.bots) {
          try {
            const botDir = path.join(poolDir, 'bots', botInstanceId);
            const configPath = path.join(botDir, 'config.json');
            
            // Verify bot directory and config actually exist
            if (!(await fs.pathExists(botDir))) {
              console.log('[listUserBotInstances] Bot directory not found for', botInstanceId, '- cleaning up state');
              // Clean up stale bot from pool state
              try {
                const poolManager = poolProvisioner.getPoolManager();
                if (poolManager && poolManager.botMapping) {
                  poolManager.botMapping.delete(botInstanceId);
                  const poolState = poolManager.pools.get(pool.id);
                  if (poolState) {
                    poolState.bots = poolState.bots.filter(id => id !== botInstanceId);
                    await poolManager._saveState();
                    console.log('[listUserBotInstances] Cleaned up stale bot from state:', botInstanceId);
                  }
                }
              } catch (cleanupErr) {
                console.warn('[listUserBotInstances] Cleanup error:', cleanupErr.message);
              }
              continue;
            }
            
            if (!(await fs.pathExists(configPath))) {
              console.log('[listUserBotInstances] Config not found for', botInstanceId);
              continue;
            }
            
            const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            
            // Get bot slot info from poolStats
            const botSlot = poolStats.bots.find(b => b.instanceId === botInstanceId);
            const port = botSlot ? botSlot.port : config.api_server?.listen_port;
            
            console.log('[listUserBotInstances] Adding pooled bot:', botInstanceId, 'port:', port);
            bots.push({
              instanceId: botInstanceId,
              userId,
              strategy: config.strategy,
              port,
              containerName: pool.containerName,
              containerStatus: pool.status === 'running' ? 'running' : 'stopped',
              exchange: config.exchange?.name,
              dry_run: config.dry_run,
              stake_currency: config.stake_currency,
              stake_amount: config.stake_amount,
              max_open_trades: config.max_open_trades,
              username: config.api_server?.username,
              password: config.api_server?.password,
              isPooled: true,
              poolId: pool.id,
              slotIndex: botSlot ? botSlot.slotIndex : null
            });
          } catch (botErr) {
            console.warn(`[listUserBotInstances] Error processing bot ${botInstanceId}:`, botErr.message);
          }
        }
      }
      
      return bots;
    }
    
    // Legacy mode: scan for individual bot directories
    const instanceIds = await fs.readdir(userDir);
    console.log('[listUserBotInstances] Found entries:', instanceIds);

    for (const instanceId of instanceIds) {
      try {
        // Skip temp files, pool directories, and non-bot files
        if (instanceId.includes('.tmp') || instanceId.includes('.json') || instanceId.includes('.backup') || 
            instanceId.includes('-pool-') || instanceId === 'historical_backups' || instanceId === 'permanent_backups') {
          console.log('[listUserBotInstances] Skipping:', instanceId);
          continue;
        }

        const instanceDir = path.join(userDir, instanceId);
        const stats = await fs.stat(instanceDir);
        if (!stats.isDirectory()) {
          console.log('[listUserBotInstances] Not a directory:', instanceId);
          continue;
        }

        const configPath = path.join(instanceDir, 'config.json');
        const configExists = await fs.pathExists(configPath);
        console.log('[listUserBotInstances] Config exists for', instanceId, ':', configExists);
        if (!configExists) continue;

        const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        const port = config.api_server?.listen_port;
        console.log('[listUserBotInstances] Port for', instanceId, ':', port);
        if (!port) continue;

        const containerName = `freqtrade-${instanceId}`;

        // Check container status - skip Docker check if it fails
        let containerStatus = 'unknown';
        try {
          const statusOutput = await runDockerCommand(['ps', '-f', `name=${containerName}`, '--format', '{{.Names}}']);
          containerStatus = statusOutput.includes(containerName) ? 'running' : 'stopped';
        } catch (statusErr) {
          console.log('[listUserBotInstances] Docker check failed for', instanceId, ':', statusErr.message);
          containerStatus = 'unknown'; // Don't mark as error, just unknown
        }

        console.log('[listUserBotInstances] Adding bot:', instanceId, 'containerStatus:', containerStatus);
        bots.push({
          instanceId,
          userId,
          strategy: config.strategy,
          port,
          containerName,
          containerStatus,
          exchange: config.exchange?.name,
          dry_run: config.dry_run,
          stake_currency: config.stake_currency,
          stake_amount: config.stake_amount,
          max_open_trades: config.max_open_trades,
          username: config.api_server?.username,
          password: config.api_server?.password,
          isPooled: false
        });
      } catch (instanceErr) {
        console.warn(`[listUserBotInstances] Error processing instance ${instanceId}:`, instanceErr.message);
      }
    }
  } catch (readDirErr) {
    console.warn(`[listUserBotInstances] Error reading user directory ${userDir}:`, readDirErr.message);
  }

  console.log('[listUserBotInstances] Returning bots:', bots.length);
  return bots;
}

// Resolve absolute instance directory by scanning user folders
async function resolveInstanceDir(instanceId) {
  const users = await fs.readdir(BOT_BASE_DIR);
  for (const uid of users) {
    const instanceDir = path.join(BOT_BASE_DIR, uid, instanceId);
    try {
      const stats = await fs.stat(instanceDir);
      if (stats.isDirectory()) return instanceDir;
    } catch { /* continue */ }
  }
  throw new Error(`Instance directory not found for ${instanceId}`);
}

// Build bot URL and credentials by reading its config.json
// UPDATED: Now supports both pool mode and legacy mode
async function getBotUrlByInstanceId(instanceId) {
  // Phase 2: Check if bot is in pool mode first
  if (poolSystemInitialized && isInstancePooled(instanceId)) {
    try {
      const poolConnection = await getPoolAwareBotUrl(instanceId);
      return {
        url: poolConnection.url,
        username: poolConnection.username,
        password: poolConnection.password,
        isPooled: true,
        poolId: poolConnection.poolId
      };
    } catch (poolErr) {
      console.warn(`[getBotUrlByInstanceId] Pool lookup failed for ${instanceId}, falling back to legacy: ${poolErr.message}`);
    }
  }
  
  // Legacy mode: read from config.json
  const instanceDir = await resolveInstanceDir(instanceId);
  const cfgPath = path.join(instanceDir, 'config.json');
  if (!await fs.pathExists(cfgPath)) throw new Error('config.json not found');
  const config = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  const port = config.api_server?.listen_port;
  if (!port) throw new Error('listen_port missing in config');

  // In production Docker environment, use container name and internal port 8080
  const isProduction = process.env.NODE_ENV === 'production';
  const host = isProduction ? `freqtrade-${instanceId}` : 'localhost';
  const targetPort = isProduction ? 8080 : port;

  return {
    url: `http://${host}:${targetPort}`,
    username: config.api_server?.username,
    password: config.api_server?.password,
    isPooled: false
  };
}

// Generic proxy to FreqTrade bot API
async function proxyFreqtradeApiRequest(instanceId, endpoint, method = 'GET', body = null) {
  const botConfig = await getBotUrlByInstanceId(instanceId);
  let token = await getBotAuthToken(botConfig, instanceId);
  let headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = `${botConfig.url}${endpoint}`;

  let resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });

  // If token expired/invalid, refresh once and retry
  if (resp.status === 401) {
    botTokenCache.delete(instanceId);
    token = await getBotAuthToken(botConfig, instanceId);
    headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Proxy error ${resp.status} ${resp.statusText}: ${text?.slice(0, 200)}`);
  }
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return resp.json();
  return resp.text();
}

// In-memory caches for bot auth
const botTokenCache = new Map(); // instanceId -> { token, expMs }
const botAuthBackoff = new Map(); // instanceId -> nextAllowedAt (ms)

// Obtain JWT from FreqTrade bot API with caching and backoff
async function getBotAuthToken(botConfig, instanceId) {
  const now = Date.now();
  // Backoff check
  const nextAllowed = botAuthBackoff.get(instanceId) || 0;
  if (now < nextAllowed) {
    throw new Error(`auth backoff until ${new Date(nextAllowed).toISOString()}`);
  }

  // Cache check
  const cached = botTokenCache.get(instanceId);
  if (cached && cached.expMs && cached.expMs - now > 30 * 1000) {
    return cached.token;
  }

  const username = botConfig?.username || process.env.DEFAULT_BOT_API_USERNAME;
  const password = botConfig?.password || process.env.DEFAULT_BOT_API_PASSWORD;
  if (!username || !password) {
    // Set 60s backoff to avoid spamming login
    botAuthBackoff.set(instanceId, now + 60 * 1000);
    throw new Error('Missing bot API credentials (set api_server.username/password in config or DEFAULT_BOT_API_USERNAME/PASSWORD env)');
  }

  // HTTP Basic auth as required by FreqTrade
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  const resp = await fetch(`${botConfig.url}/api/v1/token/login`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}` }
  });

  if (resp.status === 401) {
    botAuthBackoff.set(instanceId, now + 60 * 1000); // 1 minute cooldown
    throw new Error('401 Unauthorized from bot API');
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // Short backoff for other errors
    botAuthBackoff.set(instanceId, now + 30 * 1000);
    throw new Error(`Login failed (${resp.status}): ${text?.slice(0, 200)}`);
  }

  const data = await resp.json();
  const token = data?.access_token || data?.token;
  if (!token) {
    botAuthBackoff.set(instanceId, now + 30 * 1000);
    throw new Error('No access_token in login response');
  }

  // Compute expiry: decode JWT if possible, else 9 minutes
  let expMs = now + 9 * 60 * 1000;
  try {
    const dec = jwt.decode(token);
    if (dec?.exp) expMs = dec.exp * 1000;
  } catch { /* ignore */ }

  botTokenCache.set(instanceId, { token, expMs });
  return token;
}

async function getBotAggregates(instanceId) {
  try {
    const botConfig = await getBotUrlByInstanceId(instanceId);
    const token = await getBotAuthToken(botConfig, instanceId);
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    const [statusRes, balanceRes, profitRes] = await Promise.all([
      fetch(`${botConfig.url}/api/v1/status`, { headers }),
      fetch(`${botConfig.url}/api/v1/balance`, { headers }),
      fetch(`${botConfig.url}/api/v1/profit`, { headers })
    ]);

    const ok = statusRes.ok && balanceRes.ok && profitRes.ok;
    if (!ok) throw new Error('Bot API error');

    const [status, balance, profit] = await Promise.all([
      statusRes.json(), balanceRes.json(), profitRes.json()
    ]);

    // Bot total balance (including open positions) and starting capital
    // Use 'total' for total equity including open positions, not 'total_bot' which is available balance
    const totalBalance = Number(balance?.total || balance?.total_bot || 0);
    const startingCapital = Number(balance?.starting_capital || 10000);

    // Calculate P&L as current balance - starting capital
    const totalPnL = totalBalance - startingCapital;

    const openTrades = Array.isArray(status) ? status.filter(t => t?.is_open) : [];

    return {
      instanceId,
      status,
      metrics: {
        totalBalance,
        totalPnL,
        startingCapital,
        openTrades: openTrades.length
      }
    };
  } catch (e) {
    return { instanceId, error: e.message, metrics: { totalBalance: 0, totalPnL: 0, startingCapital: 0, openTrades: 0 } };
  }
}

async function aggregateUserPortfolio(userId) {
  const bots = await listUserBotInstances(userId);
  const aggregates = await Promise.all(bots.map(b => getBotAggregates(b.instanceId)));
  const running = aggregates.filter(a => !a.error);

  const totalBalance = running.reduce((s, b) => s + (Number(b.metrics.totalBalance) || 0), 0);
  const totalPnL = running.reduce((s, b) => s + (Number(b.metrics.totalPnL) || 0), 0);
  const totalStartingCapital = running.reduce((s, b) => s + (Number(b.metrics.startingCapital) || 0), 0);

  // Calculate aggregate profit/loss percentage
  const profitLossPercentage = totalStartingCapital > 0
    ? (totalPnL / totalStartingCapital) * 100
    : 0;

  const activeBots = running.length;
  const botCount = aggregates.length;

  return {
    timestamp: Date.now(),
    portfolioValue: totalBalance,
    totalBalance,
    totalPnL,
    totalStartingCapital,
    profitLossPercentage,
    activeBots,
    botCount,
    bots: aggregates
  };
}

// --- Historical Portfolio Data Functions ---
async function loadUserPortfolioSnapshots(userId) {
  try {
    const userDir = path.join(BOT_BASE_DIR, userId);
    const snapshotPath = path.join(userDir, 'portfolio_snapshots.json');

    if (!(await fs.pathExists(snapshotPath))) {
      return { snapshots: [], metadata: {} };
    }

    const data = await fs.readJson(snapshotPath);
    return {
      snapshots: data.snapshots || [],
      metadata: data.metadata || {}
    };
  } catch (error) {
    console.error(`[HistoricalData] Error loading snapshots for user ${userId}:`, error);
    return { snapshots: [], metadata: {} };
  }
}

function aggregateSnapshotsForInterval(snapshots, intervalMs) {
  const now = Date.now();
  const startTime = now - intervalMs;

  // Determine the aggregation window based on the requested interval
  let windowMs;
  let targetPoints;
  if (intervalMs <= 60 * 60 * 1000) { // 1 hour
    windowMs = 5 * 60 * 1000; // 5-minute windows
    targetPoints = 12;
  } else if (intervalMs <= 24 * 60 * 60 * 1000) { // 24 hours
    windowMs = 30 * 60 * 1000; // 30-minute windows
    targetPoints = 48;
  } else if (intervalMs <= 7 * 24 * 60 * 60 * 1000) { // 7 days
    windowMs = 4 * 60 * 60 * 1000; // 4-hour windows
    targetPoints = 42;
  } else { // 30 days
    windowMs = 24 * 60 * 60 * 1000; // 24-hour windows
    targetPoints = 30;
  }

  // If no snapshots at all, return empty array
  if (!snapshots || snapshots.length === 0) {
    console.log(`[ChartData] No snapshots available, returning empty array`);
    return [];
  }

  // Sort snapshots by timestamp
  const sortedSnapshots = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);

  // Result array
  const result = [];

  // Get the timestamp of the first actual data
  const firstDataTimestamp = sortedSnapshots[0].timestamp;

  // Create a map of actual data by window
  const actualDataByWindow = new Map();
  sortedSnapshots.forEach(snapshot => {
    const windowStart = Math.floor(snapshot.timestamp / windowMs) * windowMs;
    if (!actualDataByWindow.has(windowStart)) {
      actualDataByWindow.set(windowStart, []);
    }
    actualDataByWindow.get(windowStart).push(snapshot);
  });

  // Generate data points for the entire time range
  for (let windowStart = Math.floor(startTime / windowMs) * windowMs;
    windowStart <= now;
    windowStart += windowMs) {

    const windowSnapshots = actualDataByWindow.get(windowStart);

    if (windowSnapshots && windowSnapshots.length > 0) {
      // Actual data - show point (dot visible)
      const latestInWindow = windowSnapshots[windowSnapshots.length - 1];
      const avgPortfolioValue = windowSnapshots.reduce((sum, s) => sum + (s.portfolioValue || 0), 0) / windowSnapshots.length;
      const avgTotalPnL = windowSnapshots.reduce((sum, s) => sum + (s.totalPnL || 0), 0) / windowSnapshots.length;

      result.push({
        timestamp: windowStart,
        portfolioValue: Number(avgPortfolioValue.toFixed(2)),
        totalPnL: Number(avgTotalPnL.toFixed(2)),
        activeBots: latestInWindow.activeBots || 0,
        botCount: latestInWindow.botCount || 0,
        snapshotCount: windowSnapshots.length,
        showPoint: true  // Show dot for actual data
      });
    } else if (windowStart < firstDataTimestamp) {
      // Before data exists - flatline at 0, NO dot visible
      result.push({
        timestamp: windowStart,
        portfolioValue: 0,
        totalPnL: 0,
        activeBots: 0,
        botCount: 0,
        snapshotCount: 0,
        showPoint: false  // No dot, just line
      });
    }
    // Gaps after data started are simply not included (line will connect the points)
  }

  const actualCount = result.filter(r => r.showPoint).length;
  const flatlineCount = result.filter(r => !r.showPoint).length;
  console.log(`[ChartData] Generated ${result.length} data points (${actualCount} actual with dots, ${flatlineCount} flatline without dots)`);

  return result;
}

function getChartDataForInterval(snapshots, interval) {
  const intervalMap = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  };

  const intervalMs = intervalMap[interval];
  if (!intervalMs) {
    throw new Error(`Invalid interval: ${interval}. Supported: 1h, 24h, 7d, 30d`);
  }

  return aggregateSnapshotsForInterval(snapshots, intervalMs);
}

async function savePortfolioSnapshot(userId, portfolioData) {
  try {
    console.log(`[HistoricalData] DEBUG: Starting savePortfolioSnapshot for user ${userId}`);

    // RACE CONDITION PROTECTION: Prevent concurrent saves for the same user
    if (savingInProgress.get(userId)) {
      console.log(`[HistoricalData] DEBUG: Save already in progress for user ${userId}, skipping`);
      return false;
    }

    savingInProgress.set(userId, true);
    console.log(`[HistoricalData] DEBUG: Acquired save lock for user ${userId}`);

    const userDir = path.join(BOT_BASE_DIR, userId);
    const snapshotPath = path.join(userDir, 'portfolio_snapshots.json');
    const tempPath = path.join(userDir, `.portfolio_snapshots_${Date.now()}_${process.pid}.tmp`);
    const backupPath = path.join(userDir, 'portfolio_snapshots.json.backup');
    const permanentBackupDir = path.join(userDir, 'permanent_backups');

    console.log(`[HistoricalData] DEBUG: Paths defined - userDir: ${userDir}, snapshotPath: ${snapshotPath}`);

    // Ensure user directory exists
    await fs.ensureDir(userDir);
    await fs.ensureDir(permanentBackupDir);

    // Track existing snapshot count for validation
    let existingSnapshotCount = 0;

    // Load existing data with bulletproof preservation
    const currentTime = Date.now();
    let data = {
      metadata: {
        firstSnapshot: currentTime,
        lastSnapshot: currentTime,
        totalSnapshots: 0,
        accountCreated: currentTime,
        compressionHistory: [],
        dataProtectionVersion: '3.0' // Track protection version
      },
      snapshots: [],
      lastUpdated: currentTime,
      version: '3.0'
    };

    // Read existing data if file exists
    if (await fs.pathExists(snapshotPath)) {
      try {
        console.log(`[HistoricalData] DEBUG: About to read existing data from ${snapshotPath}`);
        const existingData = await fs.readJson(snapshotPath);
        existingSnapshotCount = existingData?.snapshots?.length || 0;
        console.log(`[HistoricalData] DEBUG: Successfully read existing data (${existingSnapshotCount} snapshots)`);

        // Create backup before any modifications
        await fs.copy(snapshotPath, backupPath, { overwrite: true });
        console.log(`[HistoricalData] DEBUG: Main backup created successfully`);

        // Create timestamped backup (keep 100 instead of 10)
        const backupDir = path.join(userDir, 'historical_backups');
        await fs.ensureDir(backupDir);
        const uniqueTimestamp = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const timestampedBackupPath = path.join(backupDir, `portfolio_snapshots_${uniqueTimestamp}.json`);
        await fs.copy(snapshotPath, timestampedBackupPath, { overwrite: true });

        // Keep 100 timestamped backups instead of 10
        const backupFiles = (await fs.readdir(backupDir))
          .filter(f => f.startsWith('portfolio_snapshots_'))
          .sort();
        if (backupFiles.length > 100) {
          const filesToRemove = backupFiles.slice(0, -100);
          for (const file of filesToRemove) {
            await fs.remove(path.join(backupDir, file));
          }
        }

        // CREATE HOURLY PERMANENT BACKUP - these are never auto-deleted
        const lastHour = Math.floor(currentTime / (60 * 60 * 1000));
        const hourlyBackupPath = path.join(permanentBackupDir, `portfolio_hourly_${lastHour}.json`);
        if (!await fs.pathExists(hourlyBackupPath)) {
          console.log(`[HistoricalData] Creating hourly permanent backup at ${hourlyBackupPath}`);
          await fs.copy(snapshotPath, hourlyBackupPath, { overwrite: false });

          // Keep only last 720 hourly backups (30 days worth)
          const permanentFiles = (await fs.readdir(permanentBackupDir))
            .filter(f => f.startsWith('portfolio_hourly_'))
            .sort();
          if (permanentFiles.length > 720) {
            const oldFiles = permanentFiles.slice(0, -720);
            for (const file of oldFiles) {
              await fs.remove(path.join(permanentBackupDir, file));
            }
          }
        }

        // BULLETPROOF: Never overwrite existing historical data
        if (existingData && existingData.snapshots && Array.isArray(existingData.snapshots)) {
          data.snapshots = [...existingData.snapshots];
        }

        // BULLETPROOF: Preserve all existing metadata
        if (existingData && existingData.metadata) {
          data.metadata = {
            firstSnapshot: existingData.metadata.firstSnapshot ||
              (existingData.snapshots?.length > 0 ? existingData.snapshots[0].timestamp : currentTime),
            lastSnapshot: existingData.metadata.lastSnapshot || currentTime,
            totalSnapshots: existingData.metadata.totalSnapshots || existingData.snapshots?.length || 0,
            accountCreated: existingData.metadata.accountCreated || currentTime,
            compressionHistory: existingData.metadata.compressionHistory || [],
            dataProtectionVersion: '3.0'
          };
        }

        console.log(`[HistoricalData] Loaded existing data: ${data.snapshots.length} snapshots, account created: ${new Date(data.metadata.accountCreated).toISOString()}`);

      } catch (e) {
        console.error(`[HistoricalData] CRITICAL: Error reading existing snapshots for ${userId}:`, e.message);

        // Try multiple recovery sources in order of preference
        const recoverySources = [
          backupPath,
          ...((await fs.pathExists(path.join(userDir, 'historical_backups')))
            ? (await fs.readdir(path.join(userDir, 'historical_backups')))
              .filter(f => f.startsWith('portfolio_snapshots_'))
              .sort()
              .reverse()
              .slice(0, 5)
              .map(f => path.join(userDir, 'historical_backups', f))
            : []),
          ...((await fs.pathExists(permanentBackupDir))
            ? (await fs.readdir(permanentBackupDir))
              .filter(f => f.startsWith('portfolio_hourly_'))
              .sort()
              .reverse()
              .slice(0, 3)
              .map(f => path.join(permanentBackupDir, f))
            : [])
        ];

        for (const recoveryPath of recoverySources) {
          if (await fs.pathExists(recoveryPath)) {
            try {
              console.log(`[HistoricalData] Attempting recovery from: ${recoveryPath}`);
              const recoveredData = await fs.readJson(recoveryPath);
              if (recoveredData?.snapshots?.length > 0) {
                data = recoveredData;
                existingSnapshotCount = data.snapshots.length;
                console.log(`[HistoricalData] Successfully recovered ${data.snapshots.length} snapshots from ${recoveryPath}`);
                break;
              }
            } catch (recoveryError) {
              console.error(`[HistoricalData] Recovery failed from ${recoveryPath}:`, recoveryError.message);
            }
          }
        }
      }
    }

    // Add the new snapshot
    const snapshot = {
      timestamp: Date.now(),
      ...portfolioData
    };

    data.snapshots.push(snapshot);

    // DATA INTEGRITY CHECK: Refuse to save if we're losing significant data
    const newSnapshotCount = data.snapshots.length;
    if (existingSnapshotCount > 100 && newSnapshotCount < existingSnapshotCount * 0.5) {
      console.error(`[HistoricalData] CRITICAL DATA PROTECTION: Refusing to save! ` +
        `Would reduce from ${existingSnapshotCount} to ${newSnapshotCount} snapshots. ` +
        `This looks like data corruption. Manual intervention required.`);
      savingInProgress.delete(userId);
      return false;
    }

    // Update metadata
    data.metadata.lastSnapshot = snapshot.timestamp;
    data.metadata.totalSnapshots = data.snapshots.length;
    data.lastUpdated = Date.now();

    if (!data.metadata.firstSnapshot || data.snapshots.length === 1) {
      data.metadata.firstSnapshot = data.snapshots[0].timestamp;
    }

    // Compress old data if needed (keep last 10,000 snapshots)
    if (data.snapshots.length > 10000) {
      const keepCount = 8000;
      const removed = data.snapshots.length - keepCount;
      const oldFirstSnapshot = data.snapshots[0].timestamp;

      // Before compression, create a special archive backup
      const archivePath = path.join(permanentBackupDir, `portfolio_archive_${Date.now()}.json`);
      console.log(`[HistoricalData] Creating archive backup before compression: ${archivePath}`);
      await fs.writeJson(archivePath, data, { spaces: 2 });

      data.snapshots = data.snapshots.slice(-keepCount);
      data.metadata.firstSnapshot = data.snapshots[0].timestamp;
      data.metadata.totalSnapshots = data.snapshots.length;
      data.metadata.compressionHistory.push({
        timestamp: Date.now(),
        removedSnapshots: removed,
        oldFirstSnapshot: oldFirstSnapshot,
        newFirstSnapshot: data.metadata.firstSnapshot,
        archivePath: archivePath,
        reason: 'automatic_cleanup'
      });

      console.log(`[HistoricalData] Compressed data: removed ${removed} old snapshots, kept ${keepCount}`);
    }

    // ATOMIC WRITE: Write to unique temp file first, then rename
    console.log(`[HistoricalData] DEBUG: About to write to temp file ${tempPath}`);
    await fs.writeJson(tempPath, data, { spaces: 2 });

    // Verify temp file was written correctly
    const tempStats = await fs.stat(tempPath);
    if (tempStats.size < 100) {
      throw new Error(`Temp file too small (${tempStats.size} bytes), refusing to overwrite`);
    }

    console.log(`[HistoricalData] DEBUG: Temp file written (${tempStats.size} bytes), now copying to ${snapshotPath}`);
    await fs.copy(tempPath, snapshotPath, { overwrite: true });
    console.log(`[HistoricalData] DEBUG: Atomic write completed, cleaning up temp file`);
    await fs.remove(tempPath);

    console.log(`[HistoricalData] SAVED snapshot for user ${userId}: Value=${snapshot.portfolioValue.toFixed(2)}, Bots=${snapshot.activeBots}/${snapshot.botCount}, Total: ${data.snapshots.length} snapshots`);

    savingInProgress.delete(userId);
    return true;
  } catch (error) {
    console.error(`[HistoricalData] CRITICAL ERROR saving snapshot for user ${userId}:`, error);

    try {
      const tempPath = path.join(BOT_BASE_DIR, userId, 'portfolio_snapshots.json.tmp');
      if (await fs.pathExists(tempPath)) {
        await fs.remove(tempPath);
      }
    } catch (cleanupError) {
      console.error(`[HistoricalData] Temp file cleanup failed:`, cleanupError.message);
    }

    savingInProgress.delete(userId);
    return false;
  }
}

// --- Chart Data API Endpoints ---
app.get('/api/charts/portfolio/:interval', authenticateToken, async (req, res) => {
  try {
    const { interval } = req.params;
    const userId = req.user.id || req.user.uid;

    // Validate interval
    const validIntervals = ['1h', '24h', '7d', '30d'];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({
        success: false,
        message: `Invalid interval. Supported: ${validIntervals.join(', ')}`
      });
    }

    // Load user's portfolio snapshots
    const { snapshots, metadata } = await loadUserPortfolioSnapshots(userId);

    if (snapshots.length === 0) {
      return res.json({
        success: true,
        interval,
        data: [],
        metadata: {
          totalSnapshots: 0,
          dataPoints: 0,
          timeRange: null
        }
      });
    }

    // Generate chart data for the requested interval
    const chartData = getChartDataForInterval(snapshots, interval);

    res.json({
      success: true,
      interval,
      data: chartData,
      metadata: {
        totalSnapshots: snapshots.length,
        dataPoints: chartData.length,
        firstSnapshot: metadata.firstSnapshot,
        lastSnapshot: metadata.lastSnapshot,
        timeRange: {
          start: chartData.length > 0 ? chartData[0].timestamp : null,
          end: chartData.length > 0 ? chartData[chartData.length - 1].timestamp : null
        }
      }
    });

  } catch (error) {

    console.error('[ChartAPI] Error fetching chart data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chart data',
      error: error.message
    });
  }
});

app.get('/api/charts/portfolio', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.uid;
    console.log(`[ChartAPI] DEBUG: Portfolio request - User ID: ${userId}, User object:`, JSON.stringify(req.user, null, 2));

    // File-based debugging to capture frontend requests
    const fs = require('fs');
    const debugInfo = {
      timestamp: new Date().toISOString(),
      userId: userId,
      userObject: req.user,
      query: req.query,
      userAgent: req.get('User-Agent'),
      authHeader: req.get('Authorization') ? 'present' : 'missing'
    };

    try {
      fs.appendFileSync('/tmp/portfolio_frontend_debug.log',
        JSON.stringify(debugInfo, null, 2) + '\n---\n');
    } catch (e) {
      console.log('Debug file write error:', e.message);
    }

    const { snapshots, metadata } = await loadUserPortfolioSnapshots(userId);
    console.log(`[ChartAPI] DEBUG: Loaded ${snapshots.length} snapshots for user ${userId}`);

    if (snapshots.length === 0) {
      return res.json({
        success: true,
        intervals: {
          '1h': { data: [], dataPoints: 0 },
          '24h': { data: [], dataPoints: 0 },
          '7d': { data: [], dataPoints: 0 },
          '30d': { data: [], dataPoints: 0 }
        },
        metadata: {
          totalSnapshots: 0,
          firstSnapshot: null,
          lastSnapshot: null
        }
      });
    }

    // Generate chart data for all intervals
    const intervals = {
      '1h': getChartDataForInterval(snapshots, '1h'),
      '24h': getChartDataForInterval(snapshots, '24h'),
      '7d': getChartDataForInterval(snapshots, '7d'),
      '30d': getChartDataForInterval(snapshots, '30d')
    };

    // Debug logging for interval data
    Object.entries(intervals).forEach(([interval, data]) => {
      console.log(`[ChartAPI] DEBUG: ${interval} interval generated ${data.length} data points`);
    });

    res.json({
      success: true,
      intervals: Object.fromEntries(
        Object.entries(intervals).map(([key, data]) => [
          key,
          {
            data,
            dataPoints: data.length,
            timeRange: data.length > 0 ? {
              start: data[0].timestamp,
              end: data[data.length - 1].timestamp
            } : null
          }
        ])
      ),
      metadata: {
        totalSnapshots: snapshots.length,
        firstSnapshot: metadata.firstSnapshot,
        lastSnapshot: metadata.lastSnapshot
      }
    });

  } catch (error) {
    console.error('[ChartAPI] Error fetching all chart data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chart data',
      error: error.message
    });
  }
});

app.get('/api/portfolio/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.uid;
    const { limit = 1000, offset = 0 } = req.query;

    const { snapshots, metadata } = await loadUserPortfolioSnapshots(userId);

    // Apply pagination
    const startIndex = Math.max(0, snapshots.length - Number(limit) - Number(offset));
    const endIndex = Math.max(0, snapshots.length - Number(offset));
    const paginatedSnapshots = snapshots.slice(startIndex, endIndex);

    res.json({
      success: true,
      snapshots: paginatedSnapshots,
      pagination: {
        total: snapshots.length,
        limit: Number(limit),
        offset: Number(offset),
        returned: paginatedSnapshots.length
      },
      metadata
    });

  } catch (error) {
    console.error('[HistoryAPI] Error fetching portfolio history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch portfolio history',
      error: error.message
    });
  }
});

// --- Helper functions for streaming data ---
async function getChartDataForUser(userId) {
  try {
    // Get recent portfolio snapshots for chart data
    const userDir = path.join(BOT_BASE_DIR, userId);
    const snapshotsFile = path.join(userDir, 'portfolio_snapshots.json');

    if (!await fs.pathExists(snapshotsFile)) {
      return { points: [], latestValue: 0 };
    }

    const snapshotsData = JSON.parse(await fs.readFile(snapshotsFile, 'utf8'));
    const snapshots = snapshotsData.snapshots || [];

    // Convert snapshots to chart points (last 50 points)
    const points = snapshots.slice(-50).map(snapshot => ({
      timestamp: snapshot.timestamp,
      value: snapshot.portfolioValue || 0,
      pnl: snapshot.totalPnL || 0
    }));

    const latestValue = points.length > 0 ? points[points.length - 1].value : 0;

    return { points, latestValue, count: points.length };
  } catch (error) {
    console.warn(`[Chart] Error getting chart data for ${userId}:`, error.message);
    return { points: [], latestValue: 0 };
  }
}

async function getPositionsForUser(userId) {
  try {
    const bots = await listUserBotInstances(userId);
    const allPositions = [];

    for (const bot of bots) {
      if (bot.containerStatus !== 'running') continue;

      try {
        // Get status which includes open trades data
        const statusData = await proxyFreqtradeApiRequest(bot.instanceId, '/api/v1/status');

        if (statusData && Array.isArray(statusData)) {
          const positions = statusData
            .filter(trade => trade.is_open) // Only open positions
            .map(trade => ({
              botId: bot.instanceId,
              pair: trade.pair,
              side: trade.is_short ? 'short' : 'long',
              amount: trade.amount || 0,
              entryPrice: trade.open_rate || 0,
              currentPrice: trade.current_rate || trade.open_rate || 0,
              pnl: trade.profit_abs || 0,
              pnlPercent: trade.profit_ratio ? (trade.profit_ratio * 100) : 0,
              status: trade.is_open ? 'open' : 'closed'
            }));

          allPositions.push(...positions);
        }
      } catch (botError) {
        console.warn(`[Positions] Error getting positions from ${bot.instanceId}:`, botError.message);
      }
    }

    return { positions: allPositions, count: allPositions.length };
  } catch (error) {
    console.warn(`[Positions] Error getting positions for ${userId}:`, error.message);
    return { positions: [], count: 0 };
  }
}

async function getSecurityData(userId) {
  try {
    // Get actual trading pairs from current positions
    const positionsData = await getPositionsForUser(userId);
    const activePairs = [...new Set(positionsData.positions.map(pos => pos.pair))];

    // If no active positions, don't generate any security data
    if (activePairs.length === 0) {
      console.log(`🔒 No active positions for ${userId} - no security data generated`);
      return null;
    }

    // Randomly select one of the active pairs for this update
    const randomPair = activePairs[Math.floor(Math.random() * activePairs.length)];

    // Generate realistic price based on the actual pair
    let basePrice = 50000; // Default
    if (randomPair.includes('BTC')) basePrice = 45000;
    else if (randomPair.includes('ETH')) basePrice = 3000;
    else if (randomPair.includes('ADA')) basePrice = 0.5;
    else if (randomPair.includes('SOL')) basePrice = 100;
    else if (randomPair.includes('DOT')) basePrice = 25;

    // Add some random variation (+/- 5%)
    const variation = (Math.random() - 0.5) * 0.1; // -5% to +5%
    const price = basePrice * (1 + variation);

    console.log(`🔒 Security data: ${randomPair} = $${price.toFixed(4)} (from active positions: ${activePairs.join(', ')})`);

    return {
      pair: randomPair,
      price: price,
      timestamp: Date.now(),
      exchange: 'kraken'
    };
  } catch (error) {
    console.warn(`[Security] Error generating security data:`, error.message);
    return null;
  }
}

// --- SSE Streaming with Historical Data Saving ---
app.get('/api/stream', async (req, res) => {
  try {
    // Force immediate output to both stderr and stdout
    console.log(`[SSE] =============== NEW CONNECTION ===============`);
    console.log(`[SSE] Incoming connection from ${req.ip}`);
    console.log(`[SSE] Query params:`, req.query);
    console.log(`[SSE] Headers origin:`, req.headers.origin);

    const user = await authenticateSSE(req);
    if (!user || !(user.id || user.uid)) {
      console.log(`[SSE] ❌ Authentication FAILED for ${req.ip}`);
      return res.status(401).json({ error: 'Authentication failed' });
    }
    console.log(`[SSE] ✅ User authenticated successfully: ${user.id || user.uid}`);

    // SSE headers - Send immediately using writeHead
    const sseHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable buffering on Nginx
    };

    // Explicitly write head to force headers to be sent
    res.writeHead(200, sseHeaders);
    // res.flushHeaders?.(); // Not needed if writeHead is used

    const userId = user.id || user.uid;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[SSE] Opened stream for ${userId} from ${ip}`);

    let closed = false;
    let streamInterval;

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now(), status: 'connected' })}\n\n`);

    // Portfolio streaming function
    async function streamPortfolioData() {
      if (closed) return;

      try {
        const portfolioData = await aggregateUserPortfolio(userId);

        // Save snapshot automatically (with throttling - every 30 seconds)
        if (portfolioData && portfolioData.activeBots > 0) {
          const lastSnapshotTime = userLastSnapshotTime.get(userId) || 0;
          const currentTime = Date.now();
          const throttleInterval = 30000; // 30 seconds

          if (currentTime - lastSnapshotTime > throttleInterval) {
            console.log(`[HistoricalData] Saving throttled snapshot for user ${userId} (${Math.round((currentTime - lastSnapshotTime) / 1000)}s since last)`);

            // Check if already saving to prevent race conditions
            if (savingInProgress.get(userId)) {
              console.log(`[HistoricalData] DEBUG: Snapshot save already in progress for ${userId}, skipping duplicate call`);
            } else {
              console.log(`[HistoricalData] DEBUG: About to call savePortfolioSnapshot for ${userId}`);
              await savePortfolioSnapshot(userId, portfolioData);
            }
            userLastSnapshotTime.set(userId, currentTime);
          }
        }

        // Send portfolio update via SSE
        const eventData = JSON.stringify(portfolioData);
        res.write(`event: portfolio\ndata: ${eventData}\n\n`);

        // Send chart data (historical points for charting)
        const chartData = await getChartDataForUser(userId);
        if (chartData && chartData.points) {
          res.write(`event: chart\ndata: ${JSON.stringify(chartData)}\n\n`);
        }

        // Send positions data
        const positionsData = await getPositionsForUser(userId);
        if (positionsData) {
          res.write(`event: positions\ndata: ${JSON.stringify(positionsData)}\n\n`);
        }

        // Send security data for active positions
        const securityData = await getSecurityData(userId);
        if (securityData) {
          res.write(`event: security\ndata: ${JSON.stringify(securityData)}\n\n`);
        }

      } catch (error) {
        console.error(`[SSE] Error streaming for ${userId}:`, error);
        if (!closed) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream error', message: error.message })}\n\n`);
        }
      }
    }

    // Start streaming - send updates every 5 seconds
    streamPortfolioData(); // Send initial data immediately
    streamInterval = setInterval(streamPortfolioData, 5000);

    // Handle client disconnect
    req.on('close', () => {
      if (!closed) {
        closed = true;
        console.log(`[SSE] Closed stream for ${userId}`);
        if (streamInterval) {
          clearInterval(streamInterval);
        }
      }
    });

    req.on('error', (err) => {
      console.error(`[SSE] Error for ${userId}:`, err);
      closed = true;
      if (streamInterval) {
        clearInterval(streamInterval);
      }
    });

  } catch (error) {
    console.error('[SSE] Authentication or setup error:', error);
    res.status(500).end();
  }
});

// --- SSE Authentication helper (supports ?token= for EventSource) ---
async function authenticateSSE(req) {
  console.log('[SSE-Auth] =============== AUTHENTICATION START ===============');
  try {
    const header = req.header('Authorization');
    let token = null;
    if (header && header.startsWith('Bearer ')) token = header.split(' ')[1];
    if (!token) token = req.query.token; // EventSource cannot set headers

    console.log('[SSE-Auth] Token source:', header ? 'Authorization header' : (req.query.token ? 'Query param' : 'None'));
    console.log('[SSE-Auth] Token length:', token ? token.length : 0);

    if (!token && req.cookies) token = req.cookies.token; // Try cookie (HttpOnly)
    if (!token) {
      console.log('[SSE-Auth] ❌ No token found');
      return null;
    }

    console.log('[SSE-Auth] Token found, attempting authentication...');

    // Detect token type by checking the header
    try {
      const decodedHeader = jwt.decode(token, { complete: true });
      const algorithm = decodedHeader?.header?.alg;
      console.log('[SSE-Auth] Token algorithm:', algorithm);
      
      // If it's HS256, it's our local JWT - try that first
      if (algorithm === 'HS256') {
        console.log('[SSE-Auth] Detected HS256 token, trying local JWT first...');
        
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          const u = decoded.user || decoded;
          const user = { id: u.id || u.uid, uid: u.uid || u.id, email: u.email, role: u.role || 'user' };
          console.log(`[SSE-Auth] ✅ Local JWT SUCCESS! User: ${user.id}`);
          return user;
        } catch (e) {
          console.log(`[SSE-Auth] ❌ Local JWT failed: ${e.message}`);
          // Don't try Firebase for HS256 tokens
          return null;
        }
      }
    } catch (err) {
      console.log('[SSE-Auth] Token header decode failed:', err.message);
    }

    // Try Firebase Admin first if available (for RS256 tokens)
    if (firebaseInitialized) {
      try {
        console.log('[SSE] Trying Firebase Admin verification...');
        process.stderr.write('[SSE DEBUG] Trying Firebase Admin...\n');
        const decoded = await admin.auth().verifyIdToken(token);
        const user = { id: decoded.uid, uid: decoded.uid, email: decoded.email, role: decoded.admin ? 'admin' : 'user' };
        console.log(`[SSE] Auth via Firebase Admin: ${user.uid}`);
        return user;
      } catch (e) {
        process.stderr.write(`[SSE DEBUG] Firebase Admin failed: ${e.message}\n`);
        console.warn(`[SSE] Firebase Admin verify failed: ${e.message}. Falling back to JWKS.`);
      }
    }

    // Try Firebase verification via JWKS (no service account required)
    console.log('[SSE] Trying Firebase JWKS verification...');
    process.stderr.write('[SSE DEBUG] Trying Firebase JWKS...\n');
    const firebaseUser = await verifyFirebaseIdTokenWithoutAdmin(token);
    if (firebaseUser) {
      console.log(`[SSE] Auth via Firebase JWKS: ${firebaseUser.uid}`);
      return firebaseUser;
    }
    process.stderr.write('[SSE DEBUG] Firebase JWKS failed\n');
    console.log('[SSE] Firebase JWKS verification failed, trying local JWT...');

    // Fallback: Local JWT (for non-Firebase tokens)
    try {
      console.log('[SSE] Trying local JWT verification...');
      process.stderr.write(`[SSE DEBUG] Trying local JWT, JWT_SECRET exists: ${!!process.env.JWT_SECRET}\n`);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const u = decoded.user || decoded;
      const user = { id: u.id || u.uid, uid: u.uid || u.id, email: u.email, role: u.role || 'user' };
      process.stderr.write(`[SSE DEBUG] Local JWT SUCCESS! User: ${user.id}\n`);
      console.log(`[SSE] Auth via local JWT: ${user.id}`);
      return user;
    } catch (e) {
      process.stderr.write(`[SSE DEBUG] Local JWT ERROR: ${e.message}\n`);
      console.warn(`[SSE] Local JWT verify failed: ${e.message}`);
    }

    console.warn('[SSE] All authentication methods failed');
    return null;
  } catch (error) {
    console.error('[SSE] Authentication error:', error);
    return null;
  }
}

// --- Constants ---
const timestamp = new Date().toISOString();
console.log(`=================================================`);
console.log(` Freqtrade Bot Manager (API Gateway + SSE)`);
console.log(`-------------------------------------------------`);
console.log(` HTTP Server: http://0.0.0.0:${PORT}`);
console.log(` SSE Stream: GET /api/stream?token=...`);
console.log(` Bot Instance Base Dir: ${BOT_BASE_DIR}`);
console.log(` Main Strategies Source: ${MAIN_STRATEGIES_SOURCE_DIR}`);
console.log(` SHARED Data Directory: ${SHARED_DATA_DIR}`);
console.log(` Firebase Admin: ${firebaseInitialized ? 'enabled' : 'not initialized'}; Project: ${process.env.FIREBASE_PROJECT_ID || 'n/a'}`);
console.log(`=================================================`);

// --- Server Start ---
// --- Reverse Proxy for Freqtrade API ---
// Allows the frontend to communicate with individual bot instances securely
app.use('/api/proxy/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  const { instanceId } = req.params;
  const apiPath = req.url; // Capture the path after /api/proxy/:instanceId including query params

  try {
    // 1. Get bot configuration from request (attached by checkInstanceOwnership)
    const config = req.botConfig;
    if (!config) return res.status(500).json({ error: 'Config missing' });
    
    let targetHost, targetPort;
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Check if bot is in pool mode
    if (poolSystemInitialized && isInstancePooled(instanceId)) {
      try {
        const connection = await poolProvisioner.getBotConnection(instanceId);
        if (connection) {
          // Pool mode: use pool container's external port
          // Since bot-orchestrator runs on host, always use localhost with the mapped port
          // The pool container maps ports to host (e.g., 9000-9002 -> 9000-9002)
          targetHost = 'localhost';
          targetPort = connection.port;
          console.log(`[Proxy] Pool mode: ${instanceId} -> ${targetHost}:${targetPort}`);
        }
      } catch (err) {
        console.warn(`[Proxy] Failed to get pool connection for ${instanceId}:`, err.message);
      }
    }
    
    // Fallback to legacy mode if pool info not available
    if (!targetHost) {
      const port = config.api_server?.listen_port || 8080;
      targetHost = isProduction ? `freqtrade-${instanceId}` : '127.0.0.1';
      targetPort = isProduction ? 8080 : port;
      console.log(`[Proxy] Legacy mode: ${instanceId} -> ${targetHost}:${targetPort}`);
    }
    
    const baseUrl = `http://${targetHost}:${targetPort}`;
    const targetUrl = `${baseUrl}${apiPath}`;

    // 2. Prepare request options
    let options = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    // Inject Authentication using per-instance JWT (fetch via Basic login)
    const requestingToken = apiPath.startsWith('/api/v1/token');
    const canAuth = config.api_server?.username && config.api_server?.password;
    if (!requestingToken && canAuth) {
      try {
        const bearerToken = await getInstanceApiToken(
          instanceId,
          baseUrl,
          config.api_server.username,
          config.api_server.password
        );
        options.headers['Authorization'] = `Bearer ${bearerToken}`;
      } catch (tokenErr) {
        console.error(`[Proxy] Failed to obtain token for ${instanceId}:`, tokenErr.message);
        return res.status(401).json({ error: 'Unauthorized (bot token failed)', details: tokenErr.message });
      }
    } else if (requestingToken && canAuth) {
      const auth = Buffer.from(`${config.api_server.username}:${config.api_server.password}`).toString('base64');
      options.headers['Authorization'] = `Basic ${auth}`;
    }

    // Forward body for write methods
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }

    // Helper to execute proxy fetch (used for retries)
    const executeProxyFetch = async () => {
      console.log(`[Proxy] Fetching: ${targetUrl}`);
      const resp = await fetch(targetUrl, options);
      console.log(`[Proxy] Response status: ${resp.status}`);
      return resp;
    };

    let response = await executeProxyFetch();

    // If bot token is stale/invalid, refresh once and retry
    if (response.status === 401 && canAuth && !requestingToken) {
      console.warn(`[Proxy] 401 from bot ${instanceId} on ${apiPath}, refreshing token and retrying once`);
      freqtradeTokenCache.delete(instanceId);
      try {
        const freshToken = await getInstanceApiToken(
          instanceId,
          baseUrl,
          config.api_server.username,
          config.api_server.password
        );
        options = {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${freshToken}`
          }
        };
        response = await executeProxyFetch();
      } catch (refreshErr) {
        console.error(`[Proxy] Token refresh failed for ${instanceId}:`, refreshErr.message);
        return res.status(401).json({ error: 'Unauthorized (token refresh failed)', details: refreshErr.message });
      }
    }

    // 4. Handle response
    res.status(response.status);

    const contentType = response.headers.get('content-type');

    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      res.send(text);
    }

  } catch (error) {
    console.error(`[Proxy] Error fetching ${req.url}:`, error);
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      return res.status(502).json({ error: 'Bot is offline', code: 'BOT_OFFLINE' });
    }
    console.error(`[Proxy] Error forwarding to ${instanceId}:`, error.message);
    res.status(500).json({ error: 'Proxy request failed', details: error.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`=================================================`);
  console.log(` Freqtrade Bot Manager (API Gateway + SSE)`);
  console.log(`-------------------------------------------------`);
  console.log(` HTTP Server: http://0.0.0.0:${PORT}`);
  console.log(` SSE Stream: GET /api/stream?token=...`);
  console.log(` Bot Instance Base Dir: ${BOT_BASE_DIR}`);
  console.log(` Main Strategies Source: ${MAIN_STRATEGIES_SOURCE_DIR}`);
  console.log(` SHARED Data Directory: ${SHARED_DATA_DIR}`);
  console.log(` Firebase Admin: ${firebaseInitialized ? 'enabled' : 'not initialized'}; Project: ${process.env.FIREBASE_PROJECT_ID || 'n/a'}`);
  console.log(` Pool Mode: ${POOL_MODE_ENABLED ? 'ENABLED' : 'DISABLED (legacy)'}`);
  console.log(`=================================================`);
  
  // Initialize Pool System (Phase 2: Multi-Tenant Architecture)
  if (POOL_MODE_ENABLED) {
    try {
      console.log('[Server] Initializing Container Pool System...');
      await initPoolSystem({
        enableHealthMonitor: true
      });
      poolSystemInitialized = true;
      console.log('[Server] ✅ Container Pool System initialized');
    } catch (poolError) {
      console.error('[Server] ❌ Failed to initialize Pool System:', poolError.message);
      console.warn('[Server] Falling back to legacy mode (one container per bot)');
    }
  }
  
  // Start Active Trade Monitor for universal features (take profit, trailing stop, etc.)
  try {
    console.log('[Server] Starting Active Trade Monitor...');
    const monitor = getMonitor(BOT_BASE_DIR);
    await monitor.start();
    console.log('[Server] ✅ Active Trade Monitor started successfully');
  } catch (monitorError) {
    console.warn('[Server] ⚠️ Failed to start Active Trade Monitor:', monitorError.message);
    console.warn('[Server] Universal features (take profit, trailing stop) will not be actively managed');
  }
});

// Export functions used by other modules
module.exports = {
  proxyFreqtradeApiRequest,
  runDockerCommand,
  resolveInstanceDir,
  BOT_BASE_DIR,
  setPortfolioMonitor,
  // Phase 2: Export pool-related functions
  poolProvisioner,
  getPoolAwareBotUrl,
  isInstancePooled,
  getPoolComponents,
  POOL_MODE_ENABLED
};

// Graceful shutdown - stop monitor, pool system, and server
process.on('SIGTERM', async () => { 
  console.log('SIGTERM: closing server');
  const monitor = getMonitor();
  if (monitor && monitor.running) {
    monitor.stop();
  }
  // Shutdown pool system gracefully
  if (poolSystemInitialized) {
    try {
      await shutdownPoolSystem();
    } catch (err) {
      console.error('Pool system shutdown error:', err.message);
    }
  }
  server.close(() => { console.log('Server closed'); process.exit(0); }); 
  setTimeout(() => process.exit(1), 10000); 
});
process.on('SIGINT', async () => { 
  console.log('SIGINT: closing server');
  const monitor = getMonitor();
  if (monitor && monitor.running) {
    monitor.stop();
  }
  // Shutdown pool system gracefully
  if (poolSystemInitialized) {
    try {
      await shutdownPoolSystem();
    } catch (err) {
      console.error('Pool system shutdown error:', err.message);
    }
  }
  server.close(() => { console.log('Server closed'); process.exit(0); }); 
  setTimeout(() => process.exit(1), 10000); 
});

// --- Positions API Endpoint ---
app.get('/api/portfolio/positions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.uid;
    const { status = 'all' } = req.query; // 'open', 'closed', 'all'

    // Get current portfolio data which includes all bot positions
    const portfolioData = await aggregateUserPortfolio(userId);

    if (!portfolioData || !portfolioData.bots) {
      return res.json({
        success: true,
        positions: [],
        summary: {
          totalPositions: 0,
          openPositions: 0,
          closedPositions: 0,
          totalUnrealizedPnL: 0,
          totalRealizedPnL: 0
        }
      });
    }

    let allPositions = [];
    let totalUnrealizedPnL = 0;
    let totalRealizedPnL = 0;

    // Extract positions from all bots
    for (const bot of portfolioData.bots) {
      if (bot.status && Array.isArray(bot.status)) {
        for (const trade of bot.status) {
          // Filter based on status query parameter
          if (status === 'open' && !trade.is_open) continue;
          if (status === 'closed' && trade.is_open) continue;

          const position = {
            // Bot information
            botId: bot.instanceId,

            // Trade identification
            tradeId: trade.trade_id,
            pair: trade.pair,
            baseCurrency: trade.base_currency,
            quoteCurrency: trade.quote_currency,
            exchange: trade.exchange,
            strategy: trade.strategy,

            // Position details
            isOpen: trade.is_open,
            isShort: trade.is_short || false,
            amount: trade.amount,
            stakeAmount: trade.stake_amount,
            leverage: trade.leverage || 1,
            tradingMode: trade.trading_mode || 'spot',

            // Entry information
            openDate: trade.open_date,
            openTimestamp: trade.open_timestamp,
            openRate: trade.open_rate,
            openTradeValue: trade.open_trade_value,

            // Exit information (null if position is open)
            closeDate: trade.close_date,
            closeTimestamp: trade.close_timestamp,
            closeRate: trade.close_rate,
            exitReason: trade.exit_reason,

            // P&L information
            profitRatio: trade.profit_ratio || 0,
            profitPct: trade.profit_pct || 0,
            profitAbs: trade.profit_abs || 0,
            totalProfitAbs: trade.total_profit_abs || 0,
            totalProfitRatio: trade.total_profit_ratio || 0,
            realizedProfit: trade.realized_profit || 0,

            // Current market information
            currentRate: trade.current_rate,
            minRate: trade.min_rate,
            maxRate: trade.max_rate,

            // Risk management
            stopLossAbs: trade.stop_loss_abs,
            stopLossRatio: trade.stop_loss_ratio,
            stopLossPct: trade.stop_loss_pct,

            // Fee information
            feeOpen: trade.fee_open || 0,
            feeOpenCost: trade.fee_open_cost || 0,
            feeClose: trade.fee_close || 0,
            feeCloseCost: trade.fee_close_cost || 0,

            // Order information
            hasOpenOrders: trade.has_open_orders || false,
            orderCount: trade.orders ? trade.orders.length : 0,

            // Additional metrics
            timeframe: trade.timeframe,
            enterTag: trade.enter_tag || '',

            // Calculated fields
            durationMinutes: trade.is_open && trade.open_timestamp ?
              Math.floor((Date.now() - trade.open_timestamp) / (1000 * 60)) : null,
            profitUsd: trade.total_profit_abs || trade.profit_abs || 0
          };

          allPositions.push(position);

          // Accumulate P&L
          if (trade.is_open) {
            totalUnrealizedPnL += (trade.total_profit_abs || trade.profit_abs || 0);
          } else {
            totalRealizedPnL += (trade.total_profit_abs || trade.profit_abs || 0);
          }
        }
      }
    }

    // Sort positions by open timestamp (newest first)
    allPositions.sort((a, b) => (b.openTimestamp || 0) - (a.openTimestamp || 0));

    // Calculate summary statistics
    const openPositions = allPositions.filter(p => p.isOpen);
    const closedPositions = allPositions.filter(p => !p.isOpen);

    const summary = {
      totalPositions: allPositions.length,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      totalUnrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
      totalRealizedPnL: Number(totalRealizedPnL.toFixed(2)),
      totalPnL: Number((totalUnrealizedPnL + totalRealizedPnL).toFixed(2)),

      // Additional summary stats
      uniquePairs: [...new Set(allPositions.map(p => p.pair))].length,
      uniqueBots: [...new Set(allPositions.map(p => p.botId))].length,
      totalStakeAmount: Number(allPositions.reduce((sum, p) => sum + (p.stakeAmount || 0), 0).toFixed(2)),
      averagePositionSize: allPositions.length > 0 ?
        Number((allPositions.reduce((sum, p) => sum + (p.stakeAmount || 0), 0) / allPositions.length).toFixed(2)) : 0,

      // Profit statistics
      profitablePositions: allPositions.filter(p => (p.profitAbs || 0) > 0).length,
      losingPositions: allPositions.filter(p => (p.profitAbs || 0) < 0).length,
      winRate: allPositions.length > 0 ?
        Number(((allPositions.filter(p => (p.profitAbs || 0) > 0).length / allPositions.length) * 100).toFixed(2)) : 0
    };

    res.json({
      success: true,
      positions: allPositions,
      summary,
      metadata: {
        timestamp: Date.now(),
        userId,
        filter: status,
        source: 'live_data'
      }
    });

  } catch (error) {
    console.error('[PositionsAPI] Error fetching positions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch positions',
      error: error.message
    });
  }
});

app.get('/api/portfolio/positions/:botId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.uid;
    const { botId } = req.params;
    const { status = 'all' } = req.query;

    // Get current portfolio data
    const portfolioData = await aggregateUserPortfolio(userId);

    if (!portfolioData || !portfolioData.bots) {
      return res.status(404).json({
        success: false,
        message: 'No bots found for user'
      });
    }

    // Find the specific bot
    const bot = portfolioData.bots.find(b => b.instanceId === botId);
    if (!bot) {
      return res.status(404).json({
        success: false,
        message: `Bot ${botId} not found`
      });
    }

    let positions = [];

    if (bot.status && Array.isArray(bot.status)) {
      for (const trade of bot.status) {
        // Filter based on status query parameter
        if (status === 'open' && !trade.is_open) continue;
        if (status === 'closed' && trade.is_open) continue;

        const position = {
          tradeId: trade.trade_id,
          pair: trade.pair,
          baseCurrency: trade.base_currency,
          quoteCurrency: trade.quote_currency,
          exchange: trade.exchange,
          strategy: trade.strategy,
          isOpen: trade.is_open,
          isShort: trade.is_short || false,
          amount: trade.amount,
          stakeAmount: trade.stake_amount,
          openDate: trade.open_date,
          openTimestamp: trade.open_timestamp,
          openRate: trade.open_rate,
          currentRate: trade.current_rate,
          profitAbs: trade.profit_abs || 0,
          profitPct: trade.profit_pct || 0,
          profitRatio: trade.profit_ratio || 0,
          totalProfitAbs: trade.total_profit_abs || 0,
          stopLossAbs: trade.stop_loss_abs,
          hasOpenOrders: trade.has_open_orders || false,
          orders: trade.orders || []
        };

        positions.push(position);
      }
    }

    // Sort by open timestamp (newest first)
    positions.sort((a, b) => (b.openTimestamp || 0) - (a.openTimestamp || 0));

    res.json({
      success: true,
      botId,
      positions,
      summary: {
        totalPositions: positions.length,
        openPositions: positions.filter(p => p.isOpen).length,
        closedPositions: positions.filter(p => !p.isOpen).length,
        totalPnL: positions.reduce((sum, p) => sum + (p.totalProfitAbs || 0), 0)
      }
    });

  } catch (error) {
    console.error('[PositionsAPI] Error fetching bot positions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bot positions',
      error: error.message
    });
  }
});

// --- ENHANCED RISK MANAGEMENT API ENDPOINTS ---

// Get risk management configuration for a bot (now uses UniversalRiskManager)
app.get('/api/bots/:instanceId/risk-config', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const user = req.user || {};
    const userId = user.uid || user.id;

    // Use UniversalRiskManager to get computed risk config from bot-settings.json
    const riskManager = new UniversalRiskManager(instanceId, userId, req.instanceDir);
    await riskManager.loadSettings();

    // Get the computed risk config based on current riskLevel
    const riskConfig = riskManager.getRiskConfig();

    res.json({
      success: true,
      instanceId,
      riskConfig,
      settings: {
        enabled: riskManager.settings.enabled,
        riskLevel: riskManager.settings.riskLevel,
        dcaEnabled: riskManager.settings.dcaEnabled,
        autoRebalance: riskManager.settings.autoRebalance
      }
    });

  } catch (error) {
    console.error(`[RiskAPI] Error getting risk config for ${req.params.instanceId}:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update risk management configuration for a bot (now uses UniversalRiskManager)
app.put('/api/bots/:instanceId/risk-config', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { riskLevel, dcaEnabled, autoRebalance, enabled } = req.body;
    const user = req.user || {};
    const userId = user.uid || user.id;

    // Validate riskLevel if provided
    if (riskLevel !== undefined && (riskLevel < 0 || riskLevel > 100)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Risk level must be between 0 and 100' 
      });
    }

    // Use UniversalRiskManager to update settings in bot-settings.json
    const riskManager = new UniversalRiskManager(instanceId, userId, req.instanceDir);
    await riskManager.loadSettings();

    // Build settings update object
    const settingsUpdate = {};
    if (riskLevel !== undefined) settingsUpdate.riskLevel = riskLevel;
    if (dcaEnabled !== undefined) settingsUpdate.dcaEnabled = dcaEnabled;
    if (autoRebalance !== undefined) settingsUpdate.autoRebalance = autoRebalance;
    if (enabled !== undefined) settingsUpdate.enabled = enabled;

    await riskManager.updateSettings(settingsUpdate);
    console.log(`[RiskAPI] ✓ Risk settings updated for ${instanceId} via UniversalRiskManager`);

    // Update bot's main config.json with risk settings (use req.instanceDir for pool support)
    const instanceDir = req.instanceDir || path.join(BOT_BASE_DIR, userId, instanceId);
    const configPath = path.join(instanceDir, 'config.json');

    if (await fs.pathExists(configPath)) {
      try {
        const botConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
        const computedRiskConfig = riskManager.getRiskConfig();

        // Update strategy-specific parameters based on computed risk config
        botConfig.max_open_trades = Math.min(Math.floor(1 / computedRiskConfig.riskPerTrade), 25);
        botConfig.stoploss = computedRiskConfig.stopLoss.baseStopLoss;

        // Update trailing stop settings
        if (computedRiskConfig.stopLoss.trailingStop) {
          botConfig.trailing_stop = true;
          botConfig.trailing_stop_positive = 0.02;
          botConfig.trailing_stop_positive_offset = 0.04;
        } else {
          botConfig.trailing_stop = false;
        }

        await fs.writeFile(configPath, JSON.stringify(botConfig, null, 2));
        console.log(`[RiskAPI] ✓ Bot config updated for ${instanceId}`);

        // Restart bot if running to apply new settings
        const containerName = `freqtrade-${instanceId}`;
        try {
          const statusOutput = await runDockerCommand(['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
          const isRunning = statusOutput.includes(containerName);

          if (isRunning) {
            console.log(`[RiskAPI] Restarting ${instanceId} to apply risk settings...`);
            await runDockerCommand(['restart', containerName]);
            console.log(`[RiskAPI] ✓ Bot restarted successfully`);
          }
        } catch (restartErr) {
          console.warn(`[RiskAPI] Failed to restart bot: ${restartErr.message}`);
        }

      } catch (configErr) {
        console.warn(`[RiskAPI] Failed to update bot config: ${configErr.message}`);
      }
    }

    // Clear API interceptor cache to ensure fresh settings on next request
    apiInterceptor.clearCache(instanceId, userId);

    res.json({
      success: true,
      message: 'Risk configuration updated successfully',
      instanceId,
      settings: riskManager.settings,
      riskConfig: riskManager.getRiskConfig()
    });

  } catch (error) {
    console.error(`[RiskAPI] Error updating risk config for ${req.params.instanceId}:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get available risk management templates
app.get('/api/risk-templates', authenticateToken, async (req, res) => {
  try {
    const templates = {
      conservative: {
        name: 'Conservative',
        description: 'Low risk, steady growth approach',
        maxDrawdown: 0.10,
        maxTotalRisk: 0.15,
        riskPerTrade: 0.015,
        positionSizing: {
          baseStakePercent: 0.08,
          maxStakePercent: 0.15,
          volatilityAdjustment: true
        },
        stopLoss: {
          enabled: true,
          baseStopLoss: -0.06,
          trailingStop: true,
          dynamicAdjustment: true
        },
        dca: {
          enabled: true,
          maxOrders: 2,
          triggerPercent: -0.05,
          sizeMultiplier: 1.2
        }
      },
      balanced: {
        name: 'Balanced',
        description: 'Moderate risk with balanced growth potential',
        maxDrawdown: 0.15,
        maxTotalRisk: 0.25,
        riskPerTrade: 0.02,
        positionSizing: {
          baseStakePercent: 0.10,
          maxStakePercent: 0.25,
          volatilityAdjustment: true
        },
        stopLoss: {
          enabled: true,
          baseStopLoss: -0.08,
          trailingStop: true,
          dynamicAdjustment: true
        },
        dca: {
          enabled: true,
          maxOrders: 3,
          triggerPercent: -0.08,
          sizeMultiplier: 1.5
        }
      },
      aggressive: {
        name: 'Aggressive',
        description: 'Higher risk for maximum growth potential',
        maxDrawdown: 0.25,
        maxTotalRisk: 0.35,
        riskPerTrade: 0.03,
        positionSizing: {
          baseStakePercent: 0.15,
          maxStakePercent: 0.35,
          volatilityAdjustment: true
        },
        stopLoss: {
          enabled: true,
          baseStopLoss: -0.12,
          trailingStop: true,
          dynamicAdjustment: true
        },
        dca: {
          enabled: true,
          maxOrders: 5,
          triggerPercent: -0.12,
          sizeMultiplier: 2.0
        }
      },
      dcaFocused: {
        name: 'DCA Focused',
        description: 'Dollar Cost Averaging strategy with systematic buying',
        maxDrawdown: 0.20,
        maxTotalRisk: 0.30,
        riskPerTrade: 0.02,
        positionSizing: {
          baseStakePercent: 0.12,
          maxStakePercent: 0.45,
          volatilityAdjustment: true
        },
        stopLoss: {
          enabled: true,
          baseStopLoss: -0.12,
          trailingStop: true,
          dynamicAdjustment: true
        },
        dca: {
          enabled: true,
          maxOrders: 5,
          triggerPercent: -0.05,
          sizeMultiplier: 1.5,
          levels: [-0.05, -0.10, -0.18, -0.28],
          multipliers: [1.2, 1.5, 2.0, 2.5]
        }
      },
      portfolioRebalancing: {
        name: 'Portfolio Rebalancing',
        description: 'Maintains target allocations across multiple assets',
        maxDrawdown: 0.18,
        maxTotalRisk: 0.25,
        riskPerTrade: 0.02,
        positionSizing: {
          baseStakePercent: 0.10,
          maxStakePercent: 0.30,
          volatilityAdjustment: true
        },
        stopLoss: {
          enabled: true,
          baseStopLoss: -0.10,
          trailingStop: false,
          dynamicAdjustment: true
        },
        rebalancing: {
          enabled: true,
          threshold: 0.15,
          frequency: 24,
          targetAllocations: {
            btc: 0.40,
            eth: 0.25,
            alt: 0.20,
            stable: 0.10,
            other: 0.05
          }
        }
      }
    };

    res.json({
      success: true,
      templates
    });

  } catch (error) {
    console.error('[RiskAPI] Error getting risk templates:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Apply a risk template to a bot
app.post('/api/bots/:instanceId/apply-risk-template', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { templateName, customizations } = req.body;
    const user = req.user || {};
    const userId = user.uid || user.id;

    if (!templateName) {
      return res.status(400).json({ success: false, message: 'Template name is required' });
    }

    // Get the template
    const templatesResponse = await fetch(`${req.protocol}://${req.get('host')}/api/risk-templates`, {
      headers: { 'Authorization': req.get('Authorization') }
    });
    const templatesData = await templatesResponse.json();

    if (!templatesData.success || !templatesData.templates[templateName]) {
      return res.status(400).json({ success: false, message: 'Invalid template name' });
    }

    let riskConfig = { ...templatesData.templates[templateName] };

    // Apply customizations if provided
    if (customizations) {
      riskConfig = { ...riskConfig, ...customizations };
    }

    // Apply the configuration
    const applyResponse = await fetch(`${req.protocol}://${req.get('host')}/api/bots/${instanceId}/risk-config`, {
      method: 'PUT',
      headers: {
        'Authorization': req.get('Authorization'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ riskConfig })
    });

    const applyResult = await applyResponse.json();

    if (applyResult.success) {
      res.json({
        success: true,
        message: `${riskConfig.name} template applied successfully`,
        instanceId,
        appliedTemplate: templateName,
        riskConfig
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to apply template',
        error: applyResult.message
      });
    }

  } catch (error) {
    console.error(`[RiskAPI] Error applying risk template for ${req.params.instanceId}:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get enhanced bot metrics including risk metrics
app.get('/api/bots/:instanceId/metrics', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const user = req.user || {};
    const userId = user.uid || user.id;

    // Get basic bot data
    const botData = await getBotAggregates(instanceId);

    // Get risk configuration
    const riskConfigResponse = await fetch(`${req.protocol}://${req.get('host')}/api/bots/${instanceId}/risk-config`, {
      headers: { 'Authorization': req.get('Authorization') }
    });
    const riskConfigData = await riskConfigResponse.json();

    // Calculate risk metrics
    const riskMetrics = await calculateRiskMetrics(instanceId, userId, riskConfigData.riskConfig);

    res.json({
      success: true,
      instanceId,
      botData,
      riskMetrics,
      riskConfig: riskConfigData.riskConfig
    });

  } catch (error) {
    console.error(`[RiskAPI] Error getting bot metrics for ${req.params.instanceId}:`, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Helper function to validate risk configuration
function validateRiskConfig(config) {
  const errors = [];

  // Validate maxDrawdown
  if (typeof config.maxDrawdown !== 'number' || config.maxDrawdown < 0.05 || config.maxDrawdown > 0.50) {
    errors.push('maxDrawdown must be between 0.05 and 0.50');
  }

  // Validate maxTotalRisk
  if (typeof config.maxTotalRisk !== 'number' || config.maxTotalRisk < 0.10 || config.maxTotalRisk > 0.50) {
    errors.push('maxTotalRisk must be between 0.10 and 0.50');
  }

  // Validate riskPerTrade
  if (typeof config.riskPerTrade !== 'number' || config.riskPerTrade < 0.005 || config.riskPerTrade > 0.10) {
    errors.push('riskPerTrade must be between 0.005 and 0.10');
  }

  // Validate position sizing
  if (config.positionSizing) {
    if (typeof config.positionSizing.baseStakePercent !== 'number' ||
      config.positionSizing.baseStakePercent < 0.02 ||
      config.positionSizing.baseStakePercent > 0.30) {
      errors.push('baseStakePercent must be between 0.02 and 0.30');
    }

    if (typeof config.positionSizing.maxStakePercent !== 'number' ||
      config.positionSizing.maxStakePercent < 0.05 ||
      config.positionSizing.maxStakePercent > 0.60) {
      errors.push('maxStakePercent must be between 0.05 and 0.60');
    }
  }

  // Validate DCA settings
  if (config.dca && config.dca.enabled) {
    if (typeof config.dca.maxOrders !== 'number' || config.dca.maxOrders < 1 || config.dca.maxOrders > 10) {
      errors.push('DCA maxOrders must be between 1 and 10');
    }

    if (typeof config.dca.triggerPercent !== 'number' || config.dca.triggerPercent > -0.01 || config.dca.triggerPercent < -0.50) {
      errors.push('DCA triggerPercent must be between -0.50 and -0.01');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Helper function to calculate risk metrics
async function calculateRiskMetrics(instanceId, userId, riskConfig) {
  try {
    const metrics = {
      currentDrawdown: 0,
      totalRiskExposure: 0,
      positionCount: 0,
      averagePositionSize: 0,
      riskUtilization: 0,
      stopLossCount: 0,
      dcaOrdersActive: 0,
      rebalanceSignals: 0
    };

    // Get current open trades
    const tradesData = await proxyFreqtradeApiRequest(instanceId, '/api/v1/status');

    if (tradesData && Array.isArray(tradesData)) {
      const openTrades = tradesData.filter(trade => trade.is_open);
      metrics.positionCount = openTrades.length;

      if (openTrades.length > 0) {
        // Calculate total position value and risk
        let totalPositionValue = 0;
        let totalUnrealizedLoss = 0;
        let stopLossCount = 0;
        let dcaOrders = 0;

        openTrades.forEach(trade => {
          totalPositionValue += trade.stake_amount || 0;

          if (trade.profit_abs < 0) {
            totalUnrealizedLoss += Math.abs(trade.profit_abs);
          }

          if (trade.stop_loss_abs) {
            stopLossCount++;
          }

          // Count DCA orders (simplified check)
          if (trade.orders && trade.orders.length > 1) {
            dcaOrders += trade.orders.length - 1;
          }
        });

        metrics.averagePositionSize = totalPositionValue / openTrades.length;
        metrics.stopLossCount = stopLossCount;
        metrics.dcaOrdersActive = dcaOrders;

        // Calculate risk utilization
        const totalStake = await getTotalStakeAmount(userId);
        if (totalStake > 0) {
          metrics.totalRiskExposure = totalPositionValue / totalStake;
          metrics.currentDrawdown = totalUnrealizedLoss / totalStake;
          metrics.riskUtilization = metrics.totalRiskExposure / (riskConfig.maxTotalRisk || 0.25);
        }
      }
    }

    // Add timestamp
    metrics.lastCalculated = new Date().toISOString();

    return metrics;

  } catch (error) {
    console.error(`Error calculating risk metrics for ${instanceId}:`, error.message);
    return {
      error: error.message,
      lastCalculated: new Date().toISOString()
    };
  }
}

// Helper function to get total stake amount for a user
async function getTotalStakeAmount(userId) {
  try {
    // This would ideally get the total stake from the bot's wallet
    // For now, return a default value
    return 10000; // Default $10,000 portfolio
  } catch (error) {
    console.error(`Error getting total stake for ${userId}:`, error.message);
    return 0;
  }
}

// =============================================================================
// UNIVERSAL RISK MANAGEMENT API ENDPOINTS
// Frontend Integration for Risk Level, Auto-Rebalance, and DCA toggles
// =============================================================================

// Helper function to resolve bot instance path
async function resolveBotInstancePath(instanceId) {
  // Try direct path first (for backwards compatibility)
  let instanceDir = path.join(BOT_BASE_DIR, instanceId);
  if (await fs.pathExists(instanceDir)) {
    return instanceDir;
  }

  // Search in user directories for the bot
  const userDirs = await fs.readdir(BOT_BASE_DIR);
  for (const userId of userDirs) {
    const userDir = path.join(BOT_BASE_DIR, userId);
    const stat = await fs.stat(userDir).catch(() => null);
    if (stat && stat.isDirectory()) {
      const botDir = path.join(userDir, instanceId);
      if (await fs.pathExists(botDir)) {
        return botDir;
      }
    }
  }

  return null;
}

// Get current universal settings for a bot
app.get('/api/universal-settings/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;

    const instanceDir = req.instanceDir; // Use pool-aware path from middleware

    if (!instanceDir) {
      return res.status(404).json({ success: false, error: 'Bot instance not found' });
    }

    // Use UniversalRiskManager to read from bot's config.json
    const riskManager = new UniversalRiskManager(instanceId, userId, req.instanceDir);
    await riskManager.loadSettings();

    // Check if universalSettings exists in config.json
    const hasUniversalSettings = riskManager.botConfig?.universalSettings !== undefined;

    // Include default values for frontend initialization
    const response = {
      success: true,
      settings: riskManager.settings,
      defaults: riskManager.defaultSettings,
      botConfig: riskManager.getBotConfig(),  // Include full bot config
      schema: {
        riskLevel: {
          type: 'number',
          min: 0,
          max: 100,
          default: riskManager.defaultSettings.riskLevel,
          description: 'Risk level from conservative (0) to aggressive (100)'
        },
        autoRebalance: {
          type: 'boolean',
          default: riskManager.defaultSettings.autoRebalance,
          description: 'Enable automatic portfolio rebalancing'
        },
        dcaEnabled: {
          type: 'boolean',
          default: riskManager.defaultSettings.dcaEnabled,
          description: 'Enable Dollar Cost Averaging orders'
        },
        enabled: {
          type: 'boolean',
          default: riskManager.defaultSettings.enabled,
          description: 'Master toggle for all universal risk management features'
        }
      },
      isNewBot: !hasUniversalSettings,
      message: 'Universal settings retrieved successfully'
    };

    res.json(response);

  } catch (error) {
    console.error(`[API] Error getting universal settings for ${req.params.instanceId}:`, error.message);
    console.error(`[API] Error stack:`, error.stack);
    res.status(500).json({ success: false, error: 'Failed to get universal settings' });
  }
});

// Get default universal settings schema (for frontend initialization)
app.get('/api/universal-settings-defaults', authenticateToken, async (req, res) => {
  try {
    // Create a temporary risk manager to get default values
    // Use a placeholder instanceId and userId since we just need defaults
    const tempRiskManager = new UniversalRiskManager('defaults', req.user.id);

    const defaultsSchema = {
      success: true,
      defaults: tempRiskManager.defaultSettings,
      schema: {
        riskLevel: {
          type: 'number',
          min: 0,
          max: 100,
          default: tempRiskManager.defaultSettings.riskLevel,
          step: 1,
          description: 'Risk level from conservative (0) to aggressive (100)',
          examples: {
            0: 'Ultra Conservative - 5% max drawdown, 1% risk per trade',
            25: 'Conservative - 10% max drawdown, 1.5% risk per trade',
            50: 'Balanced - 15% max drawdown, 2% risk per trade',
            75: 'Aggressive - 20% max drawdown, 2.5% risk per trade',
            100: 'Ultra Aggressive - 25% max drawdown, 3% risk per trade'
          }
        },
        autoRebalance: {
          type: 'boolean',
          default: tempRiskManager.defaultSettings.autoRebalance,
          description: 'Automatically rebalance portfolio to maintain target allocations',
          details: 'Monitors portfolio drift and rebalances when allocation deviates beyond threshold'
        },
        dcaEnabled: {
          type: 'boolean',
          default: tempRiskManager.defaultSettings.dcaEnabled,
          description: 'Enable Dollar Cost Averaging on losing positions',
          details: 'Places additional orders when price drops to average down position cost'
        },
        enabled: {
          type: 'boolean',
          default: tempRiskManager.defaultSettings.enabled,
          description: 'Master toggle for all universal risk management features',
          details: 'When disabled, bot uses only the original strategy without enhancements'
        }
      },
      riskLevelMapping: {
        0: { label: 'Ultra Conservative', maxDrawdown: '5%', riskPerTrade: '1%', dcaOrders: 2 },
        25: { label: 'Conservative', maxDrawdown: '10%', riskPerTrade: '1.5%', dcaOrders: 2 },
        50: { label: 'Balanced', maxDrawdown: '15%', riskPerTrade: '2%', dcaOrders: 3 },
        75: { label: 'Aggressive', maxDrawdown: '20%', riskPerTrade: '2.5%', dcaOrders: 4 },
        100: { label: 'Ultra Aggressive', maxDrawdown: '25%', riskPerTrade: '3%', dcaOrders: 5 }
      },
      message: 'Default universal settings schema retrieved successfully'
    };

    res.json(defaultsSchema);

  } catch (error) {
    console.error('Error getting default settings schema:', error);
    res.status(500).json({ success: false, error: 'Failed to get default settings schema' });
  }
});

// Update universal settings for a bot (Frontend "Save Changes" endpoint)
app.put('/api/universal-settings/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    const { riskLevel, autoRebalance, dcaEnabled, enabled = true } = req.body;

    const instanceDir = req.instanceDir; // Use pool-aware path from middleware

    if (!instanceDir) {
      return res.status(404).json({ success: false, error: 'Bot instance not found' });
    }

    // Validate input
    if (riskLevel !== undefined && (riskLevel < 0 || riskLevel > 100)) {
      return res.status(400).json({ success: false, error: 'Risk level must be between 0 and 100' });
    }

    // Use UniversalRiskManager to update settings in bot-settings.json
    const riskManager = new UniversalRiskManager(instanceId, userId, req.instanceDir);
    await riskManager.loadSettings();

    // Update settings
    const newSettings = {};
    if (riskLevel !== undefined) newSettings.riskLevel = riskLevel;
    if (autoRebalance !== undefined) newSettings.autoRebalance = autoRebalance;
    if (dcaEnabled !== undefined) newSettings.dcaEnabled = dcaEnabled;
    if (enabled !== undefined) newSettings.enabled = enabled;

    await riskManager.updateSettings(newSettings);

    // Clear API interceptor cache to ensure fresh settings on next request
    apiInterceptor.clearCache(instanceId, req.user.id);

    res.json({
      success: true,
      settings: riskManager.settings,
      message: 'Universal settings updated successfully'
    });

  } catch (error) {
    console.error('Error updating universal settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update universal settings' });
  }
});

// Get risk metrics with universal risk management data
app.get('/api/risk-metrics/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id; // Get authenticated user's ID (set by auth middleware)
    const instanceDir = req.instanceDir; // Use pool-aware path from middleware

    if (!instanceDir) {
      return res.status(404).json({ success: false, error: 'Bot instance not found' });
    }

    // Get standard risk metrics
    const metrics = await calculateRiskMetrics(instanceId);

    // Add universal risk management status
    // Use userId instead of instanceDir so it reads from user-specific settings file
    const riskManager = new UniversalRiskManager(instanceId, userId, req.instanceDir);
    await riskManager.loadSettings();

    metrics.universalRiskManagement = {
      enabled: riskManager.settings.enabled,
      riskLevel: riskManager.settings.riskLevel,
      autoRebalance: riskManager.settings.autoRebalance,
      dcaEnabled: riskManager.settings.dcaEnabled,
      lastUpdated: new Date().toISOString()
    };

    res.json({
      success: true,
      metrics: metrics,
      message: 'Risk metrics with universal settings retrieved successfully'
    });

  } catch (error) {
    console.error('Error getting risk metrics:', error);
    res.status(500).json({ success: false, error: 'Failed to get risk metrics' });
  }
});

// Reset universal settings to defaults
app.post('/api/universal-settings/:instanceId/reset', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id; // Get authenticated user's ID (set by auth middleware)
    const instanceDir = req.instanceDir; // Use pool-aware path from middleware

    if (!instanceDir) {
      return res.status(404).json({ success: false, error: 'Bot instance not found' });
    }

    // Use userId instead of instanceDir so it writes to user-specific settings file
    const riskManager = new UniversalRiskManager(instanceId, userId, req.instanceDir);
    await riskManager.updateSettings(riskManager.defaultSettings);

    // Clear API interceptor cache to ensure fresh settings on next request
    apiInterceptor.clearCache(instanceId, req.user.id);

    console.log(`[API] ✓ Universal settings reset to defaults for ${instanceId}`);

    res.json({
      success: true,
      settings: riskManager.settings,
      message: 'Universal settings reset to defaults successfully'
    });

  } catch (error) {
    console.error('Error resetting universal settings:', error);
    res.status(500).json({ success: false, error: 'Failed to reset universal settings' });
  }
});

// Get all bots with their universal settings (for dashboard overview)
app.get('/api/universal-settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id; // Get authenticated user's ID (set by auth middleware)
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }

    const userDir = path.join(BOT_BASE_DIR, userId);
    if (!await fs.pathExists(userDir)) {
      // Create a temp risk manager just to get default settings structure
      const defaultRiskManager = new UniversalRiskManager('defaults', userId);
      return res.json({
        success: true,
        bots: [],
        defaults: defaultRiskManager.defaultSettings,
        totalBots: 0,
        runningBots: 0,
        message: 'No bots found for user'
      });
    }

    const userEntries = await fs.readdir(userDir);
    const botsWithSettings = [];

    for (const entry of userEntries) {
      const entryPath = path.join(userDir, entry);
      const entryStat = await fs.stat(entryPath).catch(() => null);
      if (!entryStat || !entryStat.isDirectory()) {
        continue;
      }

      const poolBotsDir = path.join(entryPath, 'bots');
      const hasPoolBots = await fs.pathExists(poolBotsDir);

      if (hasPoolBots) {
        const poolBots = await fs.readdir(poolBotsDir);
        for (const botId of poolBots) {
          const botDir = path.join(poolBotsDir, botId);
          const botStat = await fs.stat(botDir).catch(() => null);
          if (!botStat || !botStat.isDirectory()) {
            continue;
          }

          const riskManager = new UniversalRiskManager(botId, userId, botDir);
          await riskManager.loadSettings();
          const hasUniversalSettings = riskManager.botConfig?.universalSettings !== undefined;

          botsWithSettings.push({
            instanceId: botId,
            poolId: entry,
            settings: riskManager.settings,
            botConfig: riskManager.getBotConfig(),
            defaults: riskManager.defaultSettings,
            isRunning: await isBotRunning(botId),
            isNewBot: !hasUniversalSettings,
            lastUpdated: riskManager.settings?.updatedAt || null
          });
        }
      } else {
        const botId = entry;
        const riskManager = new UniversalRiskManager(botId, userId, entryPath);
        await riskManager.loadSettings();
        const hasUniversalSettings = riskManager.botConfig?.universalSettings !== undefined;

        botsWithSettings.push({
          instanceId: botId,
          poolId: null,
          settings: riskManager.settings,
          botConfig: riskManager.getBotConfig(),
          defaults: riskManager.defaultSettings,
          isRunning: await isBotRunning(botId),
          isNewBot: !hasUniversalSettings,
          lastUpdated: riskManager.settings?.updatedAt || null
        });
      }
    }

    // Get default settings for frontend reference
    const defaultRiskManager = new UniversalRiskManager('defaults', userId);

    res.json({
      success: true,
      bots: botsWithSettings,
      defaults: defaultRiskManager.defaultSettings,
      totalBots: botsWithSettings.length,
      runningBots: botsWithSettings.filter(bot => bot.isRunning).length,
      message: 'Universal settings for all bots retrieved successfully'
    });

  } catch (error) {
    console.error('Error getting all universal settings:', error);
    res.status(500).json({ success: false, error: 'Failed to get universal settings' });
  }
});

// =============================================================================
// UNIVERSAL FEATURES API (v2.0) - Advanced Trading Features
// =============================================================================

// Get universal features for a specific bot
app.get('/api/universal-features/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    
    const features = new UniversalFeatures(instanceId, userId, req.instanceDir);
    await features.loadFeatures();
    
    res.json({
      success: true,
      data: features.getFeatures(),
      summary: features.getFeatureSummary(),
      instanceId
    });
  } catch (error) {
    console.error('Error getting universal features:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update universal features for a specific bot
app.put('/api/universal-features/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    const newFeatures = req.body;
    
    const features = new UniversalFeatures(instanceId, userId, req.instanceDir);
    const updatedFeatures = await features.updateFeatures(newFeatures);
    
    // Clear API interceptor cache for immediate effect
    apiInterceptor.clearCache(instanceId, userId);
    
    res.json({
      success: true,
      data: updatedFeatures,
      summary: features.getFeatureSummary(),
      message: 'Universal features updated successfully'
    });
  } catch (error) {
    console.error('Error updating universal features:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get default universal features configuration
app.get('/api/universal-features-defaults', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      data: DEFAULT_FEATURES,
      version: DEFAULT_FEATURES._meta?.version || '2.0.0'
    });
  } catch (error) {
    console.error('Error getting default features:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reset universal features to defaults
app.post('/api/universal-features/:instanceId/reset', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    
    const features = new UniversalFeatures(instanceId, userId, req.instanceDir);
    const defaults = JSON.parse(JSON.stringify(DEFAULT_FEATURES));
    defaults._meta.createdAt = new Date().toISOString();
    defaults._meta.updatedAt = new Date().toISOString();
    
    await features.updateFeatures(defaults);
    
    // Clear cache
    apiInterceptor.clearCache(instanceId, userId);
    
    res.json({
      success: true,
      data: features.getFeatures(),
      message: 'Universal features reset to defaults'
    });
  } catch (error) {
    console.error('Error resetting universal features:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all bots' universal features
app.get('/api/universal-features', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const userDir = path.join(BOT_BASE_DIR, userId);
    if (!await fs.pathExists(userDir)) {
      return res.json({
        success: true,
        bots: [],
        defaults: DEFAULT_FEATURES,
        totalBots: 0
      });
    }
    
    const instances = await fs.readdir(userDir);
    const botsWithFeatures = [];
    
    for (const instanceId of instances) {
      const instanceDir = path.join(userDir, instanceId);
      const stat = await fs.stat(instanceDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;
      
      const features = new UniversalFeatures(instanceId, userId);
      await features.loadFeatures();
      
      botsWithFeatures.push({
        instanceId,
        features: features.getFeatures(),
        summary: features.getFeatureSummary(),
        isRunning: await isBotRunning(instanceId)
      });
    }
    
    res.json({
      success: true,
      bots: botsWithFeatures,
      defaults: DEFAULT_FEATURES,
      totalBots: botsWithFeatures.length
    });
  } catch (error) {
    console.error('Error getting all universal features:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// ACTIVE TRADE MONITOR API
// =============================================================================

// Get monitor status
app.get('/api/trade-monitor/status', authenticateToken, async (req, res) => {
  try {
    const monitor = getMonitor();
    res.json({
      success: true,
      data: monitor.getStatus()
    });
  } catch (error) {
    console.error('Error getting monitor status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start the trade monitor
app.post('/api/trade-monitor/start', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const monitor = getMonitor();
    await monitor.start();
    res.json({
      success: true,
      message: 'Active Trade Monitor started',
      data: monitor.getStatus()
    });
  } catch (error) {
    console.error('Error starting monitor:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop the trade monitor
app.post('/api/trade-monitor/stop', authenticateToken, authorize('admin'), async (req, res) => {
  try {
    const monitor = getMonitor();
    monitor.stop();
    res.json({
      success: true,
      message: 'Active Trade Monitor stopped'
    });
  } catch (error) {
    console.error('Error stopping monitor:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Refresh bot list in monitor
app.post('/api/trade-monitor/refresh', authenticateToken, async (req, res) => {
  try {
    const monitor = getMonitor();
    const result = await monitor.refresh();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error refreshing monitor:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get action log for a specific bot
app.get('/api/trade-monitor/actions/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    
    const monitor = getMonitor();
    const actions = await monitor.getActionsLog(userId, instanceId);
    
    res.json({
      success: true,
      data: actions,
      instanceId
    });
  } catch (error) {
    console.error('Error getting action log:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manually check a specific bot
app.post('/api/trade-monitor/check/:instanceId', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    
    const monitor = getMonitor();
    const result = await monitor.checkBot(userId, instanceId);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error checking bot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Resume trading from emergency/daily loss pause
app.post('/api/universal-features/:instanceId/resume', authenticateToken, checkInstanceOwnership, async (req, res) => {
  try {
    const { instanceId } = req.params;
    const userId = req.user.id;
    
    const features = new UniversalFeatures(instanceId, userId);
    await features.loadFeatures();
    const result = await features.resumeFromEmergency();
    
    res.json({
      success: true,
      data: result,
      message: 'Trading resumed'
    });
  } catch (error) {
    console.error('Error resuming trading:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================================================
// UNIVERSAL RISK MANAGEMENT BACKGROUND SERVICES
// =============================================================================

// Background service to apply universal risk management to running bots
async function runUniversalRiskManagement() {
  try {
    // Get all user directories
    const userDirs = await fs.readdir(BOT_BASE_DIR);

    for (const userId of userDirs) {
      const userDir = path.join(BOT_BASE_DIR, userId);
      const stat = await fs.stat(userDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      // Get all bot instances for this user
      const instances = await fs.readdir(userDir);

      for (const instanceId of instances) {
        const instanceDir = path.join(userDir, instanceId);
        const stat2 = await fs.stat(instanceDir).catch(() => null);
        if (!stat2 || !stat2.isDirectory()) continue;

        const riskManager = new UniversalRiskManager(instanceId, userId);
        await riskManager.loadSettings();

        if (!riskManager.settings.enabled) continue;

        // Check if bot is running
        const isRunning = await isBotRunning(instanceId);
        if (!isRunning) continue;

        try {
          // Get bot's current trades and status
          const botConfig = await getBotUrlByInstanceId(instanceId);
          if (!botConfig) continue;

          const tradesResponse = await fetch(`${botConfig.url}/api/v1/trades`, { timeout: 5000 });
          const openTrades = await tradesResponse.json();

          const statusResponse = await fetch(`${botConfig.url}/api/v1/status`, { timeout: 5000 });
          const status = await statusResponse.json();

          // Apply DCA management
          if (openTrades && Array.isArray(openTrades)) {
            for (const trade of openTrades.filter(t => t.is_open)) {
              // Get current price for the pair
              const tickerResponse = await fetch(`${botConfig.url}/api/v1/pair_ticker/${trade.pair}`, { timeout: 5000 });
              const ticker = await tickerResponse.json();

              if (ticker && ticker.last) {
                await riskManager.checkAndPlaceDCAOrders(trade.pair, ticker.last, [trade]);
              }
            }
          }

          // Apply auto-rebalancing
          if (status && status.total_stake) {
            const currentPositions = {};
            if (openTrades && Array.isArray(openTrades)) {
              for (const trade of openTrades.filter(t => t.is_open)) {
                currentPositions[trade.pair] = {
                  value: trade.stake_amount,
                  amount: trade.amount
                };
              }
            }

            await riskManager.checkAndRebalance(currentPositions, status.total_stake);
          }

        } catch (botError) {
          console.warn(`[${instanceId}] Universal risk management failed:`, botError.message);
        }
      }
    }

  } catch (error) {
    console.error('Universal risk management background service error:', error);
  }
}

// Helper function to check if bot is running
async function isBotRunning(instanceId) {
  try {
    const botConfig = await getBotUrlByInstanceId(instanceId);
    if (!botConfig) return false;

    const response = await fetch(`${botConfig.url}/api/v1/ping`, { timeout: 3000 });
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Start background services
console.log('🚀 Starting universal risk management background services...');

// Run universal risk management every 5 minutes
setInterval(runUniversalRiskManagement, 5 * 60 * 1000);

// Initial run after 30 seconds
setTimeout(runUniversalRiskManagement, 30 * 1000);
