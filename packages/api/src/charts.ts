import { getClient } from './client.js'
import type { Ohlcv, OhlcvParams, Valuation } from './types-charts.js'

/** Max slugs per `POST /collections/valuation` request. */
export const VALUATION_BATCH_LIMIT = 200

/**
 * Candles and the fair-value band for a collection, rune or token.
 * `GET /collection/:slug/ohlcv` (cached 60s, up to 5,000 buckets).
 */
export async function getOhlcv(slug: string, params: OhlcvParams = {}): Promise<Ohlcv> {
  const { data } = await getClient().get(`/collection/${encodeURIComponent(slug)}/ohlcv`, {
    params: compact({ ...params }),
  })
  return data
}

/** Fair value, range, confidence and inputs. `GET /collection/:slug/valuation`. */
export async function getValuation(slug: string): Promise<Valuation> {
  const { data } = await getClient().get(`/collection/${encodeURIComponent(slug)}/valuation`)
  return data
}

/**
 * Fair value for many collections. Batches into requests of 200 slugs
 * (`POST /collections/valuation`) and merges. Unknown slugs are left out.
 */
export async function getValuations(slugs: string[]): Promise<Valuation[]> {
  const unique = [...new Set(slugs)]
  const out: Valuation[] = []
  for (let i = 0; i < unique.length; i += VALUATION_BATCH_LIMIT) {
    const chunk = unique.slice(i, i + VALUATION_BATCH_LIMIT)
    const { data } = await getClient().post('/collections/valuation', { slugs: chunk })
    out.push(...((data?.valuations ?? []) as Valuation[]))
  }
  return out
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v
  }
  return out
}
