#!/usr/bin/env node
/**
 * Pre-Commit Checker
 * Validates changes before allowing commit
 * Catches common issues that break production
 */

const { execSync } = require('child_process');
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

// Get staged files
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only', { encoding: 'utf8' });
    return output.trim().split('\n').filter(f => f);
  } catch (error) {
    return [];
  }
}

// Check for sensitive files
function checkSensitiveFiles(stagedFiles) {
  const errors = [];
  const warnings = [];
  
  const sensitivePatterns = [
    { pattern: /\.env$/, severity: 'error', message: '.env files contain secrets and should NOT be committed' },
    { pattern: /\.env\.local$/, severity: 'error', message: '.env.local files should NOT be committed' },
    { pattern: /\.env\.development$/, severity: 'error', message: '.env.development files should NOT be committed' },
    { pattern: /serviceAccountKey\.json$/, severity: 'error', message: 'Firebase service account keys should NOT be committed' },
    { pattern: /universal-settings-.*\.json$/, severity: 'error', message: 'User settings files should NOT be committed' },
    { pattern: /test-results-.*\.json$/, severity: 'warning', message: 'Test result files should typically not be committed' },
    { pattern: /node_modules\//, severity: 'error', message: 'node_modules should never be committed' },
    { pattern: /\.log$/, severity: 'warning', message: 'Log files should typically not be committed' },
  ];
  
  // Exception: .env.production is a template and is safe
  const exceptions = ['.env.production', '.env.example'];
  
  stagedFiles.forEach(file => {
    const isException = exceptions.some(ex => file.endsWith(ex));
    if (isException) return;
    
    sensitivePatterns.forEach(({ pattern, severity, message }) => {
      if (pattern.test(file)) {
        const msg = `${file}: ${message}`;
        if (severity === 'error') {
          errors.push(msg);
        } else {
          warnings.push(msg);
        }
      }
    });
  });
  
  return { errors, warnings };
}

// Check for hardcoded URLs/IPs
function checkHardcodedValues(stagedFiles) {
  const errors = [];
  const warnings = [];
  
  // Only check source files
  const sourceFiles = stagedFiles.filter(f => 
    f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.jsx')
  );
  
  sourceFiles.forEach(file => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        
        // Check for hardcoded localhost URLs (except in config files)
        if (!file.includes('config') && !file.includes('env')) {
          if (line.match(/['"]https?:\/\/localhost:\d+/)) {
            warnings.push(`${file}:${lineNum}: Hardcoded localhost URL - use config instead`);
          }
          
          // Check for hardcoded production URLs
          if (line.match(/['"]https:\/\/api\.crypto-pilot\.dev/)) {
            warnings.push(`${file}:${lineNum}: Hardcoded production URL - use config instead`);
          }
        }
        
        // Check for MongoDB URIs
        if (line.match(/mongodb\+srv:\/\/.*:[^@]+@/)) {
          errors.push(`${file}:${lineNum}: MongoDB URI with password - NEVER hardcode credentials`);
        }
        
        // Check for JWT secrets
        if (line.match(/JWT_SECRET\s*=\s*['"][^'"]{20,}['"]/)) {
          errors.push(`${file}:${lineNum}: Hardcoded JWT_SECRET - use environment variables`);
        }
      });
    } catch (error) {
      // File might be binary or deleted, skip
    }
  });
  
  return { errors, warnings };
}

// Check for console.log in production code (optional)
function checkDebugCode(stagedFiles) {
  const warnings = [];
  
  const sourceFiles = stagedFiles.filter(f => 
    (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.jsx')) &&
    !f.includes('test') && !f.includes('spec')
  );
  
  sourceFiles.forEach(file => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, idx) => {
        const lineNum = idx + 1;
        
        // Allow console.log for debugging, but warn about console.error/warn in critical files
        if (line.match(/console\.(error|warn)\s*\(/)) {
          if (!line.trim().startsWith('//') && file.includes('pages/')) {
            // warnings.push(`${file}:${lineNum}: console.error/warn in production page - consider proper error handling`);
          }
        }
        
        // Check for debugger statements
        if (line.match(/^\s*debugger\s*;?/)) {
          warnings.push(`${file}:${lineNum}: debugger statement should be removed`);
        }
      });
    } catch (error) {
      // Skip
    }
  });
  
  return { warnings };
}

