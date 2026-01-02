export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const withRetry = async <T>(
  operation: () => Promise<T>,
  options: { retries?: number; backoffMs?: number; onRetry?: (error: unknown, attempt: number) => void } = {}
): Promise<T> => {
  const { retries = 3, backoffMs = 250, onRetry } = options

  let attempt = 0
  // Linear backoff keeps wait times predictable during rapid polling.
  while (true) {
    try {
      return await operation()
    } catch (error) {
      attempt += 1
      if (attempt > retries) throw error
      onRetry?.(error, attempt)
      await sleep(backoffMs * attempt)
    }
  }
}

export const safeJsonParse = <T>(value: string): { ok: true; value: T } | { ok: false; error: Error } => {
  try {
    return { ok: true, value: JSON.parse(value) as T }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export const stableStringify = (value: unknown): string => {
  const replacer = (_key: string, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key]
          return acc
        }, {})
    }
    return val
  }

  return JSON.stringify(value, replacer)
}

export const dedupeBy = <T, K>(items: T[], getKey: (item: T) => K): T[] => {
  const seen = new Set<K>()
  const result: T[] = []

  for (const item of items) {
    const key = getKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }

  return result
}

export const notEmpty = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined

export const toError = (input: unknown): Error => {
  if (input instanceof Error) return input
  if (typeof input === "string") return new Error(input)
  try {
    return new Error(JSON.stringify(input))
  } catch (e) {
    return new Error(String(e))
  }
}

export const elapsedMs = (startedAt: number): number => Date.now() - startedAt
