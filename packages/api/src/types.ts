// Wallet types

/**
 * Where an inscription sits, as returned by wallet endpoints. `outpoint` is
 * the 72-hex serialized form; convert it with `outpointToTxidVout()`.
 */
export interface SerializedOutpoint {
  /** 72 hex chars: txid little-endian + vout u32 little-endian. */
  outpoint: string
  /** Offset of the inscribed sat inside the output. */
  sat_offset: number
  /** Value of the output holding the inscription, in sats. */
  sats: number
}

/** Icon inscription reference attached to collections. */
export interface IconInscription {
  id: string
  content_type: string
}

/** Collection summary embedded in inscription and wallet responses. */
export interface InscriptionCollectionRef {
  slug: string
  name: string
  description?: string | null
  creator_address?: string | null
  floor_price?: number | null
  icon?: string | null
  icon_inscription?: IconInscription | null
}

/** Collection summary embedded in token balance rows (runes, BRC-20, alkanes). */
export interface TokenCollectionRef {
  slug: string
  name?: string
  icon?: string | null
  icon_inscription?: IconInscription | null
  floor_price_per?: number | null
}

export interface InscriptionAttribute {
  trait_type: string
  value: string
  percent?: number | null
}

export interface InscriptionMeta {
  name?: string
  attributes?: InscriptionAttribute[]
  rank?: number | null
  [key: string]: unknown
}

/** Listing summary embedded in wallet inscriptions. Has no listing id. */
export interface WalletInscriptionEscrow {
  satoshi_price: number
  seller_address?: string
  buyer_address?: string | null
  purchase_txid?: string | null
  /** `null` or `""` when unsold. */
  bought_at?: string | null
  protected?: boolean
  private_relay?: boolean
  /** @deprecated Not returned by wallet endpoints. */
  id?: string
}

export interface WalletInscription {
  id: string
  num: number
  content_type: string
  meta?: InscriptionMeta | null
  collection?: InscriptionCollectionRef | null
  collection_slugs?: string[]
  escrow?: WalletInscriptionEscrow | null
  /**
   * Location of the inscription. `outpoint.outpoint` is serialized (72 hex),
   * not `txid:vout`: use `outpointToTxidVout()`.
   */
  outpoint?: SerializedOutpoint | null
  /** A sale of this item is in the mempool. */
  pending_sale?: boolean
}

export interface Brc20Balance {
  ticker: string
  overall_balance: string
  available_balance: string
  transferable_balance: string
  collection?: TokenCollectionRef | null
}

/** Balance fields shared by `/wallet/:address` and `/wallet/:address/balance`. All in sats. */
export interface WalletBalance {
  /** Confirmed balance. */
  balance: number
  confirmed_balance: number
  /** Pending in the mempool. */
  unconfirmed_balance: number
  /** Sats sitting in outputs that hold inscriptions. */
  inscription_balance: number
  /** Sats in outputs holding inscriptions or runes. Not safe to spend as plain BTC. */
  frozen_balance: number
  /** Spendable outputs. */
  utxo_count: number
  private_pending_incoming?: number
  private_pending_outgoing?: number
  private_pending_net?: number
}

export interface WalletInfo extends WalletBalance {
  inscriptions: WalletInscription[]
  brc20: Brc20Balance[]
  /** @deprecated Never returned by the API; use the address you requested. */
  address?: string
  /** @deprecated Never returned by the API; use `inscriptions.length`. */
  inscription_count?: number
}

export interface Utxo {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean }
}

export interface Inscription {
  id: string
  number: number
  content_type: string
}

export interface InscriptionDetail {
  id: string
  num: number
  content_type: string
  content_length: number
  effective_content_type?: string
  delegate?: string | null
  /** Unix seconds. */
  created?: number
  genesis_height: number
  genesis_fee: number
  sat: { value: number; rarity: string } | null
  /** Owner at the time of caching. For live ownership use `getInscriptionOutpoint()`. */
  address?: string
  /** Value of the output holding the inscription, in sats. */
  value?: number
  /** `<txid>:<vout>:<offset>`. */
  satpoint?: string
  charms?: string[]
  parents?: string[]
  meta?: InscriptionMeta | null
  collection?: InscriptionCollectionRef | null
  collections?: InscriptionCollectionRef[]
  escrow?: WalletInscriptionEscrow | null
  /** @deprecated Not returned by `/inscription/:id`; use `satpoint` or `getInscriptionOutpoint()`. */
  outpoint?: string
}

