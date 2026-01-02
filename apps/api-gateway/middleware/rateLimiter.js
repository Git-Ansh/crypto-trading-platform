// server/middleware/rateLimiter.js
const rateLimit = require("express-rate-limit");

// Track which endpoints are being hit most frequently
const endpointTracker = {};

// General API rate limiter with tracking
// Skips /api/freqtrade routes which have their own dedicated limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "development" ? 1000 : 300, // 300 requests per 15 minutes in production
  message: {
    status: 429,
    message:
      "Too many requests from this IP, please try again after 15 minutes",
    retryAfter: 900, // seconds
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip freqtrade routes - they have their own dedicated rate limiter
    return req.path.startsWith('/api/freqtrade') || req.originalUrl.startsWith('/api/freqtrade');
  },
  keyGenerator: (req) => {
    // Track which endpoints are being hit
    const endpoint = req.originalUrl || req.url;
    if (!endpointTracker[endpoint]) {
      endpointTracker[endpoint] = 0;
    }
    endpointTracker[endpoint]++;

    // Log if an endpoint is being hit too frequently
    if (endpointTracker[endpoint] % 20 === 0) {
      console.log(
        `High traffic endpoint: ${endpoint} (${endpointTracker[endpoint]} hits)`
      );
    }

    // Use both IP and user ID (if available) for more granular rate limiting
    return req.user ? `${req.ip}-${req.user.id}` : req.ip;
  },
});

// Stricter rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "development" ? 100 : 10, // Higher limit in development
  message: {
    message:
      "Too many authentication attempts from this IP, please try again after 15 minutes",
  },
  headers: true,
});

// Create a separate, more lenient limiter for the trades endpoint
const tradesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "development" ? 2000 : 200, // Double the limit for trades endpoint
  message: {
    status: 429,
    message: "Too many trade requests, please try again after 15 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// More lenient limiter for FreqTrade proxy endpoints
// The dashboard makes multiple API calls on load for charts, bots, positions, etc.
const freqtradeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window (shorter window, more requests)
  max: process.env.NODE_ENV === "development" ? 500 : 60, // 60 requests per minute in production
  message: {
    status: 429,
    message: "Too many FreqTrade API requests, please wait a moment",
    retryAfter: 60,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit per user, not just IP (users share IPs behind NAT)
    return req.user ? `freqtrade-${req.user.id || req.user._id}` : `freqtrade-${req.ip}`;
  },
});

module.exports = { limiter, authLimiter, tradesLimiter, freqtradeLimiter };
