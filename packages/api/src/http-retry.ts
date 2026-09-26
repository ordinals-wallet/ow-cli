import type { AxiosRequestConfig } from 'axios'
import { CLIENT_HEADER, SDK_CLIENT_TOKEN, getClient } from './client.js'
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
export async function getWithRetry<T>(path: string, config: AxiosRequestConfig = {}, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  const maxDelay = opts.maxDelayMs ?? 30000
  for (let attempt = 0; ; attempt++) {
    try {
      // This loop owns retries for these calls; turn off the client-level
      // retry so a 503 is not retried by both layers.
      const { data } = await getClient().get(path, { ...config, owRetry: false })
      return data as T
    } catch (err) {
      const res = (err as { response?: { status: number; headers?: Record<string, unknown> } }).response
      const status = res?.status
      if ((status !== 503 && status !== 429) || attempt >= maxRetries) throw err
      const header = res?.headers?.['retry-after']
      const wait = parseRetryAfter(header == null ? undefined : String(header)) ?? 1000 * 2 ** attempt
      await sleep(Math.min(wait, maxDelay))
    }
  }
}

/** Absolute URL for `path` on the configured API base, with query params. */
export function apiUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
  const base = String(getClient().defaults.baseURL ?? '').replace(/\/+$/, '')
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${base}${path}${qs ? `?${qs}` : ''}`
}

/** Identification headers from the configured client, for fetch-based streams. */
export function clientHeaders(): Record<string, string> {
  const h = getClient().defaults.headers as unknown as Record<string, unknown>
  const out: Record<string, string> = {}
  const client = h[CLIENT_HEADER]
  out[CLIENT_HEADER] = typeof client === 'string' ? client : SDK_CLIENT_TOKEN
  if (typeof h['User-Agent'] === 'string') out['User-Agent'] = h['User-Agent'] as string
  return out
}
