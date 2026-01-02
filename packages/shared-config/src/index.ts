import { CommonEnvConfig, EnvStage } from "@crypto-trading-platform/shared-types"

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
]

const asEnvStage = (value?: string | null): EnvStage => {
  const normalized = (value || "").toLowerCase()
  if (normalized === "production") return "production"
  if (normalized === "test") return "test"
  return "development"
}

const parsePort = (value?: string | null, fallback = 0): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const normalizeOrigins = (
  value: string | undefined,
  fallback: string[]
): string[] => {
  if (!value) return [...fallback]
  return value
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export const booleanFromEnv = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback
  const normalized = value.toLowerCase()
  return ["1", "true", "yes", "on"].includes(normalized)
}

export const loadCommonConfig = (env: Record<string, string | undefined>): CommonEnvConfig => {
  const nodeEnv = asEnvStage(env.NODE_ENV)
  const port = parsePort(env.PORT, nodeEnv === "development" ? 5000 : 0)
  const allowedOrigins = normalizeOrigins(
    env.ALLOWED_ORIGINS,
    nodeEnv === "production" ? [] : DEFAULT_DEV_ORIGINS
  )

  return {
    nodeEnv,
    port,
    jwtSecret: env.JWT_SECRET,
    firebaseProjectId: env.FIREBASE_PROJECT_ID,
    mongoUri: env.MONGO_URI || env.MONGODB_URI,
    tursoApiKey: env.TURSO_API_KEY,
    tursoOrg: env.TURSO_ORG,
    allowedOrigins,
  }
}

export const assertConfig = (
  config: CommonEnvConfig,
  requiredKeys: Array<keyof CommonEnvConfig>
): void => {
  const missing = requiredKeys.filter((key) => {
    const value = (config as Record<string, unknown>)[key]
    return value === undefined || value === null || value === ""
  })

  if (missing.length > 0) {
    throw new Error(`Missing required config values: ${missing.join(", ")}`)
  }
}

export const resolveOrigins = (
  env: Record<string, string | undefined>,
  overrides?: string[]
): string[] => {
  if (overrides && overrides.length > 0) return overrides
  const config = loadCommonConfig(env)
  return config.allowedOrigins
}
