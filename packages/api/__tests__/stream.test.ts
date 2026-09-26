import { describe, it, expect, vi } from 'vitest'
import { createSseParser, parseRetryAfter, subscribe, SseHttpError, type SseEvent } from '../src/stream.js'
import { sseFixture, textStream } from './market-fixtures.js'

function parseAll(text: string, sizes?: number[]): { events: SseEvent[]; comments: string[]; retries: number[] } {
  const events: SseEvent[] = []
  const comments: string[] = []
  const retries: number[] = []
  const p = createSseParser({ onEvent: (e) => events.push(e), onComment: (c) => comments.push(c), onRetry: (r) => retries.push(r) })
  if (!sizes) p.push(text)
  else {
    let i = 0
    let n = 0
    while (i < text.length) {
      const s = sizes[n++ % sizes.length]
      p.push(text.slice(i, i + s))
      i += s
    }
  }
  p.end()
  return { events, comments, retries }
}

describe('SSE parser (live captures)', () => {
  const quotes = sseFixture('quotes_stream.txt')
  const activity = sseFixture('activity_stream.txt')

  it('parses the /quotes/stream capture: snapshot, btc, mark, keep-alives', () => {
    const { events, comments } = parseAll(quotes)
    expect(events.map((e) => e.event)).toEqual(['snapshot', 'btc', 'btc', 'btc', 'mark', 'btc', 'btc', 'btc'])
    expect(events[0].event).toBe('snapshot')
    const snap = JSON.parse(events[0].data)
    expect(snap.type).toBe('snapshot')
    expect(snap.btc.usd).toBeGreaterThan(0)
    const btc = events.filter((e) => e.event === 'btc').map((e) => JSON.parse(e.data))
    expect(btc.length).toBeGreaterThan(0)
    expect(btc[0]).toEqual({ usd: expect.any(Number), ts: expect.any(Number) })
    const mark = JSON.parse(events.find((e) => e.event === 'mark')!.data)
    expect(mark.slug).toBe('bitcoin-puppets')
    expect(mark.fair_sats).toBeGreaterThan(0)
    expect(comments.every((c) => c === 'keep-alive')).toBe(true)
    expect(comments.length).toBeGreaterThan(0)
  })

  it('parses the activity feed capture: snapshot then deltas', () => {
    const { events } = parseAll(activity)
    expect(events[0].event).toBe('snapshot')
    expect(events.slice(1).every((e) => e.event === 'delta')).toBe(true)
    const d = JSON.parse(events[1].data)
    expect(Array.isArray(d.added)).toBe(true)
    expect(Array.isArray(d.removed)).toBe(true)
  })

  it('is independent of chunk boundaries and line endings', () => {
    const whole = parseAll(activity).events
    for (const sizes of [[1], [2, 7], [13], [4096], [3, 1, 50]]) {
      expect(parseAll(activity, sizes).events).toEqual(whole)
    }
    // CRLF and bare CR line endings, split between CR and LF
    expect(parseAll(activity.replace(/\n/g, '\r\n'), [1, 2, 3]).events).toEqual(whole)
    expect(parseAll(activity.replace(/\n/g, '\r'), [5]).events).toEqual(whole)
  })

  it('handles spec details: multi-line data, id, retry, default event, BOM, unterminated tail', () => {
    const text = '﻿data: a\ndata:b\nid: 7\n\nevent: x\ndata\n\nretry: 2500\n: hi\n\ndata: tail-without-blank-line'
    const { events, comments, retries } = parseAll(text)
    expect(events).toEqual([
      { event: 'message', data: 'a\nb', id: '7' },
      { event: 'x', data: '', id: '7' },
    ])
    expect(retries).toEqual([2500])
    expect(comments).toEqual(['hi'])
  })
})

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('Sat, 26 Sep 2026 16:43:33 GMT', Date.parse('Sat, 26 Sep 2026 16:43:31 GMT'))).toBe(2000)
    expect(parseRetryAfter('nonsense')).toBeUndefined()
  })
})

