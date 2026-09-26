import { getClient } from './client.js'
import { isSerializedOutpoint, outpointToTxidVout } from './outpoint.js'
import type {
  BuildPurchaseResponse,
  BuildPurchaseBulkRequest,
  BuildPurchaseRunesRequest,
  BuildPurchaseAlkanesRequest,
  SubmitPurchaseRequest,
  SubmitPurchaseResponse,
  SubmitPurchaseRuneRequest,
  BuildEscrowRequest,
  BuildEscrowBulkRequest,
  BuildEscrowResponse,
  SubmitEscrowRequest,
  SubmitEscrowResponse,
  CancelEscrowRequest,
  CancelEscrowResponse,
  MarketListing,
  SecurePurchaseCapabilities,
  BuildSecurePurchaseRequest,
  BuildSecurePurchaseResponse,
  SubmitSecurePurchaseRequest,
  SubmitSecurePurchaseResponse,
} from './types.js'

export async function buildPurchaseBulk(params: BuildPurchaseBulkRequest): Promise<BuildPurchaseResponse> {
  return getClient().post<BuildPurchaseResponse>('/wallet/purchase-bulk', params)
}

export async function buildPurchaseRunes(params: BuildPurchaseRunesRequest): Promise<BuildPurchaseResponse> {
  return getClient().post<BuildPurchaseResponse>('/wallet/purchase-bulk-runes', params)
}

export async function buildPurchaseAlkanes(params: BuildPurchaseAlkanesRequest): Promise<{ psbt: string }> {
  return getClient().post<{ psbt: string }>('/wallet/purchase-bulk-alkanes', params)
}

export async function submitPurchase(params: SubmitPurchaseRequest): Promise<SubmitPurchaseResponse> {
  return getClient().post<SubmitPurchaseResponse>('/market/purchase', params)
}

export async function submitPurchaseRune(params: SubmitPurchaseRuneRequest): Promise<SubmitPurchaseResponse> {
  return getClient().post<SubmitPurchaseResponse>('/market/purchase-rune', params)
}

export async function buildEscrow(params: BuildEscrowRequest): Promise<BuildEscrowResponse> {
  return getClient().post<BuildEscrowResponse>('/wallet/escrow', params)
}

export async function buildEscrowBulk(params: BuildEscrowBulkRequest): Promise<BuildEscrowResponse> {
  return getClient().post<BuildEscrowResponse>('/wallet/escrow-bulk', params)
}

export async function submitEscrow(params: SubmitEscrowRequest): Promise<SubmitEscrowResponse> {
  // Use escrow-bulk endpoint — handles single listings and is more resilient
  // (the non-bulk /market/escrow endpoint hard-fails if ord indexer is behind)
  return getClient().post<SubmitEscrowResponse>('/market/escrow-bulk', params)
}

/**
 * Cancel a listing with an owner proof. Pass `{ outpoint }` for a protected
 * listing (they are keyed by the outpoint listed from) and `{ inscription_id }`
 * for a standard inscription listing. Not retried: a POST is never repeated
 * behind the caller's back. Most callers want `@ow-cli/shared` `delistListing`.
 */
export async function cancelEscrow(params: CancelEscrowRequest): Promise<CancelEscrowResponse> {
  const hasOutpoint = typeof params.outpoint === 'string' && params.outpoint.length > 0
  const hasInscription = typeof params.inscription_id === 'string' && params.inscription_id.length > 0
  if (hasOutpoint === hasInscription) {
    throw new TypeError('cancelEscrow needs exactly one of outpoint or inscription_id')
  }
  const body = hasOutpoint
    ? { outpoint: params.outpoint, signature: params.signature }
    : { inscription_id: params.inscription_id, signature: params.signature }
  return getClient().post<CancelEscrowResponse>('/market/cancel-escrow', body)
}

/** The live listing for an inscription, or null when it is not for sale. */
export async function getListing(inscriptionId: string): Promise<MarketListing | null> {
  const res = await getClient().request<(MarketListing & { error?: unknown }) | undefined>(
    `/market/escrow/${encodeURIComponent(inscriptionId)}`,
    { acceptStatus: (status) => status === 404 },
  )
  if (res.status === 404 || !res.data || res.data.error) return null
  const listing: MarketListing = { ...res.data }
  const normalized = normalizeOutpoint(listing.outpoint)
  if (normalized) listing.outpoint_txid_vout = normalized
  return listing
}

/** `txid:vout` from either `txid:vout` or the 72-hex serialized form; undefined otherwise. */
function normalizeOutpoint(outpoint: unknown): string | undefined {
  if (typeof outpoint !== 'string') return undefined
  if (/^[0-9a-f]{64}:\d+$/i.test(outpoint)) return outpoint.toLowerCase()
  if (isSerializedOutpoint(outpoint)) return outpointToTxidVout(outpoint)
  return undefined
}

export async function getSecurePurchaseCapabilities(): Promise<SecurePurchaseCapabilities> {
  const data = await getClient().get<{ error?: unknown; message?: string; secure_purchase?: SecurePurchaseCapabilities } | undefined>(
    '/market/secure-purchase/capabilities',
  )
  if (!data || data.error || !data.secure_purchase) {
    throw new Error(data?.message || 'Protected purchase capabilities unavailable')
  }
  return data.secure_purchase
}

/** Passthrough v4 build. The legacy `/wallet/purchase-bulk` cannot see protected listings. */
export async function buildSecurePurchase(params: BuildSecurePurchaseRequest): Promise<BuildSecurePurchaseResponse> {
  return getClient().post<BuildSecurePurchaseResponse>('/wallet/secure-purchase/build', params)
}

/** Hands back sale PSBTs with only the buyer's inputs signed; the marketplace co-signs and broadcasts. */
export async function submitSecurePurchase(params: SubmitSecurePurchaseRequest): Promise<SubmitSecurePurchaseResponse> {
  return getClient().post<SubmitSecurePurchaseResponse>('/market/secure-purchase/submit', params)
}
