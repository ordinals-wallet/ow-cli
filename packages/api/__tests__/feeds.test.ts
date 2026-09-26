import { describe, it, expect, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { setClient, CLIENT_HEADER } from '../src/client.js'
import * as feeds from '../src/feeds.js'
import * as quotes from '../src/quotes.js'
import { createSseParser } from '../src/stream.js'
import type { FeedRow } from '../src/types-feeds.js'
import { fixture, sseFixture, textStream } from './market-fixtures.js'

const BASE = 'https://turbo.ordinalswallet.com'
beforeAll(() => setClient({ baseUrl: BASE, appName: 'feed-test/1' }))

describe('feed pages', () => {
  it('getCollectionFeed passes limit/cursor', async () => {
    let url: URL | undefined
    server.use(
      http.get(`${BASE}/collection/:slug/feed`, ({ request }) => {
        url = new URL(request.url)
        return HttpResponse.json(fixture('feed.json'))
      }),
    )
    const page = await feeds.getCollectionFeed('bitcoin-puppets', { limit: 3, cursor: '2~abc' })
    expect(url?.searchParams.get('limit')).toBe('3')
    expect(url?.searchParams.get('cursor')).toBe('2~abc')
    expect(page.scope).toBe('bitcoin-puppets')
    expect(page.next).toBeTruthy()
    expect(page.rows[0].key).toMatch(/^tx:/)
  })

  it('retries a 503 with Retry-After', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE}/inscriptions/activity/feed`, () => {
        calls++
        if (calls === 1) return new HttpResponse('rebuilding', { status: 503, headers: { 'Retry-After': '0' } })
        return HttpResponse.json(fixture('activity.json'))
      }),
    )
    const page = await feeds.getActivityFeed({ limit: 3 })
    expect(calls).toBe(2)
    expect(page.scope).toBe('@home')
  })

  it('gives up after maxRetries', async () => {
    let calls = 0
    server.use(
      http.get(`${BASE}/inscriptions/activity/feed`, () => {
        calls++
        return new HttpResponse('rebuilding', { status: 503, headers: { 'Retry-After': '0' } })
      }),
    )
    await expect(feeds.getActivityFeed({}, { maxRetries: 2 })).rejects.toMatchObject({ response: { status: 503 } })
    expect(calls).toBe(3)
  })

  it('getMempoolSales and getRecentListings', async () => {
    let limit: string | null = null
    server.use(
      http.get(`${BASE}/mempool/sales`, () => HttpResponse.json(fixture('mempool_sales.json'))),
      http.get(`${BASE}/inscriptions/recent-listings`, ({ request }) => {
        limit = new URL(request.url).searchParams.get('limit')
        return HttpResponse.json(fixture('recent_listings.json'))
      }),
    )
    const mem = await feeds.getMempoolSales()
    expect(mem[0].mempool.spending_txid).toHaveLength(64)
    const recent = await feeds.getRecentListings(50)
    expect(limit).toBe('50')
    expect(recent[0].listed_at).toBeTruthy()
    expect(recent[0].escrow.satoshi_price).toBeGreaterThan(0)
  })
})

describe('createFeedStore', () => {
  const row = (key: string, ts: number, status: 'pending' | 'confirmed' = 'confirmed'): FeedRow =>
    ({ key, ts, status, source: status === 'pending' ? 'mempool' : 'global', marketplace: 2, price_sats: 1 }) as FeedRow

  it('applies snapshot then delta, sorted pending-first then newest', () => {
    const s = feeds.createFeedStore()
    s.applySnapshot({ version: 1, rows: [row('a', 10), row('b', 30), row('c', 20)] })
    expect(s.rows().map((r) => r.key)).toEqual(['b', 'c', 'a'])
    const rows = s.applyDelta({
      scope: 'x',
      prev: 1,
      version: 2,
      added: [row('p', 5, 'pending'), row('d', 40)],
      updated: [{ ...row('c', 20), price_sats: 99 }],
      removed: ['b', { key: 'a' }],
    })
    expect(rows.map((r) => r.key)).toEqual(['p', 'd', 'c'])
    expect(rows.find((r) => r.key === 'c')!.price_sats).toBe(99)
    expect(s.version).toBe(2)
    // a pending row confirming is an update
    const r2 = s.applyDelta({ scope: 'x', version: 3, added: [], updated: [row('p', 50)], removed: [] })
    expect(r2.map((r) => r.key)).toEqual(['p', 'd', 'c'])
    expect(r2[0].status).toBe('confirmed')
    // fresh snapshot replaces everything
    expect(s.applySnapshot({ version: 9, rows: [row('z', 1)] }).map((r) => r.key)).toEqual(['z'])
  })

  it('caps rows at maxRows, dropping the oldest', () => {
    const s = feeds.createFeedStore({ maxRows: 2 })
    s.applySnapshot({ version: 1, rows: [row('a', 1), row('b', 2), row('c', 3)] })
    expect(s.rows().map((r) => r.key)).toEqual(['c', 'b'])
  })
})

describe('streamActivityFeed (live capture over msw)', () => {
  it('replays snapshot + deltas into sorted rows and sends x-ow-client', async () => {
    const text = sseFixture('activity_stream.sse')
    let header: string | null = null
    server.use(
      http.get(`${BASE}/inscriptions/activity/feed/stream`, ({ request }) => {
        header = request.headers.get(CLIENT_HEADER)
        return new HttpResponse(textStream(text, [512]), { headers: { 'content-type': 'text/event-stream' } })
      }),
    )
    // Independent model of the expected final state from the raw capture.
    const model = new Map<string, FeedRow>()
    let deltas = 0
    createSseParser((e) => {
      const d = JSON.parse(e.data)
      if (e.event === 'snapshot') {
        model.clear()
        d.rows.forEach((r: FeedRow) => model.set(r.key, r))
      } else {
        deltas++
        d.removed.forEach((k: string) => model.delete(k))
        ;[...d.added, ...d.updated].forEach((r: FeedRow) => model.set(r.key, { ...model.get(r.key), ...r }))
      }
    }).push(text)

    const updates: { type: string; keys: string[]; rows: FeedRow[] }[] = []
    await new Promise<void>((resolve, reject) => {
      const close = feeds.streamActivityFeed(
        {
          onRows: (rows, info) => {
            updates.push({ type: info.type, keys: rows.map((r) => r.key), rows })
            if (updates.length === deltas + 1) {
              close()
              resolve()
            }
          },
          onError: (e) => reject(e),
        },
        { transport: 'fetch', initialBackoffMs: 60_000 },
      )
    })
    expect(header).toBe('feed-test/1 ow-cli/' + (await import('../package.json', { with: { type: 'json' } })).default.version)
    expect(updates[0].type).toBe('snapshot')
    expect(updates.slice(1).every((u) => u.type === 'delta')).toBe(true)
    const final = updates.at(-1)!
    expect(new Set(final.keys)).toEqual(new Set(model.keys()))
    const sorted = [...final.rows].sort(feeds.compareFeedRows)
    expect(final.keys).toEqual(sorted.map((r) => r.key))
    const firstConfirmed = final.rows.findIndex((r) => r.status === 'confirmed')
    expect(final.rows.slice(firstConfirmed).every((r) => r.status === 'confirmed')).toBe(true)
  })
})

describe('quotes', () => {
  it('getQuotes joins slugs and chunks at 64', async () => {
    const live = fixture('quotes.json')
    const seen: string[] = []
    server.use(
      http.get(`${BASE}/quotes`, ({ request }) => {
        const c = new URL(request.url).searchParams.get('collections')!
        seen.push(c)
        return HttpResponse.json({ ...live, marks: c.split(',').map((slug) => ({ ...live.marks[0], slug })) })
      }),
    )
    const one = await quotes.getQuotes(['bitcoin-puppets', 'nodemonkes'])
    expect(seen[0]).toBe('bitcoin-puppets,nodemonkes')
    expect(one.btc!.usd).toBeGreaterThan(0)
    const many = await quotes.getQuotes(Array.from({ length: 130 }, (_, i) => `s${i}`))
    expect(seen.slice(1).map((c) => c.split(',').length)).toEqual([64, 64, 2])
    expect(many.marks.length).toBe(130)
  })

  it('streamQuotes rejects more than 64 collections', () => {
    expect(() => quotes.streamQuotes(Array.from({ length: 65 }, (_, i) => `s${i}`), {})).toThrow(RangeError)
  })

  it('streamQuotes replays the live capture into onBtc/onMark', async () => {
    let url: URL | undefined
    server.use(
      http.get(`${BASE}/quotes/stream`, ({ request }) => {
        url = new URL(request.url)
        return new HttpResponse(textStream(sseFixture('quotes_stream.sse'), [64]), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    )
    const btc: number[] = []
    const marks: string[] = []
    let snapshots = 0
    let snapshotMarks = 0
    await new Promise<void>((resolve) => {
      const close = quotes.streamQuotes(
        ['bitcoin-puppets', 'nodemonkes'],
        {
          onSnapshot: (snap) => {
            snapshots++
            snapshotMarks = snap.marks.length
          },
          onBtc: (b) => btc.push(b.usd),
          onMark: (m) => {
            marks.push(m.slug)
            if (marks.length === snapshotMarks + 1) {
              close()
              resolve()
            }
          },
        },
        { transport: 'fetch', initialBackoffMs: 60_000 },
      )
    })
    expect(url?.searchParams.get('collections')).toBe('bitcoin-puppets,nodemonkes')
    expect(snapshots).toBe(1)
    expect(btc.length).toBe(4) // snapshot btc + 3 live btc events before the mark
    expect(marks).toContain('bitcoin-puppets')
  })
})
