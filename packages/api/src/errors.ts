import axios, { type AxiosError } from 'axios'

/**
 * Error thrown by every @ow-cli/api request that fails.
 *
 * - `status` is the HTTP status, or `0` when no response arrived (network
 *   error, timeout, DNS failure).
 * - `code` is the transport error code for network failures (`ECONNRESET`,
 *   `ECONNABORTED`, `ETIMEDOUT`, ...) or a string `error` field from the body.
 * - `message` is the best human-readable message found in the body. The API
 *   returns `{ error: true, message }`, plain text, `{ error: "..." }`, or an
 *   empty body depending on the endpoint, so branch on `status`, not on
 *   `message`.
 * - `body` is the raw response body (parsed JSON, text, or `undefined`).
 *
 * `response` and `config` mirror the axios shape so code written against
 * `AxiosError` (`err.response.status`, `err.response.data`) keeps working.
 */
export class OwApiError extends Error {
  override readonly name = 'OwApiError'
  readonly status: number
  readonly code?: string
  readonly body: unknown
  readonly method?: string
  readonly url?: string
  /** Number of retries performed before giving up. */
  readonly retries: number
  readonly response?: {
    status: number
    statusText: string
    data: unknown
    headers: Record<string, unknown>
  }
  readonly config?: { url?: string; method?: string; baseURL?: string; data?: unknown }

  constructor(init: {
    status: number
    message: string
    code?: string
    body?: unknown
    method?: string
    url?: string
    retries?: number
    response?: OwApiError['response']
    config?: OwApiError['config']
    cause?: unknown
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.status = init.status
    this.code = init.code
    this.body = init.body
    this.method = init.method
    this.url = init.url
    this.retries = init.retries ?? 0
    this.response = init.response
    this.config = init.config
  }

  /** True for 5xx, 429 and network failures: worth retrying later. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

export function isOwApiError(err: unknown): err is OwApiError {
  return err instanceof OwApiError || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'OwApiError')
}

/** Pulls a readable message out of the API's non-uniform error bodies. */
export function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') {
    const text = body.trim()
    return text.length > 0 ? text.slice(0, 500) : undefined
  }
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim()
    if (typeof rec.error === 'string' && rec.error.trim()) return rec.error.trim()
  }
  return undefined
}

function extractErrorCode(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>
    if (typeof rec.code === 'string') return rec.code
    // `{ error: "some_code" }` without a separate message: the string is both.
    if (typeof rec.error === 'string' && typeof rec.message === 'string') return rec.error
  }
  return undefined
}

/** Converts an axios failure (or anything else) into an OwApiError. */
export function toOwApiError(err: unknown, retries = 0): OwApiError {
  if (isOwApiError(err)) return err
  if (!axios.isAxiosError(err)) {
    const message = err instanceof Error ? err.message : String(err)
    return new OwApiError({ status: 0, message, retries, cause: err })
  }
  const ax = err as AxiosError
  const cfg = ax.config
  const method = cfg?.method?.toUpperCase()
  const url = cfg?.url
  const where = [method, url].filter(Boolean).join(' ')

  if (!ax.response) {
    const code = ax.code ?? 'ERR_NETWORK'
    return new OwApiError({
      status: 0,
      code,
      message: `${ax.message || 'Network error'}${where ? ` (${where})` : ''}`,
      method,
      url,
      retries,
      config: cfg ? { url: cfg.url, method: cfg.method, baseURL: cfg.baseURL, data: cfg.data } : undefined,
      cause: err,
    })
  }

  const { status, statusText, data, headers } = ax.response
  const detail = extractErrorMessage(data)
  const message = detail ?? `HTTP ${status}${statusText ? ` ${statusText}` : ''}${where ? ` (${where})` : ''}`
  return new OwApiError({
    status,
    code: extractErrorCode(data),
    message,
    body: data === '' ? undefined : data,
    method,
    url,
    retries,
    response: { status, statusText, data, headers: { ...(headers as Record<string, unknown>) } },
    config: cfg ? { url: cfg.url, method: cfg.method, baseURL: cfg.baseURL, data: cfg.data } : undefined,
    cause: err,
  })
}
