/**
 * A fungible lot size (runes, BRC-20, alkanes). Arrives as a decimal string
 * or a number depending on the endpoint; `null` for inscriptions.
 */
export type FungibleAmount = string | number | null

/** Seller/buyer/price block. The market-wide feed nests the parties here. */
export interface FeedRowEscrow {
  satoshi_price?: number
  seller_address?: string | null
  buyer_address?: string | null
  /** e.g. `2026-09-26 17:23:37+00:00`. */
  bought_at?: string
  purchase_txid?: string | null
  /** Snipe-protected (passthrough v4) listing. */
  protected?: boolean
  private_relay?: boolean
  [k: string]: unknown
}

/**
 * A row of the unified sales tape (OW sales, other marketplaces, and mempool).
 *
 * Two shapes share this type:
 * - per-collection feed (`/collection/:slug/feed`): the item is
 *   `inscription_id`; `seller_address` / `buyer_address` are top level.
 * - market-wide feed (`/inscriptions/activity/feed`): the item is `id`
 *   (null for rune/alkane rows), with `num`, `content_type`, `meta`,
 *   `collection`, and the parties nested under `escrow`.
 *
 * Use `feeds.rowItemId`, `feeds.rowSeller` and `feeds.rowBuyer` to read
 * either shape.
 */
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
  /** Per-collection feed: the inscription sold. */
  inscription_id?: string
  /** Market-wide feed: the inscription sold (null for rune/alkane rows). */
  id?: string | null
  /** Market-wide feed: inscription number. */
  num?: number | null
  /** Market-wide feed. */
  content_type?: string | null
  /** Market-wide feed: item metadata (name, attributes, ...). */
  meta?: Record<string, unknown> | null
  /** Rune rows: `block:tx`. */
  rune_id?: string | null
  /**
   * Lot size for fungible tokens, otherwise null. The API is not consistent
   * about the type: the market-wide feed sends a decimal string (`"13.9"`),
   * the per-collection feed a number (`13.9`). Large rune amounts exceed
   * float precision, so parse the string form with care.
   */
  amount?: FungibleAmount
  /** Per-collection feed. On the market-wide feed see `escrow.seller_address`. */
  seller_address?: string | null
  /** Per-collection feed. On the market-wide feed see `escrow.buyer_address`. */
  buyer_address?: string | null
  /** Pending alkane rows: how `price_sats` was estimated (e.g. `min_out`). */
  estimate?: string
  inscriptions_in_tx?: number
  sighash?: number
  signals?: number
  /** Pending rows only. */
  sale?: { kind: 'ask_fill' | 'bid_fill' | string; marketplace_name?: string } | null
  collection?: { slug: string; name?: string | null; icon?: string | null; [k: string]: unknown } | null
  escrow?: FeedRowEscrow | null
  alkane_trade?: {
    side: 'buy' | 'sell' | 'swap' | (string & {})
    asset_id: string
    asset_name?: string
    amount: number
    txid: string
    swapper: string | null
    hops?: number
    /** Swaps: the asset given in exchange. */
    paid_with?: { asset_id: string; asset_name?: string; amount: number; [k: string]: unknown } | null
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
  /** Lot size for fungible tokens (string or number, see `FungibleAmount`). */
  amount: FungibleAmount
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
  /** Lot size for rune listings, a decimal string (e.g. `"889806"`); null for inscriptions. */
  amount: FungibleAmount
  rune_id: string | null
  listed_at: string
  [k: string]: unknown
}

export type RecentListingsLimit = 25 | 50 | 100
