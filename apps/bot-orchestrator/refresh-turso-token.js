#!/usr/bin/env node

/**
 * Turso Token Management Utility
 * 
 * This script automatically manages Turso API tokens with programmatic renewal.
 * It uses the Turso REST API to create new tokens before the current ones expire.
 * 
 * Usage:
 *   node refresh-turso-token.js [options]
 * 
 * Options:
 *   --check      - Check current token status
 *   --renew      - Force token renewal
 *   --schedule   - Start automatic renewal scheduler
 */

const { spawn } = require('child_process');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const TURSO_CMD = process.env.TURSO_CMD || 'turso';
const TURSO_API_KEY = process.env.TURSO_API_KEY;
const TURSO_ORG = process.env.TURSO_ORG;
const TURSO_API_BASE_URL = 'https://api.turso.tech';

// Token storage file
const TOKEN_STORAGE_FILE = path.join(__dirname, '.turso-tokens.json');

class TursoTokenManager {
  constructor() {
    this.currentToken = TURSO_API_KEY;
    this.tokenStorage = this.loadTokenStorage();
  }

  loadTokenStorage() {
    try {
      if (fs.existsSync(TOKEN_STORAGE_FILE)) {
        return JSON.parse(fs.readFileSync(TOKEN_STORAGE_FILE, 'utf8'));
      }
    } catch (error) {
      console.warn('Warning: Could not load token storage file');
    }
    return { tokens: [], lastRotation: null };
  }

  saveTokenStorage() {
    try {
      fs.writeFileSync(TOKEN_STORAGE_FILE, JSON.stringify(this.tokenStorage, null, 2));
    } catch (error) {
      console.error('Error saving token storage:', error.message);
    }
  }

  async makeApiRequest(endpoint, method = 'GET', body = null) {
    const fetch = (await import('node-fetch')).default;

    const url = `${TURSO_API_BASE_URL}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.currentToken}`,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json();
  }

  generateTokenName() {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `bot-manager-${timestamp}-${random}`;
  }

  async createNewToken(expiration = '30d') {
    console.log('🔄 Creating new API token...');

    const tokenName = this.generateTokenName();

    try {
      const response = await this.makeApiRequest(`/v1/auth/api-tokens/${tokenName}`, 'POST', {
        expiration: expiration
      });

      console.log(`✓ New token created: ${tokenName}`);
      console.log(`  Expiration: ${expiration}`);

      return {
        name: tokenName,
        token: response.token,
        createdAt: new Date().toISOString(),
        expiresAt: this.calculateExpirationDate(expiration)
      };
    } catch (error) {
      console.error(`❌ Failed to create new token: ${error.message}`);
      throw error;
    }
  }

  calculateExpirationDate(expiration) {
    const now = new Date();
    const match = expiration.match(/^(\d+)([dhm])$/);

    if (!match) {
      return null; // Non-expiring token
    }

    const [, amount, unit] = match;
    const value = parseInt(amount);

    switch (unit) {
      case 'd':
        return new Date(now.getTime() + value * 24 * 60 * 60 * 1000).toISOString();
      case 'h':
        return new Date(now.getTime() + value * 60 * 60 * 1000).toISOString();
      case 'm':
        return new Date(now.getTime() + value * 60 * 1000).toISOString();
      default:
        return null;
    }
  }

  async revokeToken(tokenName) {
    console.log(`🗑️  Revoking old token: ${tokenName}`);

    try {
      await this.makeApiRequest(`/v1/auth/api-tokens/${tokenName}`, 'DELETE');
      console.log(`✓ Token revoked: ${tokenName}`);
    } catch (error) {
      console.warn(`⚠️  Failed to revoke token ${tokenName}: ${error.message}`);
    }
  }

  async renewToken() {
    console.log('=== Turso Token Renewal Process ===');
    console.log('');

    if (!this.currentToken || !TURSO_ORG) {
      console.error('❌ TURSO_API_KEY or TURSO_ORG not found in environment variables');
      console.error('   Please check your .env file configuration');
      return false;
    }

    try {
      // Step 1: Validate current token
      console.log('Step 1: Validating current token...');
      const isValid = await this.validateCurrentToken();

      if (!isValid) {
        console.error('❌ Current token is invalid. Please obtain a valid token first.');
        return false;
      }

      // Step 2: Create new token
      console.log('Step 2: Creating new token...');
      const newTokenInfo = await this.createNewToken('30d'); // 30 days expiration

      // Step 3: Store new token
      console.log('Step 3: Storing new token...');
      this.tokenStorage.tokens.push(newTokenInfo);
      this.tokenStorage.lastRotation = new Date().toISOString();
      this.saveTokenStorage();

      // Step 4: Update environment file
      console.log('Step 4: Updating environment file...');
      await this.updateEnvironmentFile(newTokenInfo.token);

      // Step 5: Revoke old token (if we have a previous one)
      if (this.tokenStorage.tokens.length > 1) {
        console.log('Step 5: Revoking old token...');
        const oldToken = this.tokenStorage.tokens[this.tokenStorage.tokens.length - 2];
        await this.revokeToken(oldToken.name);

        // Clean up old token from storage
        this.tokenStorage.tokens = this.tokenStorage.tokens.filter(t => t.name !== oldToken.name);
        this.saveTokenStorage();
      }

      console.log('');
      console.log('🎉 Token renewal completed successfully!');
      console.log(`   New token expires: ${newTokenInfo.expiresAt}`);
      console.log('   Please restart your bot manager service to use the new token.');

      return true;
    } catch (error) {
      console.error('❌ Token renewal failed:', error.message);
      return false;
    }
  }

