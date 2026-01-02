export type UserRole = "admin" | "trader" | "viewer"
export type TokenKind = "firebase" | "jwt" | "none"

export interface UserIdentity {
  id: string
  uid?: string
  email?: string
  role: UserRole
  displayName?: string
}

export interface AuthTokenInfo {
  kind: TokenKind
  raw: string | null
  scheme: "Bearer" | "Firebase" | null
}

export interface AuthContext {
  token: AuthTokenInfo
  user?: UserIdentity
}

export interface BotInstanceMetadata {
  instanceId: string
  userId: string
  strategy: string
  tradingPairs: string[]
  dryRun: boolean
  apiPort: number
  status: "provisioning" | "running" | "stopped" | "error"
  createdAt?: string
}

export interface PortfolioHolding {
  asset: string
  free: number
  locked?: number
  usdValue?: number
}

export interface PortfolioSnapshot {
  userId: string
  equity: number
  cash: number
  timestamp: number
  timeframe: "daily" | "weekly" | "monthly" | "yearly" | "adhoc"
  holdings?: PortfolioHolding[]
}

export interface TradeRecord {
  id: string
  instanceId: string
  pair: string
  side: "buy" | "sell"
  amount: number
  price: number
  openedAt: number
  closedAt?: number
  profitPct?: number
  fee?: number
}

export interface ServiceHealth {
  service: "web" | "api-gateway" | "bot-orchestrator" | "sync" | "worker"
  status: "ok" | "degraded" | "down"
  detail?: string
  checkedAt: number
}

export type EnvStage = "development" | "production" | "test"

export interface CommonEnvConfig {
  nodeEnv: EnvStage
  port: number
  jwtSecret?: string
  firebaseProjectId?: string
  mongoUri?: string
  tursoApiKey?: string
  tursoOrg?: string
  allowedOrigins: string[]
}

export type Nullable<T> = T | null | undefined
export type WithTimestamps<T> = T & { createdAt: number; updatedAt?: number }
