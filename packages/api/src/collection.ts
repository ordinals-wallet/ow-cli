import { getClient } from './client.js'
import type { CollectionMetadata, Escrow, CollectionStats, SoldEscrowsParams } from './types.js'

export async function getMetadata(slug: string): Promise<CollectionMetadata> {
  const { data } = await getClient().get(`/collection/${slug}`)
  return data
}

export async function getEscrows(slug: string): Promise<Escrow[]> {
  const { data } = await getClient().get(`/collection/${slug}/escrows`)
  return data
}

/**
 * Ordinals Wallet sales, most recent first. Accepts `{ limit, offset }`
 * (limit max 100) or, for backward compatibility, a bare limit.
 */
export async function getSoldEscrows(slug: string, params: SoldEscrowsParams | number = {}): Promise<Escrow[]> {
  const { limit = 20, offset } = typeof params === 'number' ? { limit: params } : params
  const { data } = await getClient().get(`/collection/${slug}/sold-escrows`, {
    params: offset === undefined ? { limit } : { limit, offset },
  })
  return data
}

export async function getStats(slug: string): Promise<CollectionStats> {
  const { data } = await getClient().get(`/collection/${slug}/stats`)
  return data
}
