// server/index.js
const dotenv = require("dotenv");
const express = require("express");
const path = require("path");
const { PostHog } = require("posthog-node");

// Load environment variables
dotenv.config();
const cors = require("cors");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

// Initialize Firebase Admin SDK
const admin = require("firebase-admin");
const fs = require("fs");

// Try to load from serviceAccountKey.json first (production), then fall back to env vars
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
let firebaseInitialized = false;

if (fs.existsSync(serviceAccountPath) && !admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized from serviceAccountKey.json");
    firebaseInitialized = true;
  } catch (error) {
    console.error("Failed to initialize Firebase from serviceAccountKey.json:", error.message);
  }
}

// Fall back to environment variables if JSON file failed
if (!firebaseInitialized && !admin.apps.length) {
  const getFirebasePrivateKey = () => {
    // First try to load from file (preferred for systemd)
    if (process.env.FIREBASE_PRIVATE_KEY_FILE) {
      try {
        return fs.readFileSync(process.env.FIREBASE_PRIVATE_KEY_FILE, "utf8");
      } catch (err) {
        console.error("Failed to read Firebase private key file:", err.message);
      }
    }
    // Fall back to env var (for Vercel/other platforms)
    if (process.env.FIREBASE_PRIVATE_KEY) {
      return process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
    }
    return null;
  };

  const firebasePrivateKey = getFirebasePrivateKey();

  // Use environment variables instead of requiring the JSON file
  const firebaseConfig = {
    type: process.env.FIREBASE_TYPE || "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: firebasePrivateKey,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri:
      process.env.FIREBASE_AUTH_URI ||
      "https://accounts.google.com/o/oauth2/auth",
    token_uri:
      process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url:
      process.env.FIREBASE_AUTH_PROVIDER_CERT_URL ||
      "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  };

  // Only initialize if we have the required credentials
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    firebasePrivateKey
  ) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig),
    });
    console.log("Firebase Admin SDK initialized from environment variables");
    firebaseInitialized = true;
  }
}

if (!firebaseInitialized) {
  console.warn(
    "Firebase credentials missing, authentication features may not work properly"
  );
}

// Try to validate env, but don't crash if it fails in production
try {
  const validateEnv = require("./utils/validateEnv");
  validateEnv();
} catch (err) {
  console.warn("Environment validation warning:", err.message);
}

// Access environment variables
const {
  NODE_ENV = "production",
  PORT = 5001,
  JWT_SECRET,
  ENCRYPTION_KEY,
  MONGO_URI,
  POSTHOG_API_KEY,
  POSTHOG_HOST = "https://app.posthog.com",
} = process.env;
console.log("NODE_ENV", NODE_ENV);

// Create express app
const app = express();

// PostHog telemetry (opt-in via POSTHOG_API_KEY)
let posthogClient = null;
if (POSTHOG_API_KEY) {
  posthogClient = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 1000,
  });
  console.log("PostHog telemetry enabled");
}

// Set up CORS
const defaultProdOrigins = [
  "https://www.crypto-pilot.dev",
  "https://crypto-pilot.dev",
  "https://app.crypto-pilot.dev",
];

const defaultDevOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://192.168.1.225:5174", // Network IP access
  "http://192.168.1.225:5173",
];

const parseOrigins = (value) =>
  (value || "")
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean);

const allowedOrigins = (() => {
  const fromEnv = parseOrigins(process.env.ALLOWED_ORIGINS);
  if (fromEnv.length) return fromEnv;
  return NODE_ENV === "production" ? defaultProdOrigins : defaultDevOrigins;
})();

console.log("[CORS] Allowed origins:", allowedOrigins);
console.log("[CORS] NODE_ENV:", NODE_ENV);

// IMPORTANT: Apply CORS middleware BEFORE any routes
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      console.log("Request origin:", origin);

      if (allowedOrigins.includes(origin) || NODE_ENV === "development") {
        callback(null, true);
      } else {
        console.log("Origin not allowed by CORS:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
    ],
  })
);

// Handle preflight OPTIONS requests explicitly
app.options("*", cors());

// Request logger - log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  
  // Ensure CORS headers are always present in response
  if (req.headers.origin && allowedOrigins.includes(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (NODE_ENV === 'development' && req.headers.origin) {
    // In development, allow all origins
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  next();
});

// Rest of your middleware
app.use(express.json());
app.use(cookieParser());
app.use(helmet());

// Simplified security policies for serverless
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      objectSrc: ["'none'"],
    },
  })
);

