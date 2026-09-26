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
  return getClient().get<WalletInfo>(`/wallet/${address}`)
}

/** Balance fields only (no holdings). Cached ~30s server side. */
export async function getBalance(address: string): Promise<WalletBalance> {
  return getClient().get<WalletBalance>(`/wallet/${address}/balance`)
}

/** Every inscription the address holds (same list as `getWallet().inscriptions`). */
export async function getWalletInscriptions(address: string): Promise<WalletInscription[]> {
  return getClient().get<WalletInscription[]>(`/wallet/${address}/inscriptions`)
}

export async function getUtxos(address: string): Promise<Utxo[]> {
  return getClient().get<Utxo[]>(`/wallet/${address}/utxos`)
}

export async function getRuneBalance(address: string): Promise<RuneBalance[]> {
  return getClient().get<RuneBalance[]>(`/wallet/${address}/rune-balance`)
}

/** Coins holding a rune. `runeId` is `block:tx`. */
export async function getRuneOutpoints(address: string, runeId: string): Promise<TokenOutpoint[]> {
  return getClient().get<TokenOutpoint[]>(`/wallet/${address}/rune-outpoints/${runeId}`)
}

export async function getBrc20Balance(address: string): Promise<Brc20Balance[]> {
  return getClient().get<Brc20Balance[]>(`/wallet/${address}/brc20-balance`)
}

/**
 * Alkanes balances. The first request for a cold wallet may return `[]`
 * while it is indexed; an empty result does not prove a zero balance.
 */
export async function getAlkanesBalance(address: string): Promise<AlkanesBalance[]> {
  return getClient().get<AlkanesBalance[]>(`/wallet/${address}/alkanes-balance`)
}

/** Coins holding an alkane. `alkaneId` is `block:tx` (e.g. `2:0`). */
export async function getAlkanesOutpoints(address: string, alkaneId: string): Promise<TokenOutpoint[]> {
  return getClient().get<TokenOutpoint[]>(`/wallet/${address}/alkanes-outpoints/${alkaneId}`)
}

export async function getInscription(id: string): Promise<InscriptionDetail> {
  return getClient().get<InscriptionDetail>(`/inscription/${id}`)
}

/**
 * Live location and owner of an inscription. Prefer this over
 * `getInscription()` (cached up to 24h) for ownership checks.
 */
export async function getInscriptionOutpoint(id: string): Promise<InscriptionOutpoint> {
  return getClient().get<InscriptionOutpoint>(`/inscription/${id}/outpoint`)
}

export async function getFeeEstimates(): Promise<FeeEstimates> {
  return getClient().get<FeeEstimates>('/wallet/fee-estimates')
}

export async function broadcast(rawtx: string): Promise<BroadcastResult> {
  return getClient().post<BroadcastResult>('/wallet/broadcast', { rawtx })
}

export async function buildConsolidate(params: BuildConsolidateRequest): Promise<BuildConsolidateResponse> {
  return getClient().post<BuildConsolidateResponse>('/wallet/build', params)
}

export async function broadcastBulk(rawtxs: string[]): Promise<BroadcastBulkResult> {
  return getClient().post<BroadcastBulkResult>('/wallet/broadcast-bulk', { rawtxs })
}