// Check configuration consistency
function checkConfigConsistency(stagedFiles) {
  const errors = [];
  const warnings = [];
  
  // Check if env.ts is being modified
  const envTsModified = stagedFiles.includes('apps/web/src/env.ts');
  
  if (envTsModified) {
    try {
      const content = fs.readFileSync('apps/web/src/env.ts', 'utf8');
      
      // Check for required() calls without fallback
      if (content.includes('required(import.meta.env.VITE_FREQTRADE_API_URL')) {
        errors.push('apps/web/src/env.ts: VITE_FREQTRADE_API_URL should have fallback for backward compatibility');
      }
      
      // Check that freqtradeApiUrl has fallback
      if (!content.includes('freqtradeApiUrl:') || !content.includes('||')) {
        warnings.push('apps/web/src/env.ts: freqtradeApiUrl should have fallback logic');
      }
    } catch (error) {
      // Skip
    }
  }
  
  return { errors, warnings };
}

// Main check function
function runPreCommitChecks() {
  log('\n' + '='.repeat(70), 'cyan');
  log('  Pre-Commit Safety Checks', 'cyan');
  log('='.repeat(70) + '\n', 'cyan');
  
  const stagedFiles = getStagedFiles();
  
  if (stagedFiles.length === 0) {
    log('No files staged for commit', 'yellow');
    return;
  }
  
  log(`Checking ${stagedFiles.length} staged files...\n`, 'bold');
  
  let allErrors = [];
  let allWarnings = [];
  
  // Run all checks
  const checks = [
    { name: 'Sensitive Files', fn: checkSensitiveFiles },
    { name: 'Hardcoded Values', fn: checkHardcodedValues },
    { name: 'Debug Code', fn: checkDebugCode },
    { name: 'Config Consistency', fn: checkConfigConsistency }
  ];
  
  checks.forEach(({ name, fn }) => {
    log(`Running ${name} check...`, 'cyan');
    const result = fn(stagedFiles);
    
    if (result.errors && result.errors.length > 0) {
      allErrors = allErrors.concat(result.errors);
    }
    
    if (result.warnings && result.warnings.length > 0) {
      allWarnings = allWarnings.concat(result.warnings);
    }
  });
  
  // Display results
  log('\n' + '='.repeat(70), 'cyan');
  
  if (allErrors.length > 0) {
    log('\n❌ ERRORS (must fix):', 'red');
    allErrors.forEach(err => log(`  • ${err}`, 'red'));
  }
  
  if (allWarnings.length > 0) {
    log('\n⚠️  WARNINGS (review recommended):', 'yellow');
    allWarnings.forEach(warn => log(`  • ${warn}`, 'yellow'));
  }
  
  log('\n' + '='.repeat(70), 'cyan');
  
  if (allErrors.length > 0) {
    log('\n❌ COMMIT BLOCKED', 'red');
    log('Fix the errors above before committing', 'red');
    log('\nTo unstage sensitive files:', 'yellow');
    log('  git restore --staged <file>', 'yellow');
    log('\n', 'cyan');
    process.exit(1);
  } else if (allWarnings.length > 0) {
    log('\n✓ Commit allowed with warnings', 'green');
    log('Review warnings above - they may indicate issues', 'yellow');
    log('\n', 'cyan');
    process.exit(0);
  } else {
    log('\n✓ All checks passed!', 'green');
    log('Safe to commit', 'green');
    log('\n', 'cyan');
    process.exit(0);
  }
}

// Run checks
if (require.main === module) {
  try {
    runPreCommitChecks();
  } catch (error) {
    log(`\n✗ Pre-commit check error: ${error.message}`, 'red');
    process.exit(1);
  }
}

module.exports = { runPreCommitChecks, getStagedFiles };
