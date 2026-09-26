/** A row of the unified sales tape (OW sales, other marketplaces, and mempool). */
export interface FeedRow {
  /** Stable row ID; use it to deduplicate. */
  key: string
  status: 'pending' | 'confirmed'
  /** `ow` (Ordinals Wallet), `global` (another marketplace) or `mempool`. */
  source: 'ow' | 'global' | 'mempool'
  /** Venue ID. See `sales.MARKETPLACES`. */
  marketplace: number | null
  price_sats: number
  /** Milliseconds. */
  ts: number
  /** When the row was first seen, milliseconds. */
  seen?: number
  txid?: string
  block_height?: number
  inscription_id?: string
  /** Lot size for fungible tokens. */
  amount?: number | null
  seller_address?: string
  buyer_address?: string
  inscriptions_in_tx?: number
  sighash?: number
  signals?: number
  /** Pending rows only. */
  sale?: { kind: 'ask_fill' | 'bid_fill' | string; marketplace_name?: string } | null
  collection?: { slug: string; name?: string | null; icon?: string | null; [k: string]: unknown } | null
  escrow?: { satoshi_price?: number; bought_at?: string; purchase_txid?: string | null; [k: string]: unknown } | null
  alkane_trade?: {
    side: 'buy' | 'sell'
    asset_id: string
    asset_name?: string
    amount: number
    txid: string
    swapper: string | null
    [k: string]: unknown
  }
  [k: string]: unknown
}

export interface FeedPage {
  /** Collection slug, or `@home` for the market-wide feed. */
  scope: string
  version: number
  tip?: number
  built_at?: number
  rows: FeedRow[]
  /** Cursor for the next (older) page. */
  next?: string | null
}

export interface FeedPageParams {
  /** Default 100, max 200. */
  limit?: number
  /** `next` from the previous page. */
  cursor?: string
}

/** `delta` event on a feed stream. `removed` entries are row keys (or rows). */
export interface FeedDelta {
  scope: string
  prev?: number
  version: number
  tip?: number
  added: FeedRow[]
  updated: FeedRow[]
  removed: Array<string | { key: string }>
}

export interface FeedUpdateInfo {
  type: 'snapshot' | 'delta'
  version: number | null
  tip?: number
}

/** A pending sale in the mempool (`GET /mempool/sales`). */
export interface MempoolSale {
  id: string
  num: number | null
  content_type: string | null
  meta: unknown
  collection: { slug: string; name?: string; [k: string]: unknown } | null
  escrow: {
    satoshi_price: number
    seller_address: string | null
    buyer_address: string | null
    bought_at: string
    [k: string]: unknown
  } | null
  amount: number | null
  rune_id: string | null
  mempool: {
    spending_txid: string
    sighash: string
    /** Unix seconds. */
    seen_at: number
    outpoint: string
  }
  marketplace: number | null
  sale: { kind: string; marketplace_name?: string; [k: string]: unknown } | null
  [k: string]: unknown
}

/** A new Ordinals Wallet listing (`GET /inscriptions/recent-listings`). */
export interface RecentListing {
  id: string
  num: number | null
  content_type: string | null
  meta: unknown
  collection: {
    slug: string
    name: string | null
    icon: string | null
    floor_price: number | null
    [k: string]: unknown
  } | null
  escrow: {
    satoshi_price: number
    seller_address: string
    buyer_address: string | null
    protected?: boolean
    [k: string]: unknown
  }
  marketplace: number
  amount: number | null
  rune_id: string | null
  listed_at: string
  [k: string]: unknown
}

export type RecentListingsLimit = 25 | 50 | 100
