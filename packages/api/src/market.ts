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

export async function cancelEscrow(params: CancelEscrowRequest): Promise<SubmitEscrowResponse> {
  const { data } = await getClient().post('/market/cancel-escrow', params)
  return data
}