// Near the top with other imports
const {
  limiter,
  authLimiter,
  tradesLimiter,
  freqtradeLimiter,
} = require("./middleware/rateLimiter");

// Rate Limiting - only apply strict limits in production
if (NODE_ENV === "production") {
  app.use(limiter);
} else {
  // In development, use a more lenient rate limiter or none at all
  console.log("Using development rate limits");
  const devLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000, // Much higher limit for development
    message:
      "Too many requests from this IP, please try again after 15 minutes",
  });
  app.use(devLimiter);
}

// MongoDB connection with connection pooling optimized for serverless
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  try {
    const client = await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10, // Keeping a smaller connection pool for serverless
    });

    cachedDb = client;
    console.log("MongoDB connected");
    return client;
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
}

// Import Routes
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const tradesRoutes = require("./routes/trades");
const portfolioRoutes = require("./routes/portfolio");
const botConfigRoutes = require("./routes/botConfig");
const usersRoutes = require("./routes/users");
const positionRoutes = require("./routes/positions");
const botRoutes = require("./routes/bot");
const freqtradeProxyRoutes = require("./routes/freqtrade-proxy");
const accountRoutes = require("./routes/account");
const strategiesRoutes = require("./routes/strategies");

// Handle database connection before routing
app.use(async (req, res, next) => {
  const started = Date.now();
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({ message: "Database connection error" });
  }

  res.on("finish", () => {
    if (!posthogClient) return;
    posthogClient.capture({
      distinctId: req.user?.id || "anonymous",
      event: "api_request",
      properties: {
        path: req.path,
        method: req.method,
        status: res.statusCode,
        duration_ms: Date.now() - started,
        origin: req.headers.origin,
      },
    });
  });
});

// Use Routes
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/trades", tradesRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/bot-config", botConfigRoutes);
app.use("/api/users", usersRoutes); // This should be the only registration for users routes
app.use("/api/positions", positionRoutes);
app.use("/api/bot", botRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/freqtrade", freqtradeLimiter, freqtradeProxyRoutes); // Use dedicated rate limiter for freqtrade proxy
app.use("/api/strategies", strategiesRoutes); // Strategy management endpoints

// Add a diagnostic route to check if server is running properly
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    message: "Server is running properly",
    environment: process.env.NODE_ENV,
    routes: {
      auth: "/api/auth/*",
      portfolio: "/api/portfolio/*",
      trades: "/api/trades/*",
      positions: "/api/positions/*",
      users: "/api/users/*",
      bot: "/api/bot/*",
    },
  });
});

