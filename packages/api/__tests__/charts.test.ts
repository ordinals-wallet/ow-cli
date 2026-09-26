import { describe, it, expect, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { setClient } from '../src/client.js'
import * as charts from '../src/charts.js'
import { fixture } from './market-fixtures.js'

const BASE = 'https://turbo.ordinalswallet.com'
beforeAll(() => setClient({ baseUrl: BASE }))

describe('charts.getOhlcv', () => {
  it('passes params through and returns typed candles/trend', async () => {
    let url: URL | undefined
    server.use(
      http.get(`${BASE}/collection/:slug/ohlcv`, ({ request }) => {
        url = new URL(request.url)
        return HttpResponse.json(fixture('ohlcv.json'))
      }),
    )
    const res = await charts.getOhlcv('bitcoin-puppets', { interval: '1d', start: 1789948800, series: undefined })
    expect(url?.pathname).toBe('/collection/bitcoin-puppets/ohlcv')
    expect(url?.searchParams.get('interval')).toBe('1d')
    expect(url?.searchParams.get('start')).toBe('1789948800')
    expect(url?.searchParams.has('series')).toBe(false)
    expect(res.series).toBe('mark')
    expect(res.candles.length).toBe(3)
    const c = res.candles[0]
    for (const k of ['time', 'open', 'high', 'low', 'close', 'median', 'volume', 'trades'] as const) {
      expect(typeof c[k]).toBe('number')
    }
    expect(typeof c.synthetic).toBe('boolean')
    expect(res.trend[0]).toHaveProperty('fair')
    expect(res.trend[0]).toHaveProperty('samples')
    expect(res.prints[0].price_sats).toBeGreaterThan(0)
    expect(res.btc_usd).toBeNull()
  })

  it('usd denomination carries btc_usd', async () => {
    server.use(http.get(`${BASE}/collection/:slug/ohlcv`, () => HttpResponse.json(fixture('ohlcv_usd.json'))))
    const res = await charts.getOhlcv('bitcoin-puppets', { denom: 'usd' })
    expect(res.denom).toBe('usd')
    expect(res.btc_usd).toBeGreaterThan(1000)
  })
})

describe('charts valuation', () => {
  it('getValuation returns method, tape_source and inputs', async () => {
    server.use(http.get(`${BASE}/collection/:slug/valuation`, () => HttpResponse.json(fixture('valuation.json'))))
    const v = await charts.getValuation('bitcoin-puppets')
    expect(['book-and-tape', 'book-midpoint', 'discounted-floor', 'bid-only', 'tape-only', 'unpriced']).toContain(v.method)
    expect(v.tape_source).toBe('global')
    expect(v.inputs.trades_30d).toBeGreaterThan(0)
    expect(v.low_sats!).toBeLessThanOrEqual(v.fair_sats!)
    expect(v.high_sats!).toBeGreaterThanOrEqual(v.fair_sats!)
  })

  it('getValuations chunks into 200-slug requests and merges', async () => {
    const live = fixture<{ valuations: any[] }>('valuations.json').valuations
    const bodies: string[][] = []
    server.use(
      http.post(`${BASE}/collections/valuation`, async ({ request }) => {
        const { slugs } = (await request.json()) as { slugs: string[] }
        bodies.push(slugs)
        // echo one real valuation per slug that looks "known"
        return HttpResponse.json({
          valuations: slugs.filter((s) => !s.startsWith('unknown')).map((slug, i) => ({ ...live[i % live.length], slug })),
        })
      }),
    )
    const slugs = [
      ...Array.from({ length: 449 }, (_, i) => `c-${i}`),
      'c-0', // duplicate is dropped
      'unknown-slug',
    ]
    const res = await charts.getValuations(slugs)
    expect(bodies.map((b) => b.length)).toEqual([200, 200, 50])
    expect(res.length).toBe(449)
    expect(res[0].slug).toBe('c-0')
    expect(res.at(-1)!.slug).toBe('c-448')
  })

  it('getValuations passes the real response through', async () => {
    server.use(http.post(`${BASE}/collections/valuation`, () => HttpResponse.json(fixture('valuations.json'))))
    const res = await charts.getValuations(['bitcoin-puppets', 'nodemonkes', 'not-a-real-slug-xyz'])
    expect(res.map((v) => v.slug)).toEqual(['bitcoin-puppets', 'nodemonkes'])
  })

  it('getValuations([]) makes no request', async () => {
    expect(await charts.getValuations([])).toEqual([])
  })
})
