import { VERSION } from './version.js'
import { OwApiError, httpError, toOwApiError } from './errors.js'
import { DEFAULT_RETRY_OPTIONS, computeRetryDelay, isRetryableError, type RetryOptions } from './retry.js'

const DEFAULT_BASE_URL = 'https://turbo.ordinalswallet.com'
const DEFAULT_TIMEOUT = 30_000

/** Header used to identify SDK/CLI traffic to the Ordinals Wallet API. */
export const CLIENT_HEADER = 'x-ow-client'

/** This SDK's own product token, e.g. `ow-cli/0.1.0`. */
export const SDK_CLIENT_TOKEN = `ow-cli/${VERSION}`

export interface ClientConfig {
  baseUrl?: string
  /** Per-attempt request timeout in ms. Default 30000. */
  timeout?: number
  /**
   * Identifies your application to the API. Sent ahead of the SDK token in
   * the `x-ow-client` header, e.g. `appName: 'my-bot/1.2'` sends
   * `x-ow-client: my-bot/1.2 ow-cli/0.1.0`.
   *
   * Format: one or more space-separated `<name>/<version>` product tokens.
   */
  appName?: string
  /**
   * Retries after the first attempt for idempotent requests (GET/HEAD/OPTIONS)
   * that fail with a network error, timeout, 429 or 5xx. Default 2; `0` disables.
   * POSTs are never retried unless a request opts in with `retry: true`.
   */
  retries?: number
  /** Base backoff in ms, doubled per retry with jitter. Default 300. */
  retryDelay?: number
  /**
   * Longest single wait between retries, in ms. Default 10000. `Retry-After`
   * is honoured up to this bound; a longer one fails fast instead.
   */
  maxDelay?: number
  /** Override `fetch` (tests, proxies, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

/** Query-string values. `undefined` and `null` are left out. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>

export interface RequestOptions {
  /** Appended to the URL as a query string. */
  params?: QueryParams
  /** Extra request headers (merged over the client's). */
  headers?: Record<string, string>
  /** Per-attempt timeout in ms; overrides the client's. */
  timeout?: number
  /**
   * Retry override. `false` disables retries; `true` enables them even for
   * non-idempotent methods (POST); a number sets the retry count for this
   * request. Default: retry GET/HEAD/OPTIONS only.
   */
  retry?: boolean | number
  /**
   * Statuses (besides 2xx) that resolve instead of throwing, e.g.
   * `(s) => s === 404`. Use with `request` to read the status.
   */
  acceptStatus?: (status: number) => boolean
  /** Abort the request (and any pending retry wait). */
  signal?: AbortSignal
}

export interface FullRequestOptions extends RequestOptions {
  method?: string
  /**
   * Request body. Plain objects/arrays are sent as JSON; `FormData`, `Blob`,
   * `URLSearchParams`, `ArrayBuffer`, typed arrays and strings are sent as is.
   */
  body?: unknown
}

export interface OwResponse<T> {
  status: number
  statusText: string
  headers: Headers
  /** Parsed JSON, or the raw text when the body is not JSON, or `undefined` when empty. */
  data: T
}

/** The SDK's HTTP client: `fetch` plus base URL, identification headers, timeouts, retries and typed errors. */
export interface OwClient {
  readonly baseUrl: string
  /** Headers sent with every request (`x-ow-client`, and `User-Agent` in Node). */
  readonly headers: Readonly<Record<string, string>>
  readonly timeout: number
  /** GET `path` and return the parsed body. Throws `OwApiError` on non-2xx. */
  get<T = unknown>(path: string, options?: RequestOptions): Promise<T>
  /** POST `body` (JSON unless it is FormData/Blob/…) to `path` and return the parsed body. Never retried unless `retry: true`. */
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  /** Any method; resolves with status, headers and parsed body. */
  request<T = unknown>(path: string, options?: FullRequestOptions): Promise<OwResponse<T>>
  /** Absolute URL for `path` on this client's base URL, with query params. */
  url(path: string, params?: QueryParams): string
}

/**
 * Builds the `x-ow-client` value: caller tokens first (most specific), then
 * the SDK token. Format is space-separated `<name>/<version>` tokens.
 */
export function buildClientHeader(appName?: string): string {
  const app = appName?.trim().replace(/\s+/g, ' ')
  return app ? `${app} ${SDK_CLIENT_TOKEN}` : SDK_CLIENT_TOKEN
}

function isNode(): boolean {
  return typeof window === 'undefined'
}

/** `key=value&…` for defined params, values URI-encoded. */
export function buildQuery(params: QueryParams = {}): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

