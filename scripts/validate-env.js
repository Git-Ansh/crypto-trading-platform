#!/usr/bin/env node
/**
 * Environment Configuration Validator
 * Ensures all required environment variables are present and valid
 * Run this before committing or deploying
 * testing: node scripts/validate-env.js
 */

const fs = require('fs');
const path = require('path');

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(message, color = 'reset') {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

// Define required env vars for each service
const ENV_REQUIREMENTS = {
  'apps/api-gateway': {
    production: [
      'NODE_ENV',
      'PORT',
      'MONGODB_URI', // Accept either MONGODB_URI or MONGO_URI
      'JWT_SECRET',
      'ENCRYPTION_KEY',
      'FIREBASE_PROJECT_ID',
      'BOT_MANAGER_URL',
      'ALLOWED_ORIGINS'
    ],
    development: [
      'NODE_ENV',
      'PORT',
      'MONGODB_URI',
      'JWT_SECRET',
      'ENCRYPTION_KEY',
      'FIREBASE_PROJECT_ID',
      'BOT_MANAGER_URL',
      'ALLOWED_ORIGINS'
    ]
  },
  'apps/bot-orchestrator': {
    production: [
      'NODE_ENV',
      'PORT',
      'JWT_SECRET',
      'FIREBASE_PROJECT_ID',
      'ALLOWED_ORIGINS'
    ],
    development: [
      'NODE_ENV',
      'PORT',
      'JWT_SECRET',
      'FIREBASE_PROJECT_ID',
      'ALLOWED_ORIGINS'
    ]
  },
  'apps/web': {
    production: [
      'VITE_API_URL',
      'VITE_FREQTRADE_API_URL',
      'VITE_CLIENT_URL',
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID'
    ],
    development: [
      'VITE_API_URL',
      'VITE_FREQTRADE_API_URL', // Now required
      'VITE_CLIENT_URL',
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID'
    ]
  }
};

// Parse .env file
function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  const content = fs.readFileSync(filePath, 'utf8');
  const vars = {};
  
  content.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key) {
        vars[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  
  return vars;
}

// Validate a single service
function validateService(servicePath, envType) {
  let envFile = path.join(servicePath, `.env.${envType}`);
  
  // For development, allow fallback to generic .env
  if (envType === 'development' && !fs.existsSync(envFile)) {
    const genericEnvFile = path.join(servicePath, '.env');
    if (fs.existsSync(genericEnvFile)) {
      envFile = genericEnvFile;
    }
  }
  
  const requirements = ENV_REQUIREMENTS[servicePath]?.[envType];
  
  if (!requirements) {
    log(`⚠️  No requirements defined for ${servicePath} (${envType})`, 'yellow');
    return { valid: true, warnings: [] };
  }
  
  const envVars = parseEnvFile(envFile);
  
  if (!envVars) {
    return { 
      valid: false, 
      errors: [`Missing ${envFile}`],
      warnings: []
    };
  }
  
  const errors = [];
  const warnings = [];
  const missing = [];
  
  // Check required vars
  requirements.forEach(varName => {
    if (!envVars[varName] || envVars[varName] === '') {
      missing.push(varName);
    }
  });
  
  if (missing.length > 0) {
    errors.push(`Missing required variables: ${missing.join(', ')}`);
  }
  
  // Service-specific validations
  if (servicePath === 'apps/web') {
    // Validate VITE_FREQTRADE_API_URL matches VITE_API_URL pattern
    if (envVars.VITE_API_URL && envVars.VITE_FREQTRADE_API_URL) {
      const apiUrl = envVars.VITE_API_URL;
      const freqtradeUrl = envVars.VITE_FREQTRADE_API_URL;
      
      // Should be: apiUrl + /api/freqtrade
      const expected = `${apiUrl}/api/freqtrade`;
      if (freqtradeUrl !== expected) {
        warnings.push(`VITE_FREQTRADE_API_URL should be "${expected}" but is "${freqtradeUrl}"`);
      }
    }
  }
  
  if (servicePath === 'apps/api-gateway') {
    // Validate CORS origins
    if (envVars.ALLOWED_ORIGINS) {
      const origins = envVars.ALLOWED_ORIGINS.split(',');
      if (envType === 'production') {
        const hasLocalhost = origins.some(o => o.includes('localhost') || o.includes('127.0.0.1'));
        if (hasLocalhost) {
          warnings.push('Production CORS includes localhost - this is usually wrong');
        }
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// Main validation
function validateAll() {
  log('\n' + '='.repeat(70), 'cyan');
  log('  Environment Configuration Validator', 'cyan');
  log('='.repeat(70) + '\n', 'cyan');
  
  let hasErrors = false;
  const results = {};
  
  // Validate each service for both environments
  for (const [servicePath, envs] of Object.entries(ENV_REQUIREMENTS)) {
    log(`\n📦 Validating ${servicePath}...`, 'bold');
    
    for (const envType of ['development', 'production']) {
      const result = validateService(servicePath, envType);
      results[`${servicePath}:${envType}`] = result;
      
      if (result.valid) {
        log(`  ✓ ${envType}: OK`, 'green');
      } else {
        log(`  ✗ ${envType}: FAILED`, 'red');
        hasErrors = true;
      }
      
      // Show errors
      if (result.errors && result.errors.length > 0) {
        result.errors.forEach(err => {
          log(`    ERROR: ${err}`, 'red');
        });
      }
      
      // Show warnings
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach(warn => {
          log(`    WARNING: ${warn}`, 'yellow');
        });
      }
    }
  }
  
  // Summary
  log('\n' + '='.repeat(70), 'cyan');
  if (hasErrors) {
    log('  ✗ VALIDATION FAILED', 'red');
    log('  Fix errors above before committing/deploying', 'red');
    log('='.repeat(70) + '\n', 'cyan');
    process.exit(1);
  } else {
    log('  ✓ ALL VALIDATIONS PASSED', 'green');
    log('  Safe to commit and deploy', 'green');
    log('='.repeat(70) + '\n', 'cyan');
    process.exit(0);
  }
}

// Run validation
if (require.main === module) {
  try {
    validateAll();
  } catch (error) {
    log(`\n✗ Validation script error: ${error.message}`, 'red');
    process.exit(1);
  }
}

module.exports = { validateAll, validateService, parseEnvFile };
