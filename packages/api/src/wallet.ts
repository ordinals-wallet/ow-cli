import { getClient } from './client.js'
import type {
  WalletInfo,
  WalletBalance,
  WalletInscription,
  Utxo,
  Brc20Balance,
  RuneBalance,
  AlkanesBalance,
  TokenOutpoint,
  FeeEstimates,
  BroadcastResult,
  BroadcastBulkResult,
  InscriptionDetail,
  InscriptionOutpoint,
  BuildConsolidateRequest,
  BuildConsolidateResponse,
} from './types.js'

export async function getWallet(address: string): Promise<WalletInfo> {
  const { data } = await getClient().get(`/wallet/${address}`)
  return data
}

/** Balance fields only (no holdings). Cached ~30s server side. */
export async function getBalance(address: string): Promise<WalletBalance> {
  const { data } = await getClient().get(`/wallet/${address}/balance`)
  return data
}

/** Every inscription the address holds (same list as `getWallet().inscriptions`). */
export async function getWalletInscriptions(address: string): Promise<WalletInscription[]> {
  const { data } = await getClient().get(`/wallet/${address}/inscriptions`)
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

/** Coins holding a rune. `runeId` is `block:tx`. */
export async function getRuneOutpoints(address: string, runeId: string): Promise<TokenOutpoint[]> {
  const { data } = await getClient().get(`/wallet/${address}/rune-outpoints/${runeId}`)
  return data
}

export async function getBrc20Balance(address: string): Promise<Brc20Balance[]> {
  const { data } = await getClient().get(`/wallet/${address}/brc20-balance`)
  return data
}

/**
 * Alkanes balances. The first request for a cold wallet may return `[]`
 * while it is indexed; an empty result does not prove a zero balance.
 */
export async function getAlkanesBalance(address: string): Promise<AlkanesBalance[]> {
  const { data } = await getClient().get(`/wallet/${address}/alkanes-balance`)
  return data
}

/** Coins holding an alkane. `alkaneId` is `block:tx` (e.g. `2:0`). */
export async function getAlkanesOutpoints(address: string, alkaneId: string): Promise<TokenOutpoint[]> {
  const { data } = await getClient().get(`/wallet/${address}/alkanes-outpoints/${alkaneId}`)
  return data
}

export async function getInscription(id: string): Promise<InscriptionDetail> {
  const { data } = await getClient().get(`/inscription/${id}`)
  return data
}

/**
 * Live location and owner of an inscription. Prefer this over
 * `getInscription()` (cached up to 24h) for ownership checks.
 */
export async function getInscriptionOutpoint(id: string): Promise<InscriptionOutpoint> {
  const { data } = await getClient().get(`/inscription/${id}/outpoint`)
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
