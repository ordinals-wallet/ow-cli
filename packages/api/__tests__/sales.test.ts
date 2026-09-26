import { describe, it, expect, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { setClient } from '../src/client.js'
import * as sales from '../src/sales.js'
import { fixture } from './market-fixtures.js'

const BASE = 'https://turbo.ordinalswallet.com'
beforeAll(() => setClient({ baseUrl: BASE }))

describe('sales', () => {
  it('MARKETPLACES maps venue ids', () => {
    expect(sales.MARKETPLACES[2]).toBe('Satflow')
    expect(sales.MARKETPLACES[10]).toBe('ord.net')
    expect(Object.keys(sales.MARKETPLACES).length).toBe(13)
    expect(sales.marketplaceName(12)).toBe('DotSwap')
    expect(sales.marketplaceName(999)).toBe('Unknown')
  })

  it('getSales maps beforeHeight to before_height', async () => {
    let url: URL | undefined
    server.use(
      http.get(`${BASE}/collection/:slug/sales`, ({ request }) => {
        url = new URL(request.url)
        return HttpResponse.json(fixture('sales.json'))
      }),
    )
    const page = await sales.getSales('bitcoin-puppets', { limit: 2, beforeHeight: 968700 })
    expect(url?.searchParams.get('limit')).toBe('2')
    expect(url?.searchParams.get('before_height')).toBe('968700')
    expect(page.has_more).toBe(true)
    expect(page.sales[0].marketplace).toBe(2)
    expect(page.sales[0].price_sats).toBeGreaterThan(0)
    expect(page.sales[0].new_satpoint).toContain(page.sales[0].txid)
  })

  it('getSalesVolume maps the block range', async () => {
    let url: URL | undefined
    server.use(
      http.get(`${BASE}/collection/:slug/sales-volume`, ({ request }) => {
        url = new URL(request.url)
        return HttpResponse.json(fixture('sales_volume.json'))
      }),
    )
    const v = await sales.getSalesVolume('bitcoin-puppets', { fromHeight: 960000, toHeight: 968710 })
    expect(url?.searchParams.get('from_height')).toBe('960000')
    expect(url?.searchParams.get('to_height')).toBe('968710')
    const withVenue = v.buckets.find((b) => Object.keys(b.by_marketplace).length > 0)!
    expect(withVenue.total.count_items).toBeGreaterThanOrEqual(withVenue.total.count)
    expect(v.buckets[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('getWalletSales hits /wallet/:a/global-sales', async () => {
    server.use(http.get(`${BASE}/wallet/:address/global-sales`, () => HttpResponse.json(fixture('wallet_sales.json'))))
    const page = await sales.getWalletSales('bc1qxysukuzgp0g8ccexmapnhlhal5pyzffqrx49kjs7zcjgwqxlw8lqw8ey8l', { limit: 2 })
    expect(page.sales[0].role).toBe('buyer')
    expect(page.has_more).toBe(false)
  })

  it('iterateSales pages with before_height until has_more=false', async () => {
    const template = fixture('sales.json').sales[0]
    const heights = [100, 99, 99, 98, 97, 90, 80]
    const seen: (string | null)[] = []
    server.use(
      http.get(`${BASE}/collection/:slug/sales`, ({ request }) => {
        const u = new URL(request.url)
        const before = u.searchParams.get('before_height')
        seen.push(before)
        const limit = Number(u.searchParams.get('limit'))
        const rest = heights.filter((h) => before == null || h < Number(before))
        const page = rest.slice(0, limit)
        return HttpResponse.json({
          sales: page.map((h, i) => ({ ...template, block_height: h, txid: `${h}-${i}` })),
          has_more: rest.length > limit,
          matched_inscriptions: 1,
        })
      }),
    )
    const got: number[] = []
    for await (const s of sales.iterateSales('x', { limit: 3 })) got.push(s.block_height)
    expect(seen).toEqual([null, '99', '90'])
    expect(got).toEqual([100, 99, 99, 98, 97, 90, 80])
  })

  it('iterateSales stops if the cursor does not move', async () => {
    const template = fixture('sales.json').sales[0]
    let calls = 0
    server.use(
      http.get(`${BASE}/collection/:slug/sales`, () => {
        calls++
        return HttpResponse.json({ sales: [{ ...template, block_height: 50 }], has_more: true, matched_inscriptions: 1 })
      }),
    )
    const got = []
    for await (const s of sales.iterateSales('x', { beforeHeight: 50 })) got.push(s)
    expect(calls).toBe(1)
    expect(got.length).toBe(1)
  })
})
