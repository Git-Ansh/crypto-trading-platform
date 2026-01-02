/**
 * Application configuration
 * Uses centralized env helper for type-safe environment access
 */
import { env as sharedEnv, isDev } from '../env';

// Use centralized env with fallback logic
const CORE_API_URL = sharedEnv.apiUrl;
const BOT_MANAGER_API_URL = sharedEnv.freqtradeApiUrl;
const CLIENT_URL = sharedEnv.clientUrl || (isDev ? 'http://localhost:5173' : 'https://crypto-pilot.dev');

// Log environment for debugging (dev only)
if (isDev) {
  console.log('Environment:', isDev ? 'development' : 'production');
  console.log('Core API URL:', CORE_API_URL);
  console.log('Bot Manager API URL:', BOT_MANAGER_API_URL);
  console.log('Client URL:', CLIENT_URL);
}

export const config = {
  api: {
    baseUrl: CORE_API_URL,
  },
  botManager: {
    baseUrl: BOT_MANAGER_API_URL,
  },
  client: {
    baseUrl: CLIENT_URL,
  },
  auth: {
    // Auth related configuration can go here
    tokenStorageKey: "auth_token",
  }
};

// Export environment information for use throughout the app
export const env = {
  isProduction: !isDev,
  apiUrl: CORE_API_URL,
  botManagerUrl: BOT_MANAGER_API_URL,
  clientUrl: CLIENT_URL
};