/** Joins `base` and `path` (absolute `path` URLs are used as is) and appends the query. */
export function joinUrl(base: string, path: string, params?: QueryParams): string {
  const url = /^https?:\/\//i.test(path) ? path : `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  const qs = buildQuery(params)
  if (!qs) return url
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function allowedRetries(method: string, override: boolean | number | undefined, opts: RetryOptions): number {
  if (override === false) return 0
  if (typeof override === 'number') return Math.max(0, override)
  if (override === true) return opts.retries
  return IDEMPOTENT_METHODS.has(method) ? opts.retries : 0
}

function isRawBody(body: unknown): boolean {
  return (
    typeof body === 'string' ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
  )
}

/** Parses a response body: JSON when it parses, raw text otherwise, `undefined` when empty. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One attempt: fetch with a timeout (and the caller's signal), then read the
 * body. Throws an `OwApiError` with status 0 on transport failure.
 */
async function attempt(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  where: { method: string; url: string },
): Promise<{ res: Response; body: unknown }> {
  const ac = new AbortController()
  let timedOut = false
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true
        ac.abort()
      }, timeoutMs)
    : undefined
  const onAbort = () => ac.abort()
  if (signal?.aborted) ac.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal })
    const body = await readBody(res)
    return { res, body }
  } catch (err) {
    if (timedOut) {
      throw new OwApiError({
        status: 0,
        code: 'ETIMEDOUT',
        message: `timeout of ${timeoutMs}ms exceeded (${where.method} ${where.url})`,
        method: where.method,
        url: where.url,
        cause: err,
      })
    }
    if (signal?.aborted) {
      throw new OwApiError({
        status: 0,
        code: 'ERR_CANCELED',
        message: `Request aborted (${where.method} ${where.url})`,
        method: where.method,
        url: where.url,
        cause: err,
      })
    }
    throw toOwApiError(err, 0, where)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function withRetries(err: OwApiError, retries: number): OwApiError {
  if (err.retries === retries) return err
  return new OwApiError({
    status: err.status,
    statusText: err.statusText,
    code: err.code,
    message: err.message,
    body: err.body,
    headers: err.headers,
    method: err.method,
    url: err.url,
    retries,
    cause: (err as { cause?: unknown }).cause,
  })
}

export function createClient(config?: ClientConfig): OwClient {
  const baseUrl = config?.baseUrl || DEFAULT_BASE_URL
  const timeout = config?.timeout || DEFAULT_TIMEOUT
  const retryOpts: RetryOptions = {
    retries: config?.retries ?? DEFAULT_RETRY_OPTIONS.retries,
    retryDelay: config?.retryDelay ?? DEFAULT_RETRY_OPTIONS.retryDelay,
    maxDelay: config?.maxDelay ?? DEFAULT_RETRY_OPTIONS.maxDelay,
  }
  const headers: Record<string, string> = {
    [CLIENT_HEADER]: buildClientHeader(config?.appName),
  }
  // Browsers forbid setting User-Agent; only set it when running in Node.
  if (isNode()) {
    headers['User-Agent'] = SDK_CLIENT_TOKEN
  }
  Object.freeze(headers)

  async function request<T>(path: string, options: FullRequestOptions = {}): Promise<OwResponse<T>> {
    const fetchImpl = config?.fetch ?? (globalThis.fetch as typeof fetch | undefined)
    if (typeof fetchImpl !== 'function') {
      throw new OwApiError({ status: 0, code: 'ERR_NO_FETCH', message: 'fetch is not available in this runtime (Node 18+ required)' })
    }
    const method = (options.method ?? 'GET').toUpperCase()
    const url = joinUrl(baseUrl, path, options.params)
    const where = { method, url: path }

    const reqHeaders: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      ...headers,
    }
    let body: BodyInit | undefined
    if (options.body !== undefined && options.body !== null) {
      if (isRawBody(options.body)) {
        body = options.body as BodyInit
      } else {
        body = JSON.stringify(options.body)
        reqHeaders['Content-Type'] = 'application/json'
      }
    }
    Object.assign(reqHeaders, options.headers)
    // Let fetch set the multipart boundary itself.
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      for (const k of Object.keys(reqHeaders)) if (k.toLowerCase() === 'content-type') delete reqHeaders[k]
    }

    const maxRetries = allowedRetries(method, options.retry, retryOpts)
    const accept = (s: number) => (s >= 200 && s < 300) || (options.acceptStatus?.(s) ?? false)
    for (let done = 0; ; done++) {
      let failure: OwApiError
      try {
        const { res, body: data } = await attempt(
          fetchImpl,
          url,
          { method, headers: reqHeaders, body },
          options.timeout ?? timeout,
          options.signal,
          where,
        )
        if (accept(res.status)) {
          return { status: res.status, statusText: res.statusText, headers: res.headers, data: data as T }
        }
        failure = httpError({
          status: res.status,
          statusText: res.statusText,
          body: data,
          headers: res.headers,
          method,
          url: path,
        })
      } catch (err) {
        failure = toOwApiError(err, 0, where)
      }

      if (isRetryableError(failure) && done < maxRetries) {
        const delay = computeRetryDelay(done + 1, retryOpts, failure.headers?.get('retry-after') ?? undefined)
        if (delay !== undefined) {
          try {
            await sleep(delay, options.signal)
          } catch (err) {
            throw withRetries(toOwApiError(err, done, where), done)
          }
          continue
        }
      }
      throw withRetries(failure, done)
    }
  }

  return {
    baseUrl,
    headers,
    timeout,
    request,
    async get<T>(path: string, options?: RequestOptions): Promise<T> {
      return (await request<T>(path, { ...options, method: 'GET' })).data
    },
    async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return (await request<T>(path, { ...options, method: 'POST', body })).data
    },
    url(path: string, params?: QueryParams): string {
      return joinUrl(baseUrl, path, params)
    },
  }
}

let defaultClient: OwClient | null = null

export function getClient(): OwClient {
  if (!defaultClient) {
    defaultClient = createClient()
  }
  return defaultClient
}

export function setClient(config: ClientConfig): void {
  defaultClient = createClient(config)
}
