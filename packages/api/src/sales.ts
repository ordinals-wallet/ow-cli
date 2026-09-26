import { getClient } from './client.js'
import type {
  GlobalSale,
  SalesPage,
  SalesParams,
  SalesVolume,
  SalesVolumeParams,
  WalletSale,
  WalletSalesPage,
} from './types-sales.js'

/** Global sales tape venue IDs. */
export const MARKETPLACES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Unknown',
  1: 'Ordinals Wallet',
  2: 'Satflow',
  3: 'Magic Eden',
  4: 'OrdSwap',
  5: 'Gamma',
  6: 'OrdinalsMarket',
  7: 'OpenOrdex',
  8: 'OKX',
  9: 'UniSat',
  10: 'ord.net',
  11: 'Ord Dropz',
  12: 'DotSwap',
})

/** Venue name for a marketplace ID (`Unknown` for unmapped IDs). */
export function marketplaceName(id: number | null | undefined): string {
  return (id != null && MARKETPLACES[id]) || MARKETPLACES[0]
}

function pageParams(p: SalesParams): Record<string, number> {
  const out: Record<string, number> = {}
  if (p.limit != null) out.limit = p.limit
  if (p.beforeHeight != null) out.before_height = p.beforeHeight
  return out
}

/** Every on-chain sale of a collection, newest first. `GET /collection/:slug/sales`. */
export async function getSales(slug: string, params: SalesParams = {}): Promise<SalesPage> {
  const { data } = await getClient().get(`/collection/${encodeURIComponent(slug)}/sales`, {
    params: pageParams(params),
  })
  return data
}

/** Daily volume by marketplace. `GET /collection/:slug/sales-volume`. */
export async function getSalesVolume(slug: string, params: SalesVolumeParams = {}): Promise<SalesVolume> {
  const q: Record<string, number> = {}
  if (params.fromHeight != null) q.from_height = params.fromHeight
  if (params.toHeight != null) q.to_height = params.toHeight
  const { data } = await getClient().get(`/collection/${encodeURIComponent(slug)}/sales-volume`, { params: q })
  return data
}

/** Sales a wallet bought or sold, across marketplaces. `GET /wallet/:address/global-sales`. */
export async function getWalletSales(address: string, params: SalesParams = {}): Promise<WalletSalesPage> {
  const { data } = await getClient().get(`/wallet/${encodeURIComponent(address)}/global-sales`, {
    params: pageParams(params),
  })
  return data
}

async function* paginate<T extends { block_height: number }>(
  fetchPage: (p: SalesParams) => Promise<{ sales: T[]; has_more: boolean }>,
  params: SalesParams,
): AsyncGenerator<T, void, undefined> {
  let before = params.beforeHeight
  for (;;) {
    const page = await fetchPage({ limit: params.limit, beforeHeight: before })
    for (const s of page.sales) yield s
    if (!page.has_more || page.sales.length === 0) return
    const last = page.sales[page.sales.length - 1].block_height
    // Guard against a cursor that fails to move backwards.
    if (before != null && last >= before) return
    before = last
  }
}

/**
 * Iterate every sale of a collection, newest first, paging with
 * `before_height` until `has_more` is false.
 */
export function iterateSales(slug: string, params: SalesParams = {}): AsyncGenerator<GlobalSale, void, undefined> {
  return paginate((p) => getSales(slug, p), params)
}

/** Iterate every sale a wallet was part of, newest first. */
export function iterateWalletSales(
  address: string,
  params: SalesParams = {},
): AsyncGenerator<WalletSale, void, undefined> {
  return paginate((p) => getWalletSales(address, p), params)
}
