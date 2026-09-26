import { getClient } from './client.js'
import type { CollectionMetadata, Escrow, CollectionStats, SoldEscrowsParams } from './types.js'

export async function getMetadata(slug: string): Promise<CollectionMetadata> {
  return getClient().get<CollectionMetadata>(`/collection/${slug}`)
}

export async function getEscrows(slug: string): Promise<Escrow[]> {
  return getClient().get<Escrow[]>(`/collection/${slug}/escrows`)
}

/**
 * Ordinals Wallet sales, most recent first. Accepts `{ limit, offset }`
 * (limit max 100) or, for backward compatibility, a bare limit.
 */
export async function getSoldEscrows(slug: string, params: SoldEscrowsParams | number = {}): Promise<Escrow[]> {
  const { limit = 20, offset } = typeof params === 'number' ? { limit: params } : params
  return getClient().get<Escrow[]>(`/collection/${slug}/sold-escrows`, {
    params: offset === undefined ? { limit } : { limit, offset },
  })
}

export async function getStats(slug: string): Promise<CollectionStats> {
  return getClient().get<CollectionStats>(`/collection/${slug}/stats`)
}
