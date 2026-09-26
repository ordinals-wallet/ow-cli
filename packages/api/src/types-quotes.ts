export interface BtcQuote {
  usd: number
  /** Unix seconds. */
  ts: number
}

/** A collection's live fair line (the chart's smoothed median, not a valuation). */
export interface MarkQuote {
  slug: string
  fair_sats: number
  p10_sats: number
  p90_sats: number
  samples: number
  /** Percent change over the past week. */
  change_week: number | null
  /** Unix seconds. */
  ts: number
}

export interface QuotesSnapshot {
  type: 'snapshot'
  btc: BtcQuote | null
  marks: MarkQuote[]
  ts: number
}
