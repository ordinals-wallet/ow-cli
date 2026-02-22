import { getClient } from './client.js'
import type { CollectionMetadata, Escrow, CollectionStats } from './types.js'

export async function getMetadata(slug: string): Promise<CollectionMetadata> {
  const { data } = await getClient().get(`/collection/${slug}`)
  return data
}

export async function getEscrows(slug: string): Promise<Escrow[]> {
  const { data } = await getClient().get(`/collection/${slug}/escrows`)
  return data
}

export async function getSoldEscrows(slug: string, limit = 20): Promise<Escrow[]> {
  const { data } = await getClient().get(`/collection/${slug}/sold-escrows`, {
    params: { limit },
  })
  return data
}

export async function getStats(slug: string): Promise<CollectionStats> {
  const { data } = await getClient().get(`/collection/${slug}/stats`)
  return data
}
