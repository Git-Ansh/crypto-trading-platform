const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Determine Firebase initialization status based on the main app's initialization
// Assumes that index.js (or the main entry point) has already initialized Firebase.
const firebaseInitialized = admin.apps.length > 0;

if (firebaseInitialized) {
    console.log('Firebase was initialized by the main application. auth.js will use the existing instance.');
} else {
    console.warn('Firebase was NOT initialized by the main application. Firebase authentication in auth.js will be disabled.');
    // Optionally, you could attempt a fallback initialization here if desired,
    // but it's generally better to ensure the main app handles it.
    // For now, we'll proceed with firebaseInitialized as false.
}

// JWT secret validation
if (!process.env.JWT_SECRET) {
    console.warn('JWT_SECRET not set in environment variables. JWT authentication will fail.');
}

/**
 * Authentication middleware that verifies the token
 * Tries Firebase first, then falls back to JWT
 */
const authenticateToken = async (req, res, next) => {
    try {
        console.log("Authentication requested for path:", req.path);
        // Extract token from Authorization header
        const authHeader = req.header('Authorization');
        if (!authHeader) {
            console.log("No Authorization header found");
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        // Only log whether the header is in Bearer format, not the actual token content
        console.log("Auth header format:", authHeader.startsWith('Bearer ') ? 'Bearer token' : 'Raw token');

        // Parse token from Authorization header (Bearer token or raw token)
        let token;
        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        } else {
            token = authHeader;
        }

        if (!token) {
            return res.status(401).json({ success: false, message: 'Invalid token format' });
        }

        // First, try to decode the token without verification to check if it's our custom JWT
        try {
            const decodedPayload = jwt.decode(token);
            if (decodedPayload && decodedPayload.custom_jwt === true) {
                console.log("Detected custom JWT token, using JWT verification");
                // This is our custom JWT token, use JWT verification only
                try {
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    console.log("JWT verification successful for custom token. User:", decoded.user?.id || decoded.id);
                    req.user = decoded.user || decoded;
                    return next();
                } catch (jwtError) {
                    console.error('JWT verification failed for custom token. Error type:', jwtError.name);
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid custom JWT token',
                        error: 'Authentication failed (Custom JWT)'
                    });
                }
            }
        } catch (decodeError) {
            console.log('Token decode failed, proceeding with normal auth flow');
        }

        if (firebaseInitialized) {
            try {
                const decodedFirebase = await admin.auth().verifyIdToken(token);
                console.log("Firebase verification successful for user:", decodedFirebase.uid);
                req.user = {
                    id: decodedFirebase.uid,
                    email: decodedFirebase.email,
                    role: decodedFirebase.customClaims?.admin ? 'admin' : 'user', // Check custom claims for role
                    firebaseUser: decodedFirebase
                };
                return next();
            } catch (firebaseError) {
                console.log('Firebase verification failed. Error type:', firebaseError.name);
                // If Firebase verification fails, try JWT
                try {
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    console.log("JWT verification successful (after Firebase fail) for user:", decoded.user?.id || decoded.id);
                    req.user = decoded.user || decoded;
                    return next();
                } catch (jwtError) {
                    console.error('JWT verification failed (after Firebase fail). Error type:', jwtError.name);
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid token',
                        error: 'Authentication failed (Firebase then JWT)'
                    });
                }
            }
        } else {
            // Firebase not initialized, try JWT only
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                console.log("JWT verification successful (Firebase not init). User:", decoded.user?.id || decoded.id);
                req.user = decoded.user || decoded;
                return next();
            } catch (jwtError) {
                console.error('JWT verification failed (Firebase not init). Error type:', jwtError.name);
                return res.status(401).json({
                    success: false,
                    message: 'Invalid token',
                    error: 'Authentication failed (JWT only)'
                });
            }
        }
    } catch (error) {
        console.error('Outer authentication error:', error.name, error.message);
        return res.status(500).json({
            success: false,
            message: 'Server error during authentication'
        });
    }
};

/**
 * Role-based authorization middleware
 * @param {Array} roles - Array of allowed roles
 */
const authorize = (roles = []) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Unauthorized - no user found' });
        }

        if (roles.length && !roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: 'Forbidden - insufficient permissions'
            });
        }

        next();
    };
};

/**
 * Check if user owns a specific instance
 */
