import { getClient } from './client.js'
import type { BuildSendRequest, BuildInscriptionSendRequest, BuildRuneTransferRequest } from './types.js'

export async function buildSend(params: BuildSendRequest): Promise<{ psbt: string }> {
  const { data } = await getClient().post('/wallet/send', params)
  return data
}

export async function buildInscriptionSend(params: BuildInscriptionSendRequest): Promise<{ psbt: string }> {
  const { data } = await getClient().post('/wallet/inscription/send', params)
  return data
}

export async function buildRuneTransfer(params: BuildRuneTransferRequest): Promise<{ psbt: string }> {
  const { data } = await getClient().post('/rune/transfer', params)
  return data
}
