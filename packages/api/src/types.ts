// Wallet types
export interface WalletInfo {
  address: string
  balance: number
  inscription_count: number
  [key: string]: any
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
  [key: string]: any
}

export interface RuneBalance {
  rune: string
  balance: string
  symbol: string
  [key: string]: any
}

export interface AlkanesBalance {
  id: string
  balance: string
  [key: string]: any
}

export interface FeeEstimates {
  fastest: number
  halfHour: number
  hour: number
  economy: number
  minimum: number
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
  [key: string]: any
}

export interface Escrow {
  id: string
  inscription_id: string
  price: number
  seller: string
  [key: string]: any
}

export interface CollectionStats {
  floor_price: number
  total_volume: number
  listed_count: number
  [key: string]: any
}

// Market types
export interface BuildPurchaseRequest {
  inscription_id: string
  pay_address: string
  receive_address: string
  public_key: string
  fee_rate: number
  wallet_type?: string
}

export interface BuildPurchaseResponse {
  setup: string
  purchase: string
}

export interface BuildPurchaseBulkRequest {
  escrows: string[]
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
  inscription_fee: number
  postage: number
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
  utxos?: any[]
}

export interface BuildRuneTransferRequest {
  from: string
  to: string
  rune: string
  amount: string
  fee_rate: number
  public_key: string
}

// Search types
export interface SearchResult {
  collections: any[]
  inscriptions: any[]
  addresses: any[]
}