const checkInstanceOwnership = (req, res, next) => {
    const { instanceId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ success: false, message: 'User ID not found in token' });
    }

    // Base dir for bot instances (sync with index.js)
    // Base dir for bot instances (sync with index.js)
    let botBaseDir = process.env.BOT_BASE_DIR;

    if (!botBaseDir) {
        // Try to auto-discover
        const potentialPaths = [
            path.join(__dirname, '..', 'freqtrade-instances'), // Sibling (Dev/Standard)
            path.join(__dirname, 'freqtrade-instances'),       // Child (Some docker setups)
            '/freqtrade-instances',                            // Root mount (Docker volume)
            './freqtrade-instances'                            // Relative
        ];

        for (const p of potentialPaths) {
            if (fs.existsSync(p)) {
                botBaseDir = p;
                break;
            }
        }

        // Fallback to default if nothing found (will likely fail later but keeps consistent)
        if (!botBaseDir) botBaseDir = path.join(__dirname, '..', 'freqtrade-instances');
    }

    const BOT_BASE_DIR = botBaseDir;

    // Locate instance directory: support legacy flat structure and per-user nesting
    let instanceDir = null;
    // Legacy flat path
    const direct = path.join(BOT_BASE_DIR, instanceId);
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
        instanceDir = direct;
    } else {
        // Per-user nested paths
        try {
            if (fs.existsSync(BOT_BASE_DIR)) {
                const users = fs.readdirSync(BOT_BASE_DIR);
                for (const uid of users) {
                    const candidate = path.join(BOT_BASE_DIR, uid, instanceId);
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                        instanceDir = candidate;
                        break;
                    }
                }
            } else {
                console.warn(`[Auth] BOT_BASE_DIR does not exist: ${BOT_BASE_DIR}`);
            }
        } catch (err) {
            console.error('Error scanning instance directories:', err);
            return res.status(500).json({ success: false, message: 'Server error checking instance' });
        }
    }
    // Also search pool structure: {BOT_BASE_DIR}/{userId}/{poolId}/bots/{instanceId}/
    if (!instanceDir) {
        try {
            if (fs.existsSync(BOT_BASE_DIR)) {
                const users = fs.readdirSync(BOT_BASE_DIR);
                outerLoop:
                for (const uid of users) {
                    const userDir = path.join(BOT_BASE_DIR, uid);
                    if (!fs.statSync(userDir).isDirectory()) continue;
                    
                    // Check for pool directories (they contain 'bots' subfolder)
                    const poolCandidates = fs.readdirSync(userDir);
                    for (const poolDir of poolCandidates) {
                        const botsDir = path.join(userDir, poolDir, 'bots', instanceId);
                        if (fs.existsSync(botsDir) && fs.statSync(botsDir).isDirectory()) {
                            instanceDir = botsDir;
                            console.log(`[Auth] Found instance in pool structure: ${instanceDir}`);
                            break outerLoop;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[Auth] Error searching pool structure:', err);
        }
    }

    if (!instanceDir) {
        console.warn(`[Auth] Instance directory not found for ID: ${instanceId}`);
        return res.status(404).json({
            success: false,
            message: `Instance not found: ${instanceId}`,
            debug: `Searched in ${BOT_BASE_DIR}`
        });
    }

    const configPath = path.join(instanceDir, 'config.json');
    if (!fs.existsSync(configPath)) {
        return res.status(404).json({ success: false, message: 'Instance configuration not found' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Attach config and path to request for downstream use (e.g. proxy)
        req.botConfig = config;
        req.instanceDir = instanceDir;

        // Check if this is an admin user (can access any instance)
        if (req.user.role === 'admin') {
            return next();
        }

        // Verify ownership: either bot_name prefix or explicit userId field
        if ((config.bot_name && config.bot_name.startsWith(`${userId}-`)) || config.userId === userId) {
            return next();
        }

        return res.status(403).json({
            success: false,
            message: 'You do not have permission to access this instance'
        });
    } catch (error) {
        console.error('Error checking instance ownership:', error);
        return res.status(500).json({
            success: false,
            message: 'Error verifying instance ownership'
        });
    }
};

// Add token generation and refresh functions
const generateTokens = (user) => {
    // Access token - short lived (15 minutes)
    const accessToken = jwt.sign(
        { user },
        process.env.JWT_SECRET,
        { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m' }
    );

    // Refresh token - longer lived (7 days)
    const refreshToken = jwt.sign(
        { userId: user.id },
        process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET,
        { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '7d' }
    );

    return { accessToken, refreshToken };
};

/**
 * Refresh token verification and new token generation
 */
const refreshTokenHandler = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required'
            });
        }

        // Verify refresh token
        try {
            const decoded = jwt.verify(
                refreshToken,
                process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET
            );

            if (!decoded.userId) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid refresh token'
                });
            }

            // Get user data - either from Firebase or your database
            let userData;

            if (firebaseInitialized) {
                try {
                    // Try to get user info from Firebase
                    const userRecord = await admin.auth().getUser(decoded.userId);
                    userData = {
                        id: userRecord.uid,
                        email: userRecord.email,
                        role: userRecord.customClaims?.admin ? 'admin' : 'user'
                    };
                } catch (error) {
                    console.error('Error fetching user from Firebase:', error.name);
                    return res.status(401).json({
                        success: false,
                        message: 'User not found or invalid refresh token'
                    });
                }
            } else {
                // Simplified user data since we don't have a database
                userData = {
                    id: decoded.userId,
                    role: 'user'
                };
            }

            // Generate new tokens
            const tokens = generateTokens(userData);

            return res.json({
                success: true,
                message: 'Token refreshed successfully',
                ...tokens
            });

        } catch (error) {
            console.error('Refresh token verification failed:', error.name);
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired refresh token'
            });
        }
    } catch (error) {
        console.error('Error in refresh token handler:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error during token refresh'
        });
    }
};

module.exports = {
    authenticateToken,
    authorize,
    checkInstanceOwnership,
    generateTokens,
    refreshTokenHandler
};