import { getClient } from './client.js'
import type { BuildSendRequest, BuildInscriptionSendRequest, BuildRuneTransferRequest, BuildRuneEdictTransferRequest, BuildAlkaneTransferRequest } from './types.js'

export async function buildSend(params: BuildSendRequest): Promise<{ psbt: string }> {
  return getClient().post<{ psbt: string }>('/wallet/send', params)
}

export async function buildInscriptionSend(params: BuildInscriptionSendRequest): Promise<{ psbt: string }> {
  return getClient().post<{ psbt: string }>('/wallet/inscription/send', params)
}

export async function buildRuneTransfer(params: BuildRuneTransferRequest): Promise<{ psbt: string }> {
  return getClient().post<{ psbt: string }>('/rune/transfer', params)
}

export async function buildRuneEdictTransfer(params: BuildRuneEdictTransferRequest): Promise<{ psbt: string }> {
  return getClient().post<{ psbt: string }>('/rune/transfer', params)
}

export async function buildAlkaneTransfer(params: BuildAlkaneTransferRequest): Promise<{ psbt: string }> {
  return getClient().post<{ psbt: string }>('/alkane/transfer', params)
}
