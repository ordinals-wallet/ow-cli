import { getClient } from './client.js'
import { isOwApiError } from './errors.js'
import type { SearchResult } from './types.js'

/**
 * Search collections, or resolve an inscription id/number, txid, address or
 * rune id to an ordinalswallet.com path (`url`). No match returns
 * `{ collections: [] }` (the API answers 404).
 */
export async function search(input: string, limit = 16): Promise<SearchResult> {
  try {
    return await getClient().get<SearchResult>(`/search/${encodeURIComponent(input)}`, {
      params: { limit },
    })
  } catch (err) {
    if (isOwApiError(err) && err.status === 404) return { collections: [] }
    throw err
  }
}
