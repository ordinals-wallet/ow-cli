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
  txid: string
  success: boolean
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
