const mongoose = require("mongoose");

// Session schema for tracking active sessions
const SessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
  },
  device: {
    type: String,
    default: 'Unknown Device',
  },
  browser: {
    type: String,
    default: 'Unknown Browser',
  },
  ip: {
    type: String,
    default: 'Unknown',
  },
  location: {
    type: String,
    default: 'Unknown Location',
  },
  lastActive: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Wallet transaction schema
const WalletTransactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['deposit', 'withdraw', 'allocate', 'deallocate', 'profit', 'loss'],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  botId: {
    type: String,
    default: null,
  },
  botName: {
    type: String,
    default: null,
  },
  description: {
    type: String,
    default: '',
  },
  balanceAfter: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    // Not required for Firebase users
  },
  firebaseUid: {
    type: String,
    sparse: true, // Allow null but enforce uniqueness when present
    unique: true,
  },
  authProvider: {
    type: String,
    enum: ['local', 'google', 'facebook', 'github'],
    default: 'local',
  },
  
  // Profile settings
  displayName: {
    type: String,
    default: '',
  },
  avatar: {
    type: String,
    default: '',
  },
  timezone: {
    type: String,
    default: 'UTC',
  },
  preferredCurrency: {
    type: String,
    enum: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'],
    default: 'USD',
  },
  
  // Email verification
  emailVerified: {
    type: Boolean,
    default: false,
  },
  emailVerificationToken: {
    type: String,
    default: null,
  },
  emailVerificationExpires: {
    type: Date,
    default: null,
  },
  
  // Security settings
  twoFactorEnabled: {
    type: Boolean,
    default: false,
  },
  twoFactorSecret: {
    type: String,
    default: null,
  },
  
  // Paper trading wallet
  paperWallet: {
    balance: {
      type: Number,
      default: 1000,
    },
    currency: {
      type: String,
      default: 'USD',
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  walletTransactions: [WalletTransactionSchema],
  
  // Bot allocations tracking (Bot Pool)
  botAllocations: {
    type: Map,
    of: {
      allocatedAmount: Number,      // Initial allocation from wallet
      currentValue: Number,         // Current value (allocated + P&L)
      reservedInTrades: Number,     // Currently in open positions
      availableBalance: Number,     // Free to trade
      lifetimePnL: Number,          // Total profit/loss since creation
      allocatedAt: Date,
      botName: String,
    },
    default: new Map(),
  },
  
  // Active sessions
  sessions: [SessionSchema],
  
  // Notification preferences (placeholder)
  notificationPreferences: {
    emailNotifications: {
      tradeAlerts: { type: Boolean, default: true },
      dailySummary: { type: Boolean, default: true },
      botErrors: { type: Boolean, default: true },
    },
    pushNotifications: { type: Boolean, default: false },
    notificationFrequency: {
      type: String,
      enum: ['instant', 'hourly', 'daily'],
      default: 'instant',
    },
  },
  
  // Subscription/Plan (placeholder)
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free',
    },
    maxBots: {
      type: Number,
      default: 3,
    },
    maxWalletSize: {
      type: Number,
      default: 100000,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  
  // Auth provider info
  authProvider: {
    type: String,
    enum: ['local', 'google', 'github', 'twitter'],
    default: 'local',
  },
  
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  lastLogin: {
    type: Date,
    default: null,
  },
  role: {
    type: String,
    enum: ["user", "admin"],
    default: "user",
  },
  isActive: {
    type: Boolean,
    default: true,
  },
});

// Update the updatedAt field on save
UserSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Check if the model exists before creating it
module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
