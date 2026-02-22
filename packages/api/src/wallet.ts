import { getClient } from './client.js'
import type { WalletInfo, Utxo, Brc20Balance, RuneBalance, AlkanesBalance, FeeEstimates, BroadcastResult, BroadcastBulkResult, InscriptionDetail, BuildConsolidateRequest, BuildConsolidateResponse } from './types.js'

export async function getWallet(address: string): Promise<WalletInfo> {
  const { data } = await getClient().get(`/wallet/${address}`)
  return data
}

export async function getUtxos(address: string): Promise<Utxo[]> {
  const { data } = await getClient().get(`/wallet/${address}/utxos`)
  return data
}

export async function getRuneBalance(address: string): Promise<RuneBalance[]> {
  const { data } = await getClient().get(`/wallet/${address}/rune-balance`)
  return data
}

export async function getBrc20Balance(address: string): Promise<Brc20Balance[]> {
  const { data } = await getClient().get(`/wallet/${address}/brc20-balance`)
  return data
}

export async function getAlkanesBalance(address: string): Promise<AlkanesBalance[]> {
  const { data } = await getClient().get(`/wallet/${address}/alkanes-balance`)
  return data
}

export async function getInscription(id: string): Promise<InscriptionDetail> {
  const { data } = await getClient().get(`/inscription/${id}`)
  return data
}

export async function getFeeEstimates(): Promise<FeeEstimates> {
  const { data } = await getClient().get('/wallet/fee-estimates')
  return data
}

export async function broadcast(rawtx: string): Promise<BroadcastResult> {
  const { data } = await getClient().post('/wallet/broadcast', { rawtx })
  return data
}

export async function buildConsolidate(params: BuildConsolidateRequest): Promise<BuildConsolidateResponse> {
  const { data } = await getClient().post('/wallet/build', params)
  return data
}

export async function broadcastBulk(rawtxs: string[]): Promise<BroadcastBulkResult> {
  const { data } = await getClient().post('/wallet/broadcast-bulk', { rawtxs })
  return data
}
