const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { check, validationResult } = require("express-validator");
const User = require("../models/user");
const auth = require("../middleware/auth");

// ============== GET ACCOUNT PROFILE ==============
router.get("/profile", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      data: {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName || user.username,
        avatar: user.avatar,
        timezone: user.timezone,
        preferredCurrency: user.preferredCurrency,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        authProvider: user.authProvider,
        hasPassword: !!user.password,
        paperWallet: user.paperWallet,
        subscription: user.subscription,
        notificationPreferences: user.notificationPreferences,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== UPDATE PROFILE ==============
router.put(
  "/profile",
  auth,
  [
    check("displayName").optional().isLength({ max: 100 }),
    check("timezone").optional().isString(),
    check("preferredCurrency").optional().isIn(["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"]),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { displayName, timezone, preferredCurrency, avatar } = req.body;

      const updateFields = {};
      if (displayName !== undefined) updateFields.displayName = displayName;
      if (timezone !== undefined) updateFields.timezone = timezone;
      if (preferredCurrency !== undefined) updateFields.preferredCurrency = preferredCurrency;
      if (avatar !== undefined) updateFields.avatar = avatar;

      const user = await User.findByIdAndUpdate(
        req.user.id,
        { $set: updateFields },
        { new: true }
      ).select("-password -twoFactorSecret -emailVerificationToken");

      res.json({
        success: true,
        message: "Profile updated successfully",
        data: {
          displayName: user.displayName,
          timezone: user.timezone,
          preferredCurrency: user.preferredCurrency,
          avatar: user.avatar,
        },
      });
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ============== CHANGE PASSWORD ==============
router.post(
  "/change-password",
  auth,
  [
    check("currentPassword").optional(),
    check("newPassword", "New password must be at least 6 characters").isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { currentPassword, newPassword } = req.body;
      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      // If user has existing password (not social login), verify current password
      if (user.password && user.authProvider === 'local') {
        if (!currentPassword) {
          return res.status(400).json({ 
            success: false, 
            message: "Current password is required" 
          });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
          return res.status(400).json({ 
            success: false, 
            message: "Current password is incorrect" 
          });
        }
      }

      // Hash new password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);

      await User.findByIdAndUpdate(req.user.id, {
        $set: { password: hashedPassword },
      });

      res.json({
        success: true,
        message: user.password ? "Password changed successfully" : "Password set successfully",
      });
    } catch (error) {
      console.error("Change password error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ============== GET SESSIONS ==============
router.get("/sessions", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("sessions");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({
      success: true,
      data: user.sessions || [],
    });
  } catch (error) {
    console.error("Get sessions error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== REVOKE SESSION ==============
router.delete("/sessions/:sessionId", auth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    await User.findByIdAndUpdate(req.user.id, {
      $pull: { sessions: { sessionId } },
    });

    res.json({
      success: true,
      message: "Session revoked successfully",
    });
  } catch (error) {
    console.error("Revoke session error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== GET WALLET ==============
router.get("/wallet", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "paperWallet walletTransactions botAllocations"
    );

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Calculate total allocated to bots
    let totalAllocated = 0;
    if (user.botAllocations) {
      for (const [, allocation] of user.botAllocations) {
        totalAllocated += allocation.allocatedAmount || 0;
      }
    }

    res.json({
      success: true,
      data: {
        balance: user.paperWallet?.balance || 1000,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: user.paperWallet?.lastUpdated,
        totalAllocated,
        totalPortfolioValue: (user.paperWallet?.balance || 1000) + totalAllocated,
        botAllocations: user.botAllocations ? Object.fromEntries(user.botAllocations) : {},
        recentTransactions: (user.walletTransactions || [])
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 20),
      },
    });
  } catch (error) {
    console.error("Get wallet error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== SET WALLET BALANCE ==============
router.post(
  "/wallet/set-balance",
  auth,
  [check("amount", "Amount must be a positive number").isFloat({ min: 0, max: 1000000 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { amount } = req.body;
      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const oldBalance = user.paperWallet?.balance || 1000;
      const difference = amount - oldBalance;

      // Update wallet balance
      user.paperWallet = {
        balance: amount,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: new Date(),
      };

      // Add transaction record
      user.walletTransactions.push({
        type: difference >= 0 ? 'deposit' : 'withdraw',
        amount: Math.abs(difference),
        description: `Wallet balance ${difference >= 0 ? 'increased' : 'decreased'} from $${oldBalance.toFixed(2)} to $${amount.toFixed(2)}`,
        balanceAfter: amount,
        timestamp: new Date(),
      });

      await user.save();

      res.json({
        success: true,
        message: "Wallet balance updated successfully",
        data: {
          balance: user.paperWallet.balance,
          currency: user.paperWallet.currency,
        },
      });
    } catch (error) {
      console.error("Set wallet balance error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ============== DEPOSIT TO WALLET ==============
router.post(
  "/wallet/deposit",
  auth,
  [check("amount", "Amount must be a positive number").isFloat({ min: 0.01 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { amount, description } = req.body;
      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      // Check max wallet size
      const currentBalance = user.paperWallet?.balance || 0;
      const maxWalletSize = user.subscription?.maxWalletSize || 100000;

      if (currentBalance + amount > maxWalletSize) {
        return res.status(400).json({
          success: false,
          message: `Deposit would exceed maximum wallet size of $${maxWalletSize.toLocaleString()}`,
        });
      }

      const newBalance = currentBalance + amount;

      // Update wallet
      user.paperWallet = {
        balance: newBalance,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: new Date(),
      };

      // Add transaction
      user.walletTransactions.push({
        type: 'deposit',
        amount,
        description: description || 'Paper money deposit',
        balanceAfter: newBalance,
        timestamp: new Date(),
      });

      await user.save();

      res.json({
        success: true,
        message: "Deposit successful",
        data: {
          balance: newBalance,
          deposited: amount,
        },
      });
    } catch (error) {
      console.error("Deposit error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ============== WITHDRAW FROM WALLET ==============
router.post(
  "/wallet/withdraw",
  auth,
  [check("amount", "Amount must be a positive number").isFloat({ min: 0.01 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { amount, description } = req.body;
      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const currentBalance = user.paperWallet?.balance || 0;

      if (amount > currentBalance) {
        return res.status(400).json({
          success: false,
          message: "Insufficient funds",
        });
      }

      const newBalance = currentBalance - amount;

      // Update wallet
      user.paperWallet = {
        balance: newBalance,
        currency: user.paperWallet?.currency || 'USD',
        lastUpdated: new Date(),
      };

      // Add transaction
      user.walletTransactions.push({
        type: 'withdraw',
        amount,
        description: description || 'Paper money withdrawal',
        balanceAfter: newBalance,
        timestamp: new Date(),
      });

      await user.save();

      res.json({
        success: true,
        message: "Withdrawal successful",
        data: {
          balance: newBalance,
          withdrawn: amount,
        },
      });
    } catch (error) {
      console.error("Withdraw error:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ============== GET WALLET TRANSACTIONS ==============
router.get("/wallet/transactions", auth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, type } = req.query;

    const user = await User.findById(req.user.id).select("walletTransactions");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    let transactions = user.walletTransactions || [];

    // Filter by type if specified
    if (type) {
      transactions = transactions.filter((t) => t.type === type);
    }

    // Sort by timestamp descending
    transactions.sort((a, b) => b.timestamp - a.timestamp);

    // Paginate
    const total = transactions.length;
    const paginatedTransactions = transactions.slice(
      parseInt(offset),
      parseInt(offset) + parseInt(limit)
    );

    res.json({
      success: true,
      data: {
        transactions: paginatedTransactions,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    console.error("Get transactions error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== UPDATE NOTIFICATION PREFERENCES ==============
router.put("/notifications", auth, async (req, res) => {
  try {
    const { emailNotifications, pushNotifications, notificationFrequency } = req.body;

    const updateFields = {};
    if (emailNotifications !== undefined) {
      updateFields["notificationPreferences.emailNotifications"] = emailNotifications;
    }
    if (pushNotifications !== undefined) {
      updateFields["notificationPreferences.pushNotifications"] = pushNotifications;
    }
    if (notificationFrequency !== undefined) {
      updateFields["notificationPreferences.notificationFrequency"] = notificationFrequency;
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateFields },
      { new: true }
    ).select("notificationPreferences");

    res.json({
      success: true,
      message: "Notification preferences updated",
      data: user.notificationPreferences,
    });
  } catch (error) {
    console.error("Update notifications error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== SEND EMAIL VERIFICATION ==============
router.post("/send-verification-email", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.emailVerified) {
      return res.status(400).json({ success: false, message: "Email is already verified" });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await User.findByIdAndUpdate(req.user.id, {
      $set: {
        emailVerificationToken: verificationToken,
        emailVerificationExpires: verificationExpires,
      },
    });

    // TODO: Send email with verification link
    // The verification link would be: ${FRONTEND_URL}/verify-email?token=${verificationToken}

    res.json({
      success: true,
      message: "Verification email sent",
      // For development, return the token (remove in production)
      ...(process.env.NODE_ENV === 'development' && { token: verificationToken }),
    });
  } catch (error) {
    console.error("Send verification email error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ============== VERIFY EMAIL ==============
router.post("/verify-email", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ success: false, message: "Token is required" });
    }

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification token",
      });
    }

    await User.findByIdAndUpdate(user._id, {
      $set: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
      },
    });

    res.json({
      success: true,
      message: "Email verified successfully",
    });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
