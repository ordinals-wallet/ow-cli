import { apiUrl, clientHeaders, getWithRetry, type RetryOptions } from './http-retry.js'
import { subscribe, type SubscribeOptions, type Unsubscribe } from './stream.js'
import type {
  FeedDelta,
  FeedPage,
  FeedPageParams,
  FeedRow,
  FeedUpdateInfo,
  MempoolSale,
  RecentListing,
  RecentListingsLimit,
} from './types-feeds.js'

function pageQuery(p: FeedPageParams): Record<string, string | number> {
  const q: Record<string, string | number> = {}
  if (p.limit != null) q.limit = p.limit
  if (p.cursor) q.cursor = p.cursor
  return q
}

/**
 * One page of a collection's unified sales tape (pending rows first, then
 * newest). `GET /collection/:slug/feed`. Retries `503 Retry-After` while the
 * feed rebuilds.
 */
export function getCollectionFeed(slug: string, params: FeedPageParams = {}, retry?: RetryOptions): Promise<FeedPage> {
  return getWithRetry(`/collection/${encodeURIComponent(slug)}/feed`, { params: pageQuery(params) }, retry)
}

/** One page of the market-wide sales tape. `GET /inscriptions/activity/feed`. */
export function getActivityFeed(params: FeedPageParams = {}, retry?: RetryOptions): Promise<FeedPage> {
  return getWithRetry('/inscriptions/activity/feed', { params: pageQuery(params) }, retry)
}

/** Every pending sale in the mempool (recomputed every 2s). `GET /mempool/sales`. */
export function getMempoolSales(retry?: RetryOptions): Promise<MempoolSale[]> {
  return getWithRetry('/mempool/sales', {}, retry)
}

/** Newest Ordinals Wallet listings site-wide. `GET /inscriptions/recent-listings`. */
export function getRecentListings(limit: RecentListingsLimit = 25, retry?: RetryOptions): Promise<RecentListing[]> {
  return getWithRetry('/inscriptions/recent-listings', { params: { limit } }, retry)
}

/** Feed ordering: pending first, then newest `ts`, then key for stability. */
export function compareFeedRows(a: FeedRow, b: FeedRow): number {
  const pa = a.status === 'pending' ? 0 : 1
  const pb = b.status === 'pending' ? 0 : 1
  if (pa !== pb) return pa - pb
  if (a.ts !== b.ts) return (b.ts ?? 0) - (a.ts ?? 0)
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export interface FeedStore {
  /** Replace all rows with a snapshot page. */
  applySnapshot(page: Pick<FeedPage, 'rows' | 'version'> & { tip?: number }): FeedRow[]
  /** Apply `added`/`updated`/`removed`. */
  applyDelta(delta: FeedDelta): FeedRow[]
  /** Current rows, sorted. */
  rows(): FeedRow[]
  readonly version: number | null
  readonly tip: number | undefined
}

/**
 * In-memory feed state keyed by row `key`. Keeps at most `maxRows` rows
 * (default 200), dropping the oldest confirmed ones.
 */
export function createFeedStore(opts: { maxRows?: number } = {}): FeedStore {
  const maxRows = opts.maxRows ?? 200
  const map = new Map<string, FeedRow>()
  let version: number | null = null
  let tip: number | undefined
  let sorted: FeedRow[] = []

  const rebuild = () => {
    sorted = [...map.values()].sort(compareFeedRows)
    if (maxRows > 0 && sorted.length > maxRows) {
      for (const r of sorted.slice(maxRows)) map.delete(r.key)
      sorted = sorted.slice(0, maxRows)
    }
    return sorted
  }

  return {
    applySnapshot(page) {
      map.clear()
      for (const r of page.rows ?? []) map.set(r.key, r)
      version = page.version ?? null
      tip = page.tip
      return rebuild()
    },
    applyDelta(d) {
      for (const k of d.removed ?? []) map.delete(typeof k === 'string' ? k : k.key)
      for (const r of d.added ?? []) map.set(r.key, r)
      for (const r of d.updated ?? []) map.set(r.key, { ...map.get(r.key), ...r })
      version = d.version ?? version
      if (d.tip !== undefined) tip = d.tip
      return rebuild()
    },
    rows: () => sorted,
    get version() {
      return version
    },
    get tip() {
      return tip
    },
  }
}

export interface FeedStreamHandlers {
  /** Current sorted rows after each snapshot/delta. */
  onRows: (rows: FeedRow[], info: FeedUpdateInfo) => void
  onError?: (error: unknown, info: { fatal: boolean }) => void
  onOpen?: () => void
}

export interface FeedStreamOptions extends SubscribeOptions {
  /** Max rows retained (default 200). */
  maxRows?: number
}

function streamFeed(path: string, handlers: FeedStreamHandlers, options: FeedStreamOptions = {}): Unsubscribe {
  const { maxRows, ...sub } = options
  const store = createFeedStore({ maxRows })
  return subscribe(
    apiUrl(path),
    {
      onOpen: handlers.onOpen,
      onError: handlers.onError,
      events: {
        snapshot: (data) => {
          const page = JSON.parse(data) as FeedPage
          const rows = store.applySnapshot(page)
          handlers.onRows(rows, { type: 'snapshot', version: store.version, tip: store.tip })
        },
        delta: (data) => {
          const rows = store.applyDelta(JSON.parse(data) as FeedDelta)
          handlers.onRows(rows, { type: 'delta', version: store.version, tip: store.tip })
        },
      },
    },
    { ...sub, headers: { ...clientHeaders(), ...sub.headers } },
  )
}

/**
 * Live sales tape for one collection. Applies `snapshot` then `delta` events
 * and calls `onRows` with the current rows (pending first, then newest).
 * Returns a function that closes the stream.
 */
export function streamCollectionFeed(slug: string, handlers: FeedStreamHandlers, options?: FeedStreamOptions): Unsubscribe {
  return streamFeed(`/collection/${encodeURIComponent(slug)}/feed/stream`, handlers, options)
}

/** Live market-wide sales tape. See `streamCollectionFeed`. */
export function streamActivityFeed(handlers: FeedStreamHandlers, options?: FeedStreamOptions): Unsubscribe {
  return streamFeed('/inscriptions/activity/feed/stream', handlers, options)
}

/** The inscription a feed row sold, from either feed shape (`inscription_id` or `id`). Undefined for rune/alkane rows. */
export function rowItemId(row: FeedRow): string | undefined {
  return row.inscription_id ?? row.id ?? undefined
}

/** Seller address from either feed shape (top level, or under `escrow`). */
export function rowSeller(row: FeedRow): string | undefined {
  return row.seller_address ?? row.escrow?.seller_address ?? undefined
}

/** Buyer address from either feed shape (top level, or under `escrow`). */
export function rowBuyer(row: FeedRow): string | undefined {
  return row.buyer_address ?? row.escrow?.buyer_address ?? undefined
}
