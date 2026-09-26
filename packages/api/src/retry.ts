import { isOwApiError } from './errors.js'

export interface RetryOptions {
  /** Max retries after the first attempt. Default 2. `0` disables retrying. */
  retries: number
  /** Base backoff in ms, doubled per attempt. Default 300. */
  retryDelay: number
  /**
   * Upper bound for any single wait, in ms. Default 10000. A `Retry-After`
   * longer than this is not waited out: the error is thrown instead.
   */
  maxDelay: number
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  retryDelay: 300,
  maxDelay: 10_000,
}

/** True when a failure is worth retrying: network error or timeout, 429 or 5xx. Caller aborts are not. */
export function isRetryableError(err: unknown): boolean {
  return isOwApiError(err) && err.isTransient
}

/** Parses a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text) * 1000)
  const date = Date.parse(text)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

/**
 * Delay before retry number `attempt` (1-based). Honours `Retry-After` when
 * present; otherwise exponential backoff with "equal jitter" (half fixed,
 * half random) capped at `maxDelay`. Returns `undefined` when the server asks
 * for a longer wait than `maxDelay`, meaning: do not retry.
 */
export function computeRetryDelay(
  attempt: number,
  opts: Pick<RetryOptions, 'retryDelay' | 'maxDelay'>,
  retryAfter?: unknown,
  random: () => number = Math.random,
): number | undefined {
  const serverDelay = parseRetryAfter(retryAfter)
  if (serverDelay !== undefined) {
    return serverDelay <= opts.maxDelay ? serverDelay : undefined
  }
  const exp = Math.min(opts.maxDelay, opts.retryDelay * 2 ** (attempt - 1))
  return Math.round(exp / 2 + random() * (exp / 2))
}
