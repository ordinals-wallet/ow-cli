import { CLIENT_HEADER, SDK_CLIENT_TOKEN, getClient, type QueryParams, type RequestOptions } from './client.js'
import { isOwApiError } from './errors.js'
import { parseRetryAfter } from './stream.js'

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number
  /** Ceiling for any single wait. Default 30000ms. */
  maxDelayMs?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * GET that retries 503 and 429 responses, waiting `Retry-After` seconds when
 * the server sends it (e.g. a feed rebuilding answers `503`, `Retry-After: 2`),
 * otherwise backing off exponentially from 1s.
 */
export async function getWithRetry<T>(path: string, options: RequestOptions = {}, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  const maxDelay = opts.maxDelayMs ?? 30000
  for (let attempt = 0; ; attempt++) {
    try {
      // This loop owns retries for these calls; turn off the client-level
      // retry so a 503 is not retried by both layers.
      return await getClient().get<T>(path, { ...options, retry: false })
    } catch (err) {
      const status = isOwApiError(err) ? err.status : undefined
      if ((status !== 503 && status !== 429) || attempt >= maxRetries) throw err
      const wait = parseRetryAfter(isOwApiError(err) ? err.headers?.get('retry-after') : undefined) ?? 1000 * 2 ** attempt
      await sleep(Math.min(wait, maxDelay))
    }
  }
}

/** Absolute URL for `path` on the configured API base, with query params (empty strings dropped). */
export function apiUrl(path: string, params: QueryParams = {}): string {
  const clean: QueryParams = {}
  for (const [k, v] of Object.entries(params)) if (v !== '') clean[k] = v
  return getClient().url(path, clean)
}

/** Identification headers from the configured client, for fetch-based streams. */
export function clientHeaders(): Record<string, string> {
  const h = getClient().headers
  const out: Record<string, string> = {}
  out[CLIENT_HEADER] = h[CLIENT_HEADER] ?? SDK_CLIENT_TOKEN
  if (h['User-Agent']) out['User-Agent'] = h['User-Agent']
  return out
}
