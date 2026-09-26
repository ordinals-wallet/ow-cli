/**
 * Error thrown by every @ow-cli/api request that fails.
 *
 * - `status` is the HTTP status, or `0` when no response arrived (network
 *   error, timeout, DNS failure, abort).
 * - `code` is the transport error code for network failures (`ECONNRESET`,
 *   `ETIMEDOUT`, `ERR_CANCELED`, `ERR_NETWORK`, ...) or a string code from
 *   the body (`{ code }`, or `{ error: "<code>", message }`).
 * - `message` is the best human-readable message found in the body. The API
 *   returns `{ error: true, message }`, plain text, `{ error: "..." }`, or an
 *   empty body depending on the endpoint, so branch on `status`, not on
 *   `message`.
 * - `body` is the raw response body (parsed JSON, text, or `undefined`).
 * - `headers` are the response headers, when a response arrived.
 */
export class OwApiError extends Error {
  override readonly name = 'OwApiError'
  readonly status: number
  readonly statusText?: string
  readonly code?: string
  readonly body: unknown
  readonly headers?: Headers
  readonly method?: string
  readonly url?: string
  /** Number of retries performed before giving up. */
  readonly retries: number

  constructor(init: {
    status: number
    message: string
    statusText?: string
    code?: string
    body?: unknown
    headers?: Headers
    method?: string
    url?: string
    retries?: number
    cause?: unknown
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.status = init.status
    this.statusText = init.statusText
    this.code = init.code
    this.body = init.body
    this.headers = init.headers
    this.method = init.method
    this.url = init.url
    this.retries = init.retries ?? 0
  }

  /** True for 5xx, 429 and network failures: worth retrying later. */
  get isTransient(): boolean {
    return (this.status === 0 && this.code !== 'ERR_CANCELED') || this.status === 429 || this.status >= 500
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

/** A string code from an error body: `{ code }`, or `{ error: "<code>", message }`. */
export function extractErrorCode(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null) {
    const rec = body as Record<string, unknown>
    if (typeof rec.code === 'string') return rec.code
    // `{ error: "some_code" }` without a separate message: the string is both.
    if (typeof rec.error === 'string' && typeof rec.message === 'string') return rec.error
  }
  return undefined
}

/** Builds the error for a response whose status was not accepted. */
export function httpError(init: {
  status: number
  statusText?: string
  body: unknown
  headers?: Headers
  method?: string
  url?: string
  retries?: number
}): OwApiError {
  const { status, statusText, body, method, url } = init
  const where = [method, url].filter(Boolean).join(' ')
  const message =
    extractErrorMessage(body) ?? `HTTP ${status}${statusText ? ` ${statusText}` : ''}${where ? ` (${where})` : ''}`
  return new OwApiError({
    status,
    statusText,
    code: extractErrorCode(body),
    message,
    body: body === '' ? undefined : body,
    headers: init.headers,
    method,
    url,
    retries: init.retries,
  })
}

/** Converts anything thrown during a request into an OwApiError (status 0 unless it already is one). */
export function toOwApiError(err: unknown, retries = 0, where?: { method?: string; url?: string }): OwApiError {
  if (isOwApiError(err)) return err
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: unknown; message?: string } } | undefined
  const method = where?.method
  const url = where?.url
  const at = [method, url].filter(Boolean).join(' ')
  let code: string | undefined
  let message: string
  if (e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT') {
    code = 'ETIMEDOUT'
    message = e?.message || 'Request timed out'
  } else if (e?.name === 'AbortError' || e?.code === 'ERR_CANCELED') {
    code = 'ERR_CANCELED'
    message = 'Request aborted'
  } else {
    // undici puts the socket error (ECONNRESET, ENOTFOUND, ...) on `cause`.
    code = typeof e?.cause?.code === 'string' ? e.cause.code : typeof e?.code === 'string' ? e.code : 'ERR_NETWORK'
    const detail = e?.cause?.message && e.cause.message !== e.message ? `: ${e.cause.message}` : ''
    message = `${e?.message || String(err) || 'Network error'}${detail}`
  }
  return new OwApiError({
    status: 0,
    code,
    message: `${message}${at ? ` (${at})` : ''}`,
    method,
    url,
    retries,
    cause: err,
  })
}
