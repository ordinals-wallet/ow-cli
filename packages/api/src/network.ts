import { getClient } from './client.js'
import type { QuotesSnapshot } from './types-quotes.js'

export interface ExchangeRate {
  /** BTC/USD. */
  price: number
  /** Unix seconds of the price, when the API sent it. */
  ts?: number
}

/** Current chain tip height. `GET /blockheight`. */
export async function getBlockHeight(): Promise<number> {
  const height = Number(await getClient().get('/blockheight'))
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error('Unexpected /blockheight response')
  return height
}

/** BTC/USD from the quotes feed. `GET /quotes` (`btc.usd`). */
export async function getExchangeRate(): Promise<ExchangeRate> {
  const snap = await getClient().get<QuotesSnapshot>('/quotes')
  const btc = snap?.btc
  if (!btc || typeof btc.usd !== 'number' || !Number.isFinite(btc.usd)) throw new Error('BTC/USD unavailable from /quotes')
  return btc.ts !== undefined ? { price: btc.usd, ts: btc.ts } : { price: btc.usd }
}