/** `GET /inscription/:id/outpoint`: live location and owner of an inscription. */
export interface InscriptionOutpoint {
  inscription: {
    id: string
    sat_offset: number
    /** Serialized (72 hex). Use `outpointToTxidVout()`. */
    outpoint: string
    address: string
    sats: number
  }
  owner: string
  sats: number
  escrow: Partial<Escrow> | null
}

export interface RuneBalance {
  name: string
  rune_id: string
  /** Whole units. */
  amount: string
  symbol: string
  divisibility: number
  collection?: TokenCollectionRef | null
}

/** One row of `GET /wallet/:address/alkanes-balance`. Balances are decimal strings in whole units. */
export interface AlkanesBalance {
  ticker: string
  /** Alkane id, `block:tx`. */
  rune_id: string
  /** Always `"alkanes"` today. */
  type: string
  divisibility: number
  overall_balance: string
  available_balance: string
  transferable_balance: string
  collection?: TokenCollectionRef | null
  /** @deprecated Never returned; use `rune_id`. */
  id?: string
  /** @deprecated Never returned; use `overall_balance`. */
  balance?: string
}

/**
 * One coin holding an alkane or rune, from
 * `GET /wallet/:address/alkanes-outpoints/:id` or `/rune-outpoints/:id`.
 */
export interface TokenOutpoint {
  rune_id: string
  /** `txid:vout`. */
  outpoint: string
  /** Whole units held in this output. */
  amount: string
  address: string
  sats: number
  escrow: Partial<Escrow> | null
}

export interface FeeEstimates {
  fastestFee: number
  halfHourFee: number
  hourFee: number
  economyFee: number
  minimumFee: number
}

export interface BroadcastResult {
  result: string
  id: string
  error?: { code: number; message: string } | null
}

// Collection types
export interface CollectionMetadata {
  id?: string
  slug: string
  name: string
  description: string | null
  icon?: string | null
  icon_inscription?: IconInscription | null
  active?: boolean
  verified?: boolean
  total_supply?: number | null
  socials?: Record<string, string>
  creator_address?: string | null
  gallery_inscription_id?: string | null
  highest_inscription_num?: number | null
  lowest_inscription_num?: number | null
  sponsored_priority?: number
  featured_priority?: number
  /** Fair value in sats. See docs: Fair value. */
  fair_sats?: number | null
  /** 7-day change of fair value, in percent. */
  change_week_fair?: number | null
  /** @deprecated Never returned by the API; use `icon`. */
  image_url?: string
  /** @deprecated Never returned by the API. */
  banner_url?: string
  /** @deprecated Never returned by the API; use `total_supply`. */
  supply?: number
}

/**
 * A listing ("escrow") or, from `/sold-escrows`, a completed sale on
 * Ordinals Wallet.
 */
export interface Escrow {
  id: string
  /** `null` for fungible (rune) sales. */
  inscription_id: string | null
  name?: string | null
  /** `txid:vout` holding the item. */
  outpoint?: string
  /** Asking / sale price in sats. */
  satoshi_price: number
  seller_address?: string
  buyer_address?: string | null
  purchase_txid?: string | null
  /** ISO timestamp (UTC). `null` or `""` when unsold. */
  bought_at?: string | null
  /** ISO timestamp (UTC). */
  created?: string
  creator_address?: string | null
  /** Unit price for fungible assets, decimal string. `""` for single inscriptions. */
  price_per?: string
  /** Quantity for fungible assets, decimal string. `""` for single inscriptions. */
  amount?: string
  /** Listed / settled with snipe protection. */
  protected?: boolean
  /** Purchases are relayed privately to miners (BRC-20, TAP). */
  private_relay?: boolean
  /** `2` for protected listings, otherwise `null`. */
  secure_purchase_version?: number | null
  /** e.g. `"listed"`, `"broadcast"`, `"settled"`. */
  secure_purchase_state?: string | null
  /** Venue id for rune sales from other marketplaces. */
  marketplace?: number
  /** @deprecated Never returned by the API; use `satoshi_price`. */
  price?: number
  /** @deprecated Never returned by the API; use `seller_address`. */
  seller?: string
  /** @deprecated Never returned by the API; use `buyer_address`. */
  buyer?: string
}