// Add Google Auth verification endpoint with /api prefix
app.post("/api/auth/google-verify", async (req, res) => {
  try {
    console.log("Google auth verification endpoint hit");
    const { idToken } = req.body;

    if (!idToken) {
      return res
        .status(400)
        .json({ success: false, message: "No ID token provided" });
    }

    // Log the request for debugging
    console.log(
      "Processing Google auth with token:",
      idToken.substring(0, 10) + "..."
    );

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    // Check if user exists in our database
    let user = await mongoose.model("User").findOne({ email });

    if (!user) {
      // Create a new user if they don't exist
      user = new mongoose.model("User")({
        username: name || email.split("@")[0],
        email,
        firebaseUid: uid,
        avatar: picture,
        displayName: name || email.split("@")[0],
        emailVerified: true, // Google/social logins come with verified emails
        authProvider: 'google',
      });

      await user.save();
    } else {
      // Update existing user with Firebase UID if needed
      if (!user.firebaseUid) {
        user.firebaseUid = uid;
        if (picture && !user.avatar) user.avatar = picture;
        if (!user.displayName) user.displayName = name || email.split("@")[0];
        if (!user.emailVerified) user.emailVerified = true;
        if (!user.authProvider) user.authProvider = 'google';
        await user.save();
      }
    }

    // Create JWT access token
    const accessPayload = { user: { id: user.id } };
    const accessToken = jwt.sign(accessPayload, JWT_SECRET, {
      expiresIn: "15m",
    });

    // Generate refresh token
    const rawRefresh = crypto.randomBytes(32).toString("hex");

    // Calculate refresh token expiry
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7); // 7 days

    // Store refresh token in DB (simplified for direct implementation)
    await mongoose.model("RefreshToken").create({
      userId: user._id,
      token: rawRefresh,
      expiresAt: expiry,
    });

    // Set cookies
    res.cookie("token", accessToken, {
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: "none",
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    res.cookie("refreshToken", rawRefresh, {
      httpOnly: true,
      secure: NODE_ENV === "production",
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Return success response with user data
    res.json({
      success: true,
      message: "Google authentication successful",
      data: {
        id: user._id,
        name: user.username,
        email: user.email,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({
      success: false,
      message: "Authentication failed: " + (error.message || "Unknown error"),
    });
  }
});

// Static file serving only in development (frontend is on Vercel in production)
if (process.env.NODE_ENV !== 'production') {
  const clientPath = path.join(__dirname, "..", "web", "dist");
  app.use(express.static(clientPath));
}

// Basic Route (optional)
app.get("/", (req, res) => {
  res.send("Welcome to the Crypto Trading Bot API");
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// API 404 Handler - prevent serving HTML for missing API routes
app.all("/api/*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.url}`
  });
});

// Fallback route for client-side routing (only in development)
if (process.env.NODE_ENV !== 'production') {
  const clientPathForFallback = path.join(__dirname, "..", "web", "dist");
  app.get("*", (req, res) => {
    res.sendFile(path.join(clientPathForFallback, "index.html"));
  });
}

// Error Handling Middleware
const errorHandler = require("./middleware/errorHandler");
app.use(errorHandler);

// Initialize StrategyManager for real-time strategy monitoring
const StrategyManager = require("../../services/strategy-manager");
const { poolProvisioner, initPoolSystem, getPoolComponents } = require("../bot-orchestrator/lib/pool-integration");

async function initializeStrategyManager() {
  try {
    // Initialize pool system first to get access to pool-integration methods
    try {
      await initPoolSystem({ enableHealthMonitor: false });
      console.log('[API Gateway] Pool system initialized for StrategyManager');
    } catch (poolErr) {
      console.warn('[API Gateway] Pool system init failed (may already be initialized):', poolErr.message);
    }

    // Create StrategyManager with pool-integration as orchestrator
    const strategyManager = new StrategyManager(poolProvisioner);
    await strategyManager.start();
    app.locals.strategyManager = strategyManager;
    console.log('[API Gateway] StrategyManager initialized with pool-integration');
  } catch (err) {
    console.error('[API Gateway] Failed to initialize StrategyManager:', err);
  }
}

// Only start listening on the port if we're not in Vercel environment
if (process.env.VERCEL !== "1") {
  const http = require('http');
  const { setupWebSocketServer } = require('./middleware/websocketHandler');

  initializeStrategyManager().then(() => {
    // Create HTTP server
    const server = http.createServer(app);

    // Setup WebSocket server
    setupWebSocketServer(server, app.locals.strategyManager);

    // Listen on server
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`WebSocket server available at ws://localhost:${PORT}/ws/strategies`);
    });
  }).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// Export the app for serverless use
module.exports = app;

// Add this near the top with other imports
const { updatePortfolioSnapshots } = require("./utils/portfolioUpdater");

// Add this after MongoDB connection setup
// Schedule portfolio updates (once per day)
if (NODE_ENV === "production") {
  // In production, run once a day at midnight
  const runDailyAt = (hour, minute, task) => {
    const now = new Date();
    let scheduledTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0
    );

    if (scheduledTime <= now) {
      scheduledTime = new Date(scheduledTime.getTime() + 24 * 60 * 60 * 1000);
    }

    const timeUntilTask = scheduledTime.getTime() - now.getTime();

    setTimeout(() => {
      task();
      // Schedule for next day
      setInterval(task, 24 * 60 * 60 * 1000);
    }, timeUntilTask);
  };

  runDailyAt(0, 0, updatePortfolioSnapshots);
} else {
  // In development, run once at startup for testing
  setTimeout(updatePortfolioSnapshots, 5000);
}

// Add this after all your routes are registered
console.log("Registered routes:");
app._router.stack.forEach(function (r) {
  if (r.route && r.route.path) {
    console.log(r.route.path);
  }
});

// Add this line to print registered user routes for debugging
console.log("User routes registered:", Object.keys(usersRoutes.stack));

// Note: CORS is already configured at the top of this file (line ~154)
// No need to apply it again here

// For specific routes that need their own CORS config
app.options("/api/auth/exchange-google-token", cors());
app.post(
  "/api/auth/exchange-google-token",
  cors(),
  async (req, res) => {
    // Your existing route handler code
  }
);