  async validateCurrentToken() {
    try {
      const response = await this.makeApiRequest('/v1/auth/validate');
      console.log('✓ Current token is valid');
      return true;
    } catch (error) {
      console.log('❌ Current token is invalid or expired');
      return false;
    }
  }

  async updateEnvironmentFile(newToken) {
    const envFile = path.join(__dirname, '.env');

    try {
      let envContent = '';

      if (fs.existsSync(envFile)) {
        envContent = fs.readFileSync(envFile, 'utf8');
      }

      // Update or add TURSO_API_KEY
      const lines = envContent.split('\n');
      let found = false;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('TURSO_API_KEY=')) {
          lines[i] = `TURSO_API_KEY=${newToken}`;
          found = true;
          break;
        }
      }

      if (!found) {
        lines.push(`TURSO_API_KEY=${newToken}`);
      }

      fs.writeFileSync(envFile, lines.join('\n'));
      console.log('✓ Environment file updated');
    } catch (error) {
      console.error('❌ Failed to update environment file:', error.message);
      throw error;
    }
  }

  async checkTokenExpiration() {
    const now = new Date();
    const currentTokenInfo = this.tokenStorage.tokens[this.tokenStorage.tokens.length - 1];

    if (!currentTokenInfo || !currentTokenInfo.expiresAt) {
      console.log('⚠️  No expiration info available for current token');
      return false;
    }

    const expirationDate = new Date(currentTokenInfo.expiresAt);
    const daysUntilExpiration = Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24));

    console.log(`Token expires in ${daysUntilExpiration} days (${currentTokenInfo.expiresAt})`);

    // Return true if token expires within 7 days
    return daysUntilExpiration <= 7;
  }

  async startAutoRenewal() {
    console.log('🔄 Starting automatic token renewal scheduler...');

    const checkInterval = 24 * 60 * 60 * 1000; // Check daily

    const check = async () => {
      console.log('⏰ Checking token expiration...');

      try {
        const needsRenewal = await this.checkTokenExpiration();

        if (needsRenewal) {
          console.log('🔄 Token needs renewal, starting process...');
          await this.renewToken();
        } else {
          console.log('✓ Token is still valid');
        }
      } catch (error) {
        console.error('❌ Auto-renewal check failed:', error.message);
      }
    };

    // Initial check
    await check();

    // Schedule regular checks
    setInterval(check, checkInterval);

    console.log('✓ Auto-renewal scheduler started (checking daily)');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const manager = new TursoTokenManager();

  if (args.includes('--check')) {
    console.log('=== Token Status Check ===');
    const isValid = await manager.validateCurrentToken();
    const needsRenewal = await manager.checkTokenExpiration();

    if (needsRenewal) {
      console.log('⚠️  Token will expire soon and should be renewed');
    }

    process.exit(isValid ? 0 : 1);
  }

  if (args.includes('--renew')) {
    const success = await manager.renewToken();
    process.exit(success ? 0 : 1);
  }

  if (args.includes('--schedule')) {
    await manager.startAutoRenewal();
    // Keep the process running
    process.stdin.resume();
    return;
  }

  // Default behavior: validate and renew if needed
  console.log('=== Turso Token Management ===');
  console.log('');

  const isValid = await manager.validateCurrentToken();
  if (isValid) {
    const needsRenewal = await manager.checkTokenExpiration();
    if (needsRenewal) {
      const success = await manager.renewToken();
      process.exit(success ? 0 : 1);
    } else {
      console.log('✓ Token is valid and doesn\'t need renewal yet');
      process.exit(0);
    }
  } else {
    console.log('❌ Current token is invalid. Please obtain a valid token first.');
    console.log('   Run: turso auth login && turso auth token');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Gracefully shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Gracefully shutting down...');
  process.exit(0);
});

// Run the main function
main().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
