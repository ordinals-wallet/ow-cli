import { getClient } from './client.js'
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
  const { data } = await getClient().post('/wallet/purchase-bulk', params)
  return data
}

export async function buildPurchaseRunes(params: BuildPurchaseRunesRequest): Promise<BuildPurchaseResponse> {
  const { data } = await getClient().post('/wallet/purchase-bulk-runes', params)
  return data
}

export async function buildPurchaseAlkanes(params: BuildPurchaseAlkanesRequest): Promise<{ psbt: string }> {
  const { data } = await getClient().post('/wallet/purchase-bulk-alkanes', params)
  return data
}

export async function submitPurchase(params: SubmitPurchaseRequest): Promise<SubmitPurchaseResponse> {
  const { data } = await getClient().post('/market/purchase', params)
  return data
}

export async function submitPurchaseRune(params: SubmitPurchaseRuneRequest): Promise<SubmitPurchaseResponse> {
  const { data } = await getClient().post('/market/purchase-rune', params)
  return data
}

export async function buildEscrow(params: BuildEscrowRequest): Promise<BuildEscrowResponse> {
  const { data } = await getClient().post('/wallet/escrow', params)
  return data
}

export async function buildEscrowBulk(params: BuildEscrowBulkRequest): Promise<BuildEscrowResponse> {
  const { data } = await getClient().post('/wallet/escrow-bulk', params)
  return data
}

export async function submitEscrow(params: SubmitEscrowRequest): Promise<SubmitEscrowResponse> {
  // Use escrow-bulk endpoint — handles single listings and is more resilient
  // (the non-bulk /market/escrow endpoint hard-fails if ord indexer is behind)
  const { data } = await getClient().post('/market/escrow-bulk', params)
  return data
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
  const { data } = await getClient().post('/market/cancel-escrow', body)
  return data
}

/** The live listing for an inscription, or null when it is not for sale. */
export async function getListing(inscriptionId: string): Promise<MarketListing | null> {
  const res = await getClient().get(`/market/escrow/${encodeURIComponent(inscriptionId)}`, {
    validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
  })
  if (res.status === 404 || !res.data || res.data.error) return null
  return res.data
}

export async function getSecurePurchaseCapabilities(): Promise<SecurePurchaseCapabilities> {
  const { data } = await getClient().get('/market/secure-purchase/capabilities')
  if (!data || data.error || !data.secure_purchase) {
    throw new Error(data?.message || 'Protected purchase capabilities unavailable')
  }
  return data.secure_purchase
}

/** Passthrough v4 build. The legacy `/wallet/purchase-bulk` cannot see protected listings. */
export async function buildSecurePurchase(params: BuildSecurePurchaseRequest): Promise<BuildSecurePurchaseResponse> {
  const { data } = await getClient().post('/wallet/secure-purchase/build', params)
  return data
}

/** Hands back sale PSBTs with only the buyer's inputs signed; the marketplace co-signs and broadcasts. */
export async function submitSecurePurchase(params: SubmitSecurePurchaseRequest): Promise<SubmitSecurePurchaseResponse> {
  const { data } = await getClient().post('/market/secure-purchase/submit', params)
  return data
}
