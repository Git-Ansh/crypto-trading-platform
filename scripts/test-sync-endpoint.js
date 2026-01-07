#!/usr/bin/env node

/**
 * Test the sync endpoint by making a direct HTTP request
 * This requires a valid Firebase token
 */

const http = require('http');

const TOKEN = process.argv[2];

if (!TOKEN) {
  console.error('Usage: node test-sync-endpoint.js <firebase-token>');
  console.error('\nTo get your token:');
  console.error('1. Open browser console on crypto-pilot.dev');
  console.error('2. Run: localStorage.getItem("firebaseToken")');
  console.error('3. Copy the token (without quotes)');
  process.exit(1);
}

const options = {
  hostname: 'localhost',
  port: 5001,
  path: '/api/freqtrade/sync-wallet',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
};

console.log('Calling sync endpoint...');
console.log(`URL: http://localhost:5001/api/freqtrade/sync-wallet\n`);

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`Status: ${res.statusCode}\n`);
    
    try {
      const json = JSON.parse(data);
      console.log('Response:');
      console.log(JSON.stringify(json, null, 2));
      
      if (json.success) {
        console.log('\n✓ Wallet sync completed successfully');
        
        if (json.data && json.data.cleanedBots && json.data.cleanedBots.length > 0) {
          console.log('\nCleaned bots:');
          json.data.cleanedBots.forEach(bot => {
            console.log(`  - ${bot.botName} (${bot.botId}): $${bot.returned.toFixed(2)} (P&L: ${bot.pnl >= 0 ? '+' : ''}$${bot.pnl.toFixed(2)})`);
          });
          console.log(`\nTotal returned: $${json.data.totalReturned.toFixed(2)}`);
          console.log(`New wallet balance: $${json.data.newWalletBalance.toFixed(2)}`);
        }
      } else {
        console.log('\n✗ Wallet sync failed');
        console.log(`Error: ${json.message}`);
      }
    } catch (e) {
      console.log('Raw response:');
      console.log(data);
    }
  });
});

req.on('error', (error) => {
  console.error('✗ Error:', error.message);
  process.exit(1);
});

req.end();

