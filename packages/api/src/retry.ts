import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios'
import { toOwApiError } from './errors.js'

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Per-request retry override. `false` disables retries; `true` enables
     * them even for non-idempotent methods (POST); a number sets the retry
     * count for this request. Default: retry GET/HEAD/OPTIONS only.
     */
    owRetry?: boolean | number
  }
}

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

const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options'])

/** True when a failure is worth retrying: network error, 429 or 5xx. */
export function isRetryableError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  if (axios.isCancel(err) || err.code === 'ERR_CANCELED') return false
  const status = err.response?.status
  if (status === undefined) return true // network error / timeout
  return status === 429 || status >= 500
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

type RetryState = InternalAxiosRequestConfig & { __owRetryCount?: number }

function allowedRetries(cfg: RetryState, opts: RetryOptions): number {
  const override = cfg.owRetry
  if (override === false) return 0
  if (typeof override === 'number') return Math.max(0, override)
  if (override === true) return opts.retries
  return IDEMPOTENT_METHODS.has((cfg.method ?? 'get').toLowerCase()) ? opts.retries : 0
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Installs the response interceptor that retries transient failures and
 * converts every failure into an {@link OwApiError}.
 */
export function installRetryAndErrors(instance: AxiosInstance, opts: RetryOptions): void {
  instance.interceptors.response.use(undefined, async (error: unknown) => {
    const ax = error as AxiosError
    const cfg = ax?.config as RetryState | undefined
    const done = cfg?.__owRetryCount ?? 0

    if (cfg && isRetryableError(error) && done < allowedRetries(cfg, opts)) {
      const delay = computeRetryDelay(done + 1, opts, ax.response?.headers?.['retry-after'])
      if (delay !== undefined) {
        cfg.__owRetryCount = done + 1
        await sleep(delay)
        return instance.request(cfg)
      }
    }
    throw toOwApiError(error, done)
  })
}