export interface CollectionStats {
  id?: string
  total_supply?: number | null
  floor_price: number | null
  floor_price_per?: number | null
  volume_total?: number | null
  volume_day?: number | null
  listed?: number | null
  listed_count?: number | null
  sales?: number | null
  owners?: number | null
  total_volume?: number | null
}

export interface SoldEscrowsParams {
  /** Results per page, max 100. API default 100. */
  limit?: number
  offset?: number
}

// Market types
export interface BuildPurchaseResponse {
  setup: string
  purchase: string
}

export interface BuildPurchaseBulkRequest {
  escrows?: string[]
  inscriptions?: string[]
  pay_address: string
  receive_address: string
  public_key: string
  fee_rate: number
  wallet_type?: string
}

export interface BuildPurchaseRunesRequest {
  outpoints: string[]
  pay_address: string
  receive_address: string
  public_key: string
  fee_rate: number
  wallet_type?: string
}

export interface SubmitPurchaseRequest {
  setup_rawtx: string
  purchase_rawtx: string
  wallet_type?: string
}

export interface SubmitPurchaseResponse {
  success: boolean
  txid?: string
}

export interface SubmitPurchaseRuneRequest {
  rawtx: string
  wallet_type?: string
}

// Passthrough v4 (snipe-protected listings)

/** `GET /market/escrow/:inscription_id`: the live listing, with its protection markers. */
export interface MarketListing {
  inscription_id: string
  /** Either `txid:vout` or the 36-byte wire form in hex, depending on the endpoint. */
  outpoint: string
  seller_address: string
  buyer_address?: string | null
  /** What the buyer pays, marketplace fee included. */
  satoshi_price: number
  escrow_price?: number
  market_royalty?: number | null
  creator_royalty?: number | null
  creator_address?: string | null
  secure_purchase_version?: number | null
  secure_purchase_state?: string | null
  protected?: boolean
}

export interface SecurePurchaseCapabilities {
  version?: number
  mode?: string
  customer_enabled?: boolean
  listing_enabled?: boolean
  build_enabled?: boolean
  submit_enabled?: boolean
  escrow_policy?: string
  policy?: string
  cosigner_public_key?: string
  max_items_per_purchase?: number
  /** Smallest postage a protected listing accepts (330). */
  min_postage_sats?: number
  settlement?: string
  protocols?: string[]
  protocol_status?: Record<string, string>
}

export interface SecurePurchaseCapabilitiesResponse {
  secure_purchase?: SecurePurchaseCapabilities
  error?: boolean
  code?: string
  message?: string
}

export interface BuildSecurePurchaseRequest {
  outpoints: string[]
  protocol: 'ordinal'
  from: string
  public_key: string
  to?: string
  fee_rate: number
  wallet_type?: string
}

export interface SecurePurchaseParent {
  txid: string
  /** The passthrough, witness-stripped (same txid; not broadcastable until submit). */
  raw: string
  source_outpoint: string
}

export interface SecurePurchaseSale {
  sale_txid: string
  chain_index?: number
  psbt: string
  parent: SecurePurchaseParent
  miner_fee_sats?: number
}

