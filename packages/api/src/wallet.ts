import { getClient } from './client.js'
import type { WalletInfo, Utxo, Inscription, RuneBalance, AlkanesBalance, FeeEstimates, BroadcastResult } from './types.js'

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

export async function getBrc20Balance(address: string): Promise<any[]> {
  const { data } = await getClient().get(`/wallet/${address}/brc20-balance`)
  return data
}

export async function getAlkanesBalance(address: string): Promise<AlkanesBalance[]> {
  const { data } = await getClient().get(`/wallet/${address}/alkanes-balance`)
  return data
}

export async function getInscription(id: string): Promise<any> {
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
