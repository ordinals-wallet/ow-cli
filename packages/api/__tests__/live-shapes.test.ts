// Shapes captured from live GETs against turbo.ordinalswallet.com (2026-09-26).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import * as feeds from '../src/feeds.js'
import * as market from '../src/market.js'
import * as wallet from '../src/wallet.js'
import * as network from '../src/network.js'
import * as searchApi from '../src/search.js'
import type { FeedPage, FeeEstimates, FeedRow, FungibleAmount } from '../src/index.js'

const BASE = 'https://turbo.ordinalswallet.com'
const live = (name: string) => readFileSync(new URL(`./fixtures/live/${name}`, import.meta.url), 'utf8')
const liveJson = (name: string) => JSON.parse(live(name))

describe('market-wide feed rows (/inscriptions/activity/feed)', () => {
  it('reads item id and parties from either row shape', async () => {
    server.use(http.get(`${BASE}/inscriptions/activity/feed`, () => HttpResponse.json(liveJson('activity-feed.json'))))
    const page: FeedPage = await feeds.getActivityFeed({ limit: 3 })
    const ins = page.rows.find((r) => typeof r.id === 'string')!
    expect(ins.inscription_id).toBeUndefined()
    expect(feeds.rowItemId(ins)).toBe(ins.id)
    expect(feeds.rowSeller(ins)).toBe(ins.escrow?.seller_address)
    expect(feeds.rowBuyer(ins)).toBe(ins.escrow?.buyer_address)
    expect(feeds.rowSeller(ins)).toMatch(/^bc1/)

    const rune = page.rows.find((r) => r.rune_id)!
    expect(feeds.rowItemId(rune)).toBeUndefined()
    expect(typeof rune.amount).toBe('string')

    const alk = page.rows.find((r) => r.alkane_trade)!
    expect(alk.alkane_trade?.asset_id).toBe('2:0')
  })

  it('reads the per-collection shape too', async () => {
    server.use(http.get(`${BASE}/collection/bitcoin-puppets/feed`, () => HttpResponse.json(liveJson('collection-feed.json'))))
    const page = await feeds.getCollectionFeed('bitcoin-puppets', { limit: 1 })
    const row: FeedRow = page.rows[0]
    expect(feeds.rowItemId(row)).toBe(row.inscription_id)
    expect(feeds.rowSeller(row)).toBe(row.seller_address)
    expect(feeds.rowBuyer(row)).toBe(row.buyer_address)
  })
})

describe('market.getListing', () => {
  it('adds a txid:vout form of the serialized outpoint', async () => {
    const body = liveJson('market-escrow.json')
    server.use(http.get(`${BASE}/market/escrow/:id`, () => HttpResponse.json(body)))
    const listing = (await market.getListing(body.inscription_id))!
    expect(listing.outpoint).toBe(body.outpoint) // raw value untouched
    expect(listing.outpoint).toHaveLength(72)
    expect(listing.outpoint_txid_vout).toBe('12cbbfb616cb5bb6a60b86c07c488be17f22bfb90cc123e8dffcb5fbcfdee3a6:0')
    expect(listing.outpoint_sats).toBe(336)
  })

  it('keeps an outpoint that is already txid:vout', async () => {
    const txid = 'ab'.repeat(32)
    server.use(http.get(`${BASE}/market/escrow/:id`, () => HttpResponse.json({ inscription_id: `${txid}i0`, outpoint: `${txid}:3`, seller_address: 'bc1p', satoshi_price: 1 })))
    expect((await market.getListing(`${txid}i0`))!.outpoint_txid_vout).toBe(`${txid}:3`)
  })
})

describe('wallet.getFeeEstimates', () => {
  it('keeps fractional rates and block-target keys', async () => {
    server.use(http.get(`${BASE}/wallet/fee-estimates`, () => HttpResponse.json(liveJson('fee-estimates.json'))))
    const fees: FeeEstimates = await wallet.getFeeEstimates()
    expect(Number.isInteger(fees.fastestFee)).toBe(false)
    expect(fees['1']).toBe(fees.fastestFee)
    expect(typeof fees['3']).toBe('number')
  })
})

describe('network (OW API only)', () => {
  it('getBlockHeight reads GET /blockheight', async () => {
    server.use(http.get(`${BASE}/blockheight`, () => new HttpResponse(live('blockheight.txt'), { headers: { 'content-type': 'application/json' } })))
    expect(await network.getBlockHeight()).toBe(Number(live('blockheight.txt')))
  })

  it('getExchangeRate reads btc.usd from GET /quotes', async () => {
    const q = liveJson('quotes.json')
    server.use(http.get(`${BASE}/quotes`, () => HttpResponse.json(q)))
    expect(await network.getExchangeRate()).toEqual({ price: q.btc.usd, ts: q.btc.ts })
  })
})

describe('search', () => {
  it('uses GET /search/:q', async () => {
    let path = ''
    server.use(
      http.get(`${BASE}/search/:q`, ({ request }) => {
        path = new URL(request.url).pathname
        return HttpResponse.json(liveJson('search.json'))
      }),
    )
    const res = await searchApi.search('puppets', 1)
    expect(path).toBe('/search/puppets')
    expect(res.collections[0].name).toBe(liveJson('search.json').collections[0].name)
  })
})

describe('fungible amounts arrive as string or number', () => {
  const sharedFixture = (name: string) =>
    JSON.parse(readFileSync(new URL(`../../../fixtures/api/${name}`, import.meta.url), 'utf8'))

  it('market-wide feed: decimal strings (fixtures/api/activity.json)', async () => {
    server.use(http.get(`${BASE}/inscriptions/activity/feed`, () => HttpResponse.json(sharedFixture('activity.json'))))
    const page = await feeds.getActivityFeed()
    const amounts: FungibleAmount[] = page.rows.map((r) => r.amount ?? null).filter((a) => a !== null)
    expect(amounts.length).toBeGreaterThan(0)
    for (const a of amounts) expect(typeof a).toBe('string')
    // Alkane rows carry their own numeric lot size.
    const alk = page.rows.find((r) => r.alkane_trade)
    if (alk) expect(typeof alk.alkane_trade!.amount).toBe('number')
  })

  it('per-collection feed: numbers for the same kind of row', async () => {
    server.use(http.get(`${BASE}/collection/:slug/feed`, () => HttpResponse.json(liveJson('rune-collection-feed.json'))))
    const page = await feeds.getCollectionFeed('rune-LIQUIDIUM•TOKEN')
    for (const r of page.rows) expect(typeof r.amount).toBe('number')
    // Both forms are the same type to callers.
    const total = page.rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0)
    expect(total).toBeGreaterThan(0)
  })

  it('escrow price_per and amount are strings (fixtures/api/sold-escrows-rune.json)', () => {
    const rows = sharedFixture('sold-escrows-rune.json') as { amount: string; price_per: string }[]
    for (const r of rows) {
      expect(typeof r.amount).toBe('string')
      expect(typeof r.price_per).toBe('string')
    }
  })
})