export interface BuildSecurePurchaseResponse {
  version: number
  policy: string
  sale_txid: string
  setup?: { txid: string; psbt: string; fee_sats?: number } | null
  /** One single-item sale per outpoint, in order; each after the first spends the previous one. */
  sales: SecurePurchaseSale[]
  economics?: {
    total_price_sats?: number
    ow_fee_sats?: number
    creator_royalty_sats?: number
    miner_fee_sats?: number
    setup_fee_sats?: number
    /** Everything the purchase costs; the SDK refuses to sign a sale that spends more. */
    buyer_total_sats?: number
    fee_rate_sat_vb?: number
    estimated_vbytes?: number
  }
  buyer_address?: string
  recipient_address?: string
  cosigner_public_key?: string
  /** RFC 3339. Past it, the SDK refuses to sign or submit. */
  expires_at?: string
}

export interface SubmitSecurePurchaseLink {
  sale_txid: string
  /** The sale PSBT with ONLY the buyer's inputs signed, unfinalized. */
  psbt: string
  /** The signed setup PSBT; first link only. */
  setup_psbt?: string
}

export interface SubmitSecurePurchaseRequest {
  sales: SubmitSecurePurchaseLink[]
}

export interface SubmitSecurePurchaseResponse {
  accepted: boolean
  txid: string
  state?: string
  parents?: string[]
  sales?: unknown[]
  /** Set when a chain was only partly broadcast. */
  stopped_at?: number
  stopped_code?: string
}

// Passthrough v4 listing (seller side)

export type SecureAssetProtocol = 'ordinal' | 'rune' | 'alkane' | 'tap' | 'brc20'

export interface SecureListingBuildBulkRequest {
  protocol: SecureAssetProtocol
  /** Where the sale pays the seller. */
  seller_address: string
  /** Compressed (33-byte) hex public key of the wallet holding the items. */
  seller_public_key: string
  items: Array<{ outpoint: string; escrow_price_sats: number }>
  /** Correlation only; never authorizes a listing. */
  attempt_id?: string
}

/** A per-item refusal inside a bulk response. */
export interface SecureListingItemError {
  outpoint: string
  error: true
  code: string
  /** On `protocol_mismatch`: the protocol the server proved the item to be. */
  protocol?: string
}

export interface SecureListingBuiltItem {
  version: number
  state: 'authorization_required'
  outpoint: string
  protocol: SecureAssetProtocol
  policy: string
  template_digest: string
  /** Passthrough PSBT: the item into the seller's escrow. */
  psbt: string
  /** Sale template PSBT: the escrow paying the seller. */
  sale_psbt: string
  passthrough_txid: string
  escrow_value: number
  escrow_price_sats: number
  escrow_script: string
  cosigner_public_key: string
  ordinal_offset?: number
  error?: undefined
}

export interface SecureListingBuildBulkResponse {
  version: number
  policy: string
  items: Array<SecureListingBuiltItem | SecureListingItemError>
}

export interface SecureListingAuthorizeItem {
  outpoint: string
  protocol: SecureAssetProtocol
  seller_public_key: string
  template_digest: string
  /** Signed passthrough PSBT. */
  psbt: string
  /** Sale template PSBT carrying the seller's script-path pre-signature. */
  sale_psbt: string
  /** The price the templates were built for (required when repricing a live listing). */
  escrow_price_sats?: number
  attempt_id?: string
}

export interface SecureListingAuthorizedItem {
  version: number
  state: string
  outpoint: string
  protocol: SecureAssetProtocol
  policy: string
  template_digest: string
  passthrough_txid: string
  escrow_value: number
  error?: undefined
}

export interface SecureListingAuthorizeBulkResponse {
  version?: number
  policy?: string
  items: Array<SecureListingAuthorizedItem | SecureListingItemError>
}

/** `GET /market/secure-listing/:outpoint` */
export interface SecureListingStatus {
  version: number
  state: string
  outpoint: string
  protocol: SecureAssetProtocol
  policy: string
  template_digest?: string
}

export interface SecureListingRecoverRequest {
  /** Txid of the confirmed passthrough whose output 0 is the stranded escrow. */
  passthrough_txid: string
  fee_rate: number
  /** Defaults to the listing's payout address. */
  destination?: string
}

