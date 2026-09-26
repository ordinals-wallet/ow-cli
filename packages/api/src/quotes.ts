import { apiUrl, clientHeaders, getWithRetry, type RetryOptions } from './http-retry.js'
import { subscribe, type SubscribeOptions, type Unsubscribe } from './stream.js'
import type { BtcQuote, MarkQuote, QuotesSnapshot } from './types-quotes.js'

/** Max collections per quotes request/stream. */
export const QUOTES_LIMIT = 64

/**
 * Live BTC/USD and each collection's fair line. `GET /quotes`. More than 64
 * slugs are split into several requests and merged.
 */
export async function getQuotes(slugs: string[], retry?: RetryOptions): Promise<QuotesSnapshot> {
  const unique = [...new Set(slugs)]
  if (unique.length === 0) {
    return getWithRetry<QuotesSnapshot>('/quotes', {}, retry)
  }
  let merged: QuotesSnapshot | undefined
  for (let i = 0; i < unique.length; i += QUOTES_LIMIT) {
    const chunk = unique.slice(i, i + QUOTES_LIMIT)
    const page = await getWithRetry<QuotesSnapshot>('/quotes', { params: { collections: chunk.join(',') } }, retry)
    if (!merged) merged = { ...page, marks: [...(page.marks ?? [])] }
    else merged.marks.push(...(page.marks ?? []))
  }
  return merged!
}

export interface QuotesStreamHandlers {
  onSnapshot?: (snapshot: QuotesSnapshot) => void
  onBtc?: (btc: BtcQuote) => void
  onMark?: (mark: MarkQuote) => void
  onError?: (error: unknown, info: { fatal: boolean }) => void
  onOpen?: () => void
}

/**
 * Stream BTC/USD and fair-line updates for up to 64 collections
 * (`GET /quotes/stream`). The snapshot is also replayed through
 * `onBtc`/`onMark` so callers can rely on those alone. Returns a close function.
 */
export function streamQuotes(slugs: string[], handlers: QuotesStreamHandlers, options: SubscribeOptions = {}): Unsubscribe {
  const unique = [...new Set(slugs)]
  if (unique.length > QUOTES_LIMIT) {
    throw new RangeError(`streamQuotes accepts at most ${QUOTES_LIMIT} collections (got ${unique.length})`)
  }
  const url = apiUrl('/quotes/stream', { collections: unique.length ? unique.join(',') : undefined })
  return subscribe(
    url,
    {
      onOpen: handlers.onOpen,
      onError: handlers.onError,
      events: {
        snapshot: (data) => {
          const snap = JSON.parse(data) as QuotesSnapshot
          handlers.onSnapshot?.(snap)
          if (snap.btc) handlers.onBtc?.(snap.btc)
          for (const m of snap.marks ?? []) handlers.onMark?.(m)
        },
        btc: (data) => handlers.onBtc?.(JSON.parse(data) as BtcQuote),
        mark: (data) => handlers.onMark?.(JSON.parse(data) as MarkQuote),
      },
    },
    { ...options, headers: { ...clientHeaders(), ...options.headers } },
  )
}
