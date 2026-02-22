import { getClient } from './client.js'
import type { SearchResult } from './types.js'

export async function search(input: string): Promise<SearchResult> {
  const { data } = await getClient().get(`/v2/search/${encodeURIComponent(input)}`, {
    params: { limit: 16 },
  })
  return data
}
