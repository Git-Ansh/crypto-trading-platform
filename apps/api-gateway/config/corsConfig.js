// Create a dedicated CORS configuration file
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOW_DEV_ORIGINS = process.env.ALLOW_DEV_ORIGINS === 'true';

// Define allowed origins - include localhost when ALLOW_DEV_ORIGINS is set
const productionOrigins = [
  "https://www.crypto-pilot.dev",
  "https://crypto-pilot.dev",
  "https://app.crypto-pilot.dev",
];

const devOrigins = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://192.168.1.225:5174",
  "http://192.168.1.225:5173",
  "http://167.88.38.231:5173",
  "http://172.19.0.1:5173",
];

// In production, allow dev origins if explicitly enabled (for local testing against prod backend)
const allowedOrigins =
  NODE_ENV === "production"
    ? ALLOW_DEV_ORIGINS 
      ? [...productionOrigins, ...devOrigins]
      : productionOrigins
    : [...productionOrigins, ...devOrigins];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

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
};

// Remove the app.use and app.options calls from this file
// They should only be in index.js

module.exports = corsOptions;
