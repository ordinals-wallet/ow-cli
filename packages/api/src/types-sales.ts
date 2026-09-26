/** A sale detected on-chain by the global sales tape. */
export interface GlobalSale {
  block_height: number
  /** Unix seconds. */
  block_timestamp: number
  txid: string
  inscription_id: string
  sequence_number?: number
  /** Items in the same transaction. A sweep of 5 items is 5 rows. */
  inscriptions_in_tx: number
  /** Venue ID. See `MARKETPLACES`. */
  marketplace: number
  /** Seller's signature type (129 = ALL|ANYONECANPAY). */
  sighash: number
  signals?: number
  seller_address: string
  buyer_address: string
  /** What the buyer paid for the lot. */
  price_sats: number
  old_satpoint: string
  new_satpoint: string
}

export interface SalesPage {
  sales: GlobalSale[]
  has_more: boolean
  matched_inscriptions: number
}

export interface SalesParams {
  /** Page size, default 100, max 1,000. */
  limit?: number
  /** Cursor (exclusive): the last `block_height` of the previous page. */
  beforeHeight?: number
}

export interface WalletSale extends GlobalSale {
  /** Whether the wallet bought or sold. */
  role: 'buyer' | 'seller'
}

export interface WalletSalesPage {
  address: string
  sales: WalletSale[]
  has_more: boolean
}

export interface VolumeTotals {
  /** Transactions. */
  count: number
  volume_sats: number
  count_with_price?: number
  /** Items. */
  count_items: number
  item_volume_sats: number
}

export interface VolumeBucket {
  /** `YYYY-MM-DD` (UTC). */
  date: string
  block_height_first: number
  block_height_last: number
  /** Keyed by marketplace ID (as a string). */
  by_marketplace: Record<string, VolumeTotals>
  total: VolumeTotals
}

export interface SalesVolume {
  from_height: number
  to_height: number
  buckets: VolumeBucket[]
}

export interface SalesVolumeParams {
  fromHeight?: number
  toHeight?: number
}
