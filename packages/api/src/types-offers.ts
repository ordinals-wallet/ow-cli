/** Offers v1 shapes (`/market/offers`). Amounts are sats. */

export type OfferScope = 'item' | 'collection' | 'trait'

export type OfferState =
  | 'building'
  | 'active'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'cancelled'

export interface Offer {
  id: string
  scope: OfferScope
  /** Target item (item offers); null for collection/trait offers. */
  inscription_id: string | null
  /** `txid:vout` of the item when the offer was made (item offers). */
  item_outpoint: string | null
  item_value: number
  /** Empty for collection/trait offers until filled. */
  seller_address: string
  /** Where the item is delivered. */
  buyer_address: string
  /** Where refunds and change go. */
  buyer_payment_address: string
  collection_slug: string | null
  trait_type: string | null
  trait_value: string | null
  /** What the seller receives. */
  price_sats: number
  /** 2.7%, minimum 1,000, paid by the buyer. */
  market_fee_sats: number
  /** Prepaid network fee for the sale. */
  network_fee_sats: number
  escrow_value: number
  /** `price_sats + market_fee_sats`. */
  total_sats: number
  state: OfferState
  message: string | null
  funding_txid: string | null
  funding_vout: number | null
  accepted_txid: string | null
  cancel_txid: string | null
  /** For collection/trait offers: the item that filled it. */
  filled_inscription_id: string | null
  recovery_delay_blocks: number
  expires_at: string
  created_at: string
  updated_at: string
}

export interface InscriptionOffersResponse {
  /** Item offers on this inscription. */
  offers: Offer[]
  /** Collection and trait offers this inscription could fill. */
  collection_offers: Offer[]
}

export interface CollectionOffersSummary {
  count: number
  item_count: number
  collection_count: number
  trait_count: number
  top_price_sats: number
  top_collection_sats: number
  total_sats: number
}

export interface CollectionOffersResponse {
  slug: string
  summary: CollectionOffersSummary
  offers: Offer[]
  collection_offers: Offer[]
  trait_offers: Offer[]
}

export interface WalletOffersResponse {
  received: Offer[]
  sent: Offer[]
}

export interface BuildOfferRequest {
  /** `item` (default), `collection` or `trait`. */
  scope?: OfferScope
  /** Required for item offers. */
  inscription_id?: string
  /** Required for collection and trait offers. */
  collection_slug?: string
  trait_type?: string
  trait_value?: string
  /** Where the item is delivered; pubkey is 33-byte compressed hex. */
  buyer_address: string
  buyer_public_key: string
  /** What funds the offer; pubkey is 33-byte compressed hex. */
  buyer_payment_address: string
  buyer_payment_public_key: string
  /** Minimum 10,000. */
  price_sats: number
  /** 1–500 sat/vB, prepaid for the sale. */
  fee_rate: number
  /** 1–30, default 7. */
  validity_days?: number
  /** Optional public note, up to 500 characters. */
  message?: string
}

export interface BuildOfferResponse {
  version: number
  offer_id: string
  scope: OfferScope
  /** Hex PSBT moving `escrow_value` into the offer escrow. Sign normally. */
  funding_psbt: string
  /** Present when the funding txid is already final (native segwit/taproot inputs). */
  batch_accept: { accept_psbt: string; sign_input_index: number } | null
  escrow_address: string | null
  escrow_value: number
  price_sats: number
  market_fee_sats: number
  network_fee_sats: number
  validity_days: number
  recovery_delay_blocks: number
  expires_at: string
}

/** 0x01 = SIGHASH_ALL (item offers), 0x82 = NONE|ANYONECANPAY (collection/trait). */
export type OfferPresignSighash = 0x01 | 0x82

export interface PrepareOfferResponse {
  offer_id: string
  scope: OfferScope
  funding_txid: string
  /** Hex PSBT; pre-sign only the escrow leaf input at `sign_input_index`. */
  accept_psbt: string
  sign_input_index: number
  tapscript: boolean
  sighash: number
}

export interface ActivateOfferRequest {
  funding_psbt: string
  accept_psbt: string
}

export interface ActivateOfferResponse {
  offer: Offer
  funding_txid: string
}

export interface BuildAcceptRequest {
  seller_address: string
  seller_public_key?: string
}

export interface BuildAcceptResponse {
  offer: Offer
  accept_psbt: string
  sign_input_index: number
  tapscript: boolean
  sighash: number
}

export interface AcceptOfferRequest {
  seller_address: string
  signed_psbt: string
}

export interface SettleOfferResponse {
  offer_id: string
  txid: string
  state: OfferState
  inscription_id?: string
}

export interface BuildFillRequest {
  seller_address: string
  seller_public_key?: string
  inscription_id: string
}

export interface BuildFillResponse {
  offer: Offer
  inscription_id: string
  fill_psbt: string
  sign_input_index: number
  tapscript: boolean
  sighash: number
  miner_fee_sats: number
}

export interface FillOfferRequest {
  seller_address: string
  inscription_id: string
  signed_psbt: string
}

export interface RejectOfferRequest {
  /** The seller's address. */
  address: string
  /** A session token from wallet sign-in (`auth.signIn` / `SessionManager`). */
  token: string
}

export interface RejectOfferResponse {
  offer_id: string
  state: OfferState
}

export interface BuildCancelRequest {
  buyer_address: string
  /** Default 2, clamped to 1–500. */
  fee_rate?: number
}

export interface BuildCancelResponse {
  offer_id: string
  cancel_psbt: string
  sign_input_index: number
  tapscript: boolean
  sighash: number
  fee_rate: number
}

export interface CancelOfferRequest {
  buyer_address: string
  signed_psbt: string
}

export interface ReconcileOfferResponse {
  offer: Offer
}