export interface SecureListingRecoverResponse {
  version: number
  /** Unsigned recovery PSBT: sign the recovery leaf, broadcast after 144 confirmations. */
  psbt: string
  recovery_txid: string
  escrow_outpoint: string
  escrow_value: number
  value: number
  fee: number
  destination: string
  sequence: number
  spendable_after_confirmations: number
}

export interface BuildEscrowRequest {
  inscription: string
  from: string
  price: number
  public_key: string
  dummy?: boolean
  receive_address?: string
  force_excess_sats?: boolean
  force_multi_inscriptions?: boolean
}

export interface BuildEscrowBulkRequest {
  inscriptions: string[]
  from: string
  prices: number[]
  public_key: string
  receive_address?: string
}

export interface BuildEscrowResponse {
  psbt: string
}

export interface SubmitEscrowRequest {
  psbt: string
}

export interface SubmitEscrowResponse {
  success: boolean
  escrow_id?: string
}

export interface CreateEscrowResponse {
  psbt: string
  escrow_id: string
}

export interface CancelEscrowRequest {
  inscription_id: string
  signature: string
}

// Inscribe types
export interface InscribeEstimateRequest {
  file_size: number
  fee_rate: number
  content_type: string
}

export interface InscribeEstimateResponse {
  total_fees: number
  network_fee?: number
  base_fee?: number
  size_fee?: number
  total_cost?: number
  inscription_fee: number
  postage: number
}

export interface InscribeUploadResponse {
  inscription_id?: string
  txid?: string
  success: boolean
}

// Transfer types
export interface BuildSendRequest {
  from: string
  to: string
  amount: number
  fee_rate: number
  public_key: string
}

export interface BuildInscriptionSendRequest {
  inscription_id?: string
  inscriptions?: string[]
  from: string
  to: string
  fee_rate: number
  public_key: string
  utxos?: [string, number, number][]
  inscription_public_key?: string
  inscription_address?: string
  postage?: number
  consolidate?: boolean
}

export interface BuildRuneTransferRequest {
  from: string
  to: string
  rune: string
  amount: string
  fee_rate: number
  public_key: string
}

// Edict-based rune/alkane transfers
export interface RuneEdict {
  rune_id: string
  amount: string
  divisibility: number
  destination: string
}

export interface RuneOutpoint {
  outpoint: string
  sats: number
}

export interface BuildRuneEdictTransferRequest {
  fee_rate: number
  from: string
  public_key: string
  edicts: RuneEdict[]
  outpoints: RuneOutpoint[]
}

export interface BuildAlkaneTransferRequest {
  fee_rate: number
  from: string
  public_key: string
  edicts: RuneEdict[]
  outpoints: RuneOutpoint[]
}

// UTXO consolidation
export interface BuildConsolidateRequest {
  outputs: [string, number][]
  public_key: string
  from: string
  fee_rate: number
  utxos: [string, number, number][]
}

export interface BuildConsolidateResponse {
  psbt: string
  fees: number
}

// Alkane purchases
export interface BuildPurchaseAlkanesRequest {
  outpoints: string[]
  pay_address: string
  receive_address: string
  public_key: string
  fee_rate: number
  wallet_type?: string
}

// Bulk broadcast
export interface BroadcastBulkResult {
  txids: string[]
}

// Search types
export interface SearchCollection {
  slug: string
  name: string
  icon?: string | null
  description?: string | null
  total_supply?: number | null
  verified?: boolean
  floor_price?: number | null
  floor_price_per?: number | null
  listed?: number | null
  volume_week?: number | null
  global_volume_day?: number | null
  fair_sats?: number | null
  change_week_fair?: number | null
  [key: string]: unknown
}

/**
 * `GET /v2/search/:query`. Free text returns `collections`; an inscription
 * id/number, txid, address or rune id returns `url` (an ordinalswallet.com
 * path). `search()` maps the API's 404 "no match" to `{ collections: [] }`.
 */
export interface SearchResult {
  collections?: SearchCollection[]
  url?: string
  /** @deprecated Never returned by the API. */
  inscriptions?: Inscription[]
  /** @deprecated Never returned by the API. */
  addresses?: string[]
}
