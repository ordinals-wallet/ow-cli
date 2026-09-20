// Wallet types

export interface WalletInscription {
  id: string
  num: number
  content_type: string
  meta?: { name?: string; [key: string]: unknown }
  collection?: { slug: string; name: string }
  escrow?: { id: string; satoshi_price: number } | null
  outpoint?: string
}

export interface Brc20Balance {
  ticker: string
  overall_balance: string
  available_balance: string
  transferable_balance: string
  collection?: { slug: string; name: string } | null
}

export interface WalletInfo {
  address: string
  balance: number
  unconfirmed_balance: number
  confirmed_balance: number
  inscription_balance: number
  frozen_balance: number
  inscription_count: number
  utxo_count: number
  inscriptions: WalletInscription[]
  brc20: Brc20Balance[]
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
  genesis_height: number
  genesis_fee: number
  sat: { value: number; rarity: string } | null
  meta?: { name?: string; [key: string]: unknown }
  collection?: { slug: string; name: string } | null
  outpoint?: string
}

export interface RuneBalance {
  name: string
  rune_id: string
  amount: string
  symbol: string
  divisibility: number
  collection?: { slug: string; name: string } | null
}

export interface AlkanesBalance {
  rune_id: string
  id: string
  outpoint: string
  amount: string
  balance: string
  address: string
  sats: number
  escrow?: boolean
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
  slug: string
  name: string
  description: string
  image_url: string
  banner_url: string
  supply: number
  icon?: string
  active?: boolean
  total_supply?: number
  socials?: Record<string, string>
  creator_address?: string
}

export interface Escrow {
  id: string
  inscription_id: string
  name?: string
  outpoint?: string
  seller_address?: string
  buyer_address?: string
  satoshi_price: number
  price: number
  seller?: string
  buyer?: string
  created?: string
  price_per?: number
  amount?: number
}

export interface CollectionStats {
  total_supply?: number | null
  floor_price: number | null
  volume_total?: number | null
  volume_day?: number | null
  listed?: number | null
  listed_count?: number | null
  sales?: number | null
  owners?: number | null
  total_volume?: number | null
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
    buyer_total_sats?: number
  }
  buyer_address?: string
  recipient_address?: string
  cosigner_public_key?: string
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
  icon?: string
}

export interface SearchResult {
  collections: SearchCollection[]
  inscriptions: Inscription[]
  addresses: string[]
}
