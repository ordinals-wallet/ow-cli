import type { FungibleAmount } from './types-feeds.js'

/** Candle bucket size for `/collection/:slug/ohlcv`. */
export type OhlcvInterval = '5m' | '15m' | '1h' | '4h' | '12h' | '1d' | '1w'
/** Price denomination: sats, USD, or market cap (USD × supply). */
export type OhlcvDenom = 'sats' | 'usd' | 'mcap'
/** `mark` = fair-value trace, `trades` = raw sale OHLC. */
export type OhlcvSeries = 'mark' | 'trades'

export interface OhlcvParams {
  interval?: OhlcvInterval
  denom?: OhlcvDenom
  series?: OhlcvSeries
  /** Unix seconds. Defaults to ~300 buckets back. */
  start?: number
  /** Unix seconds. Page back with `end` for deeper history. */
  end?: number
  /** Override the supply used for `mcap`. */
  supply?: number
}

export interface OhlcvCandle {
  /** Bucket start, unix seconds. */
  time: number
  open: number
  high: number
  low: number
  close: number
  median: number
  volume: number
  trades: number
  /** No sales in this bucket; in usd/mcap it still moves with BTC. Don't draw volume. */
  synthetic: boolean
}

export interface OhlcvTrendPoint {
  time: number
  p10: number
  p50: number
  p90: number
  fair: number
  samples: number
}

export interface OhlcvPrint {
  /** Unix seconds. */
  time: number
  /** Price in the requested denomination. */
  price: number
  price_sats: number
  inscription: string | null
  /** Lot size for fungible tokens, otherwise null (string or number, see `FungibleAmount`). */
  amount: FungibleAmount
}

export interface Ohlcv {
  slug: string
  interval: OhlcvInterval
  denom: OhlcvDenom
  series: OhlcvSeries
  candles: OhlcvCandle[]
  trend: OhlcvTrendPoint[]
  /** Sales kept in the candles. */
  prints: OhlcvPrint[]
  /** Sales filtered out as outliers. */
  outliers: OhlcvPrint[]
  /** BTC price used for usd/mcap, else null. */
  btc_usd: number | null
  /** Supply used for mcap, else null. */
  supply: number | null
  supply_source?: string | null
  invariants?: { violations: unknown[] }
}

export type ValuationMethod =
  | 'book-and-tape'
  | 'book-midpoint'
  | 'discounted-floor'
  | 'bid-only'
  | 'tape-only'
  | 'unpriced'

/** `global` = sales across marketplaces; `ordinals_wallet` = fallback. */
export type TapeSource = 'global' | 'ordinals_wallet'

export interface ValuationInputs {
  best_bid_sats: number | null
  floor_sats: number | null
  tape_sats: number | null
  bid_depth: number
  trades_7d: number
  trades_30d: number
  median_7d_sats: number | null
  median_30d_sats: number | null
  last_sale_sats: number | null
  /** Unix seconds. */
  last_sale_ts: number | null
}

export interface Valuation {
  slug: string
  fair_sats: number | null
  fair_usd: number | null
  low_sats: number | null
  low_usd: number | null
  high_sats: number | null
  high_usd: number | null
  /** 0 to 1. */
  confidence: number
  method: ValuationMethod
  tape_source: TapeSource
  inputs: ValuationInputs
  supply: number | null
  marketcap_sats: number | null
  marketcap_usd: number | null
}
