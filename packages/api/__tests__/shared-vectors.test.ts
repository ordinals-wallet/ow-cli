/**
 * Language-neutral test vectors in the repo-root `fixtures/` directory. The
 * Rust SDK (`rust/ordinalswallet`) asserts the same files, so both
 * implementations are held to identical behaviour.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { buildClientHeader, setClient, SDK_CLIENT_TOKEN } from '../src/client.js'
import { getFeeEstimates } from '../src/wallet.js'
import { signInMessage, generateNonce } from '../src/auth.js'
import {
  outpointToTxidVout,
  parseSerializedOutpoint,
  txidVoutToSerialized,
  isSerializedOutpoint,
} from '../src/outpoint.js'
import { computeRetryDelay, parseRetryAfter, DEFAULT_RETRY_OPTIONS } from '../src/retry.js'
import { parseRetryAfter as parseSseRetryAfter, createSseParser, type SseEvent } from '../src/stream.js'
import { createFeedStore } from '../src/feeds.js'
import type { FeedDelta, FeedPage } from '../src/types-feeds.js'

// Requests in these tests go through public SDK calls against a mock origin.
const BASE = 'https://vectors.test'
const FIXTURES = new URL('../../../fixtures/', import.meta.url)
const vec = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T
const text = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8')

describe('fixtures/sign-in-message.json', () => {
  const v = vec('sign-in-message.json')
  it.each(v.cases as any[])('$address', (c) => {
    expect(signInMessage(c.address, c.nonce, c.issued_at_ms)).toBe(c.expected)
    const fromTemplate = (v.template as string)
      .replace('{address}', c.address)
      .replace('{nonce}', c.nonce)
      .replace('{issued_at_ms}', String(c.issued_at_ms))
    expect(fromTemplate).toBe(c.expected)
  })
  it('generates nonces of the documented shape', () => {
    const re = new RegExp(v.nonce.pattern)
    const a = generateNonce()
    expect(a).toHaveLength(v.nonce.hex_length)
    expect(a).toMatch(re)
    expect(generateNonce()).not.toBe(a)
  })
})

describe('fixtures/outpoint.json', () => {
  const v = vec('outpoint.json')
  it.each(v.valid as any[])('$name', (c) => {
    expect(isSerializedOutpoint(c.serialized)).toBe(true)
    expect(outpointToTxidVout(c.serialized)).toBe(c.txid_vout)
    expect(parseSerializedOutpoint(c.serialized).vout).toBe(c.vout)
    expect(txidVoutToSerialized(c.txid_vout)).toBe(c.serialized.toLowerCase())
  })
  it('passes txid:vout through, lowercased', () => {
    for (const c of v.passthrough) expect(outpointToTxidVout(c.input)).toBe(c.expected)
  })
  it('round-trips txid:vout', () => {
    for (const c of v.roundtrip) {
      expect(txidVoutToSerialized(c.txid_vout)).toBe(c.serialized)
      expect(outpointToTxidVout(c.serialized)).toBe(c.txid_vout)
    }
  })
  it('rejects malformed input', () => {
    for (const s of v.invalid_serialized) expect(() => outpointToTxidVout(s)).toThrow(TypeError)
    for (const s of v.invalid_txid_vout) expect(() => txidVoutToSerialized(s)).toThrow(TypeError)
  })
  it('matches the satpoint of the same inscription', () => {
    const [txid, vout] = vec('api/inscription.json').satpoint.split(':')
    expect(v.valid[0].txid_vout).toBe(`${txid}:${vout}`)
  })
})

describe('fixtures/client-header.json', () => {
  const v = vec('client-header.json')
  it.each(v.cases as any[])('$name', (c) => {
    expect(buildClientHeader(c.app_name ?? undefined)).toBe(c.expected.replace('{sdk}', SDK_CLIENT_TOKEN))
  })
})

describe('fixtures/retry.json', () => {
  const v = vec('retry.json')
  it('defaults', () => {
    expect(DEFAULT_RETRY_OPTIONS).toEqual({
      retries: v.defaults.retries,
      retryDelay: v.defaults.retry_delay_ms,
      maxDelay: v.defaults.max_delay_ms,
    })
  })
  it('parses Retry-After', () => {
    for (const c of v.parse_retry_after) {
      expect(parseRetryAfter(c.value ?? undefined, v.now_ms) ?? null).toBe(c.expected_ms)
      expect(parseSseRetryAfter(c.value, v.now_ms) ?? null).toBe(c.expected_ms)
    }
  })
  it('computes delays', () => {
    for (const c of v.compute_delay) {
      const got = computeRetryDelay(
        c.attempt,
        { retryDelay: c.retry_delay_ms, maxDelay: c.max_delay_ms },
        c.retry_after ?? undefined,
        () => c.random,
      )
      expect(got ?? null).toBe(c.expected_ms)
    }
  })
  it('keeps default backoff within bounds', () => {
    for (const b of v.default_backoff_bounds) {
      for (const r of [0, 0.25, 0.5, 0.999, 1]) {
        const d = computeRetryDelay(b.attempt, DEFAULT_RETRY_OPTIONS, undefined, () => r)!
        expect(d).toBeGreaterThanOrEqual(b.min_ms)
        expect(d).toBeLessThanOrEqual(b.max_ms)
      }
    }
  })

  afterEach(() => setClient({ baseUrl: 'https://turbo.ordinalswallet.com' }))
  it('retries exactly the retryable statuses on GET', async () => {
    for (const [status, retried] of [
      ...v.retryable_status.retry.map((s: number) => [s, true] as const),
      ...v.retryable_status.no_retry.map((s: number) => [s, false] as const),
    ]) {
      let n = 0
      server.use(
        http.get(`${BASE}/wallet/fee-estimates`, () => {
          n++
          return n === 1 ? new HttpResponse(null, { status }) : HttpResponse.json({ ok: true })
        }),
      )
      setClient({ baseUrl: BASE, retryDelay: 1, maxDelay: 5 })
      await getFeeEstimates().catch(() => {})
      expect([status, n]).toEqual([status, retried ? 2 : 1])
    }
  })
})

describe('fixtures/feeds-deltas.json', () => {
  const v = vec('feeds-deltas.json')
  it.each(v.cases as any[])('$name', (c) => {
    const store = createFeedStore(c.max_rows === null ? {} : { maxRows: c.max_rows })
    for (const step of c.steps) {
      const rows = step.snapshot ? store.applySnapshot(step.snapshot as FeedPage) : store.applyDelta(step.delta as FeedDelta)
      expect(rows.map((r) => r.key)).toEqual(step.expect.keys)
      expect(store.version).toBe(step.expect.version)
      expect(store.tip ?? null).toBe(step.expect.tip)
      expect(rows.map((r) => ({ key: r.key, status: r.status, price_sats: r.price_sats, ts: r.ts ?? null }))).toEqual(
        step.expect.rows,
      )
    }
  })
  it('replays the live activity capture', () => {
    const r = v.sse_replay
    const store = createFeedStore()
    const got: unknown[] = []
    createSseParser((e) => {
      const d = JSON.parse(e.data)
      const rows = e.event === 'snapshot' ? store.applySnapshot(d) : store.applyDelta(d)
      got.push({ event: e.event, version: store.version, tip: store.tip ?? null, keys: rows.map((x) => x.key) })
    }).push(text(r.sse))
    expect(got).toEqual(r.after_each_event)
  })
})

describe('fixtures/sse', () => {
  const names = readdirSync(new URL('sse/', FIXTURES))
    .filter((f) => f.endsWith('.expected.json'))
    .map((f) => f.replace('.expected.json', ''))

  function parseAll(input: string, sizes?: number[]) {
    const events: SseEvent[] = []
    const comments: string[] = []
    const retries: number[] = []
    const p = createSseParser({
      onEvent: (e) => events.push(e),
      onComment: (c) => comments.push(c),
      onRetry: (ms) => retries.push(ms),
    })
    if (!sizes) p.push(input)
    else {
      for (let i = 0, n = 0; i < input.length; ) {
        const s = sizes[n++ % sizes.length]
        p.push(input.slice(i, i + s))
        i += s
      }
    }
    p.end()
    return { events, comments, retries }
  }

  it.each(names)('%s', (name) => {
    const expected = vec(`sse/${name}.expected.json`)
    const input = text(expected.source)
    const want = { events: expected.events, comments: expected.comments, retries: expected.retries }
    expect(parseAll(input)).toEqual(want)
    for (const sizes of [[1], [2, 7], [13], [3, 1, 50]]) expect(parseAll(input, sizes)).toEqual(want)
    expect(parseAll(input.replace(/\n/g, '\r\n'), [1, 2, 3])).toEqual(want)
  })
})

describe('fixtures/error-bodies.json', () => {
  const v = vec('error-bodies.json')
  afterEach(() => setClient({ baseUrl: 'https://turbo.ordinalswallet.com' }))
  it.each(v.cases as any[])('$name', async (c) => {
    server.use(
      http.get(`${BASE}/wallet/fee-estimates`, () =>
        c.body === null
          ? new HttpResponse(null, { status: c.status })
          : new HttpResponse(c.body, { status: c.status, headers: { 'content-type': c.content_type } }),
      ),
    )
    setClient({ baseUrl: BASE, retries: 0 })
    const err = await getFeeEstimates().catch((e) => e)
    expect(err.status).toBe(c.status)
    expect(err.code ?? null).toBe(c.expected.code)
    expect(err.body ?? null).toEqual(c.expected.body)
    if (c.expected.message !== null) expect(err.message).toBe(c.expected.message)
    else expect(err.message.startsWith(c.expected.message_prefix)).toBe(true)
  })
})

describe('fixtures/api decodes', () => {
  it('every recorded response is valid JSON', () => {
    const files = readdirSync(new URL('api/', FIXTURES)).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(20)
    for (const f of files) expect(() => vec(`api/${f}`)).not.toThrow()
  })
})
