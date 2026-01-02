import {
  AuthContext,
  AuthTokenInfo,
  TokenKind,
  UserIdentity,
} from "@crypto-trading-platform/shared-types"

export class AuthError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 401) {
    super(message)
    this.name = "AuthError"
    this.statusCode = statusCode
  }
}

const BEARER_PREFIX = "bearer "
const FIREBASE_PREFIX = "firebase "

type HeaderMap = Record<string, string | undefined>

const trimValue = (value: string | undefined): string | null => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const parseAuthorizationHeader = (
  header?: string | null
): AuthTokenInfo => {
  const rawHeader = trimValue(header || undefined)
  if (!rawHeader) {
    return { kind: "none", raw: null, scheme: null }
  }

  const normalized = rawHeader.toLowerCase()

  if (normalized.startsWith(FIREBASE_PREFIX)) {
    const token = trimValue(rawHeader.slice(FIREBASE_PREFIX.length))
    return { kind: "firebase", raw: token, scheme: "Firebase" }
  }

  if (normalized.startsWith(BEARER_PREFIX)) {
    const token = trimValue(rawHeader.slice(BEARER_PREFIX.length))
    return { kind: "jwt", raw: token, scheme: "Bearer" }
  }

  // Default to bearer-style tokens when a scheme is omitted.
  return { kind: "jwt", raw: rawHeader, scheme: "Bearer" }
}

export const buildAuthContext = (
  headers: HeaderMap,
  user?: UserIdentity
): AuthContext => {
  const header = headers.authorization ?? headers.Authorization
  const token = parseAuthorizationHeader(header as string | undefined)
  return { token, user }
}

export const requireUser = (context: AuthContext): UserIdentity => {
  if (!context.user) {
    throw new AuthError("Authentication required", 401)
  }
  return context.user
}

export const maskToken = (token: string | null, visible = 4): string => {
  if (!token) return "<missing>"
  const trimmed = token.trim()
  if (trimmed.length <= visible) return trimmed
  const tail = trimmed.slice(-visible)
  return `${"*".repeat(Math.max(trimmed.length - visible, 4))}${tail}`
}

export const authKindFromContext = (context: AuthContext): TokenKind => {
  return context.token.kind
}

export const mergeAuthContext = (
  context: AuthContext,
  updates: Partial<AuthContext>
): AuthContext => ({
  token: updates.token ?? context.token,
  user: updates.user ?? context.user,
})