function sseResponse(text: string, sizes?: number[]): Response {
  return new Response(textStream(text, sizes), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('subscribe (fetch transport)', () => {
  it('delivers named events and closes cleanly', async () => {
    const fetchMock = vi.fn(async () => sseResponse(sseFixture('quotes_stream.txt'), [17]))
    const names: string[] = []
    await new Promise<void>((resolve) => {
      const close = subscribe(
        'https://x.test/quotes/stream',
        {
          events: {
            snapshot: () => names.push('snapshot'),
            mark: () => {
              names.push('mark')
              close()
              resolve()
            },
          },
        },
        { transport: 'fetch', fetch: fetchMock as unknown as typeof fetch },
      )
    })
    expect(names[0]).toBe('snapshot')
    expect(names).toContain('mark')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream')
  })

  it('retries after 503 using Retry-After, then reconnects when the stream ends', async () => {
    let n = 0
    const fetchMock = vi.fn(async () => {
      n++
      if (n === 1) return new Response('rebuilding', { status: 503, headers: { 'retry-after': '0' } })
      return sseResponse('event:btc\ndata:{"usd":1,"ts":1}\n\n')
    })
    const errors: unknown[] = []
    let btc = 0
    await new Promise<void>((resolve) => {
      const close = subscribe(
        'https://x.test/s',
        {
          onError: (e) => errors.push(e),
          events: {
            btc: () => {
              if (++btc === 2) {
                close()
                resolve()
              }
            },
          },
        },
        { transport: 'fetch', fetch: fetchMock as unknown as typeof fetch, initialBackoffMs: 1 },
      )
    })
    expect(errors[0]).toBeInstanceOf(SseHttpError)
    expect((errors[0] as SseHttpError).status).toBe(503)
    expect((errors[0] as SseHttpError).retryAfterMs).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 503, stream #1 (ended), stream #2
  })

  it('treats 404 as fatal and stops', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }))
    const info = await new Promise<{ fatal: boolean }>((resolve) => {
      subscribe('https://x.test/s', { onError: (_e, i) => resolve(i) }, {
        transport: 'fetch',
        fetch: fetchMock as unknown as typeof fetch,
        initialBackoffMs: 1,
      })
    })
    expect(info.fatal).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect after unsubscribe', async () => {
    const fetchMock = vi.fn(async () => sseResponse(''))
    const close = subscribe('https://x.test/s', {}, {
      transport: 'fetch',
      fetch: fetchMock as unknown as typeof fetch,
      initialBackoffMs: 5,
    })
    close()
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1)
  })
})

describe('subscribe (EventSource transport)', () => {
  it('uses EventSource, registers named listeners, reconnects when CLOSED', async () => {
    const instances: FakeES[] = []
    class FakeES {
      readyState = 0
      onopen: ((ev: unknown) => void) | null = null
      onerror: ((ev: unknown) => void) | null = null
      listeners = new Map<string, (ev: { data: string }) => void>()
      closed = false
      constructor(public url: string) {
        instances.push(this)
      }
      addEventListener(t: string, l: (ev: { data: string }) => void) {
        this.listeners.set(t, l)
      }
      close() {
        this.closed = true
        this.readyState = 2
      }
    }
    const got: string[] = []
    const close = subscribe(
      'https://x.test/s',
      { events: { snapshot: (d) => got.push(d) } },
      { EventSource: FakeES as any, initialBackoffMs: 1 },
    )
    expect(instances.length).toBe(1)
    expect([...instances[0].listeners.keys()].sort()).toEqual(['message', 'snapshot'])
    instances[0].listeners.get('snapshot')!({ data: '{"a":1}' })
    expect(got).toEqual(['{"a":1}'])
    instances[0].readyState = 2
    instances[0].onerror!({})
    await new Promise((r) => setTimeout(r, 20))
    expect(instances.length).toBe(2)
    close()
    expect(instances[1].closed).toBe(true)
  })
})
