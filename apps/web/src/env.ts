const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

export const env = {
  apiUrl: required(import.meta.env.VITE_API_URL, "VITE_API_URL"),
  freqtradeApiUrl: required(import.meta.env.VITE_FREQTRADE_API_URL, "VITE_FREQTRADE_API_URL"),
  clientUrl: import.meta.env.VITE_CLIENT_URL || "",
  posthogKey: import.meta.env.VITE_PUBLIC_POSTHOG_KEY || "",
  posthogHost: import.meta.env.VITE_PUBLIC_POSTHOG_HOST || "https://app.posthog.com",
}

export const isDev = import.meta.env.DEV
