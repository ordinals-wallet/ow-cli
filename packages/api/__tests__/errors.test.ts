import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { createClient, setClient } from '../src/client.js'
import { OwApiError, isOwApiError, extractErrorMessage } from '../src/errors.js'
import { computeRetryDelay, parseRetryAfter } from '../src/retry.js'
import * as walletApi from '../src/wallet.js'

const BASE = 'https://turbo.ordinalswallet.com'
const FAST = { baseUrl: BASE, retryDelay: 1, maxDelay: 50 }

afterEach(() => setClient({ baseUrl: BASE }))

function flaky(path: string, failures: Response[], ok: unknown, method: 'get' | 'post' = 'get') {
  const calls = { n: 0 }
  server.use(
    http[method](`${BASE}${path}`, () => {
      const r = failures[calls.n]
      calls.n++
      return r ?? HttpResponse.json(ok as never)
    }),
  )
  return calls
}

describe('OwApiError', () => {
  it('parses {error:true,message} bodies', async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.json({ error: true, message: 'Invalid Address' }, { status: 400 })))
    const err = await createClient(FAST).get('/x').catch((e) => e)
    expect(err).toBeInstanceOf(OwApiError)
    expect(isOwApiError(err)).toBe(true)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Invalid Address')
    expect(err.body).toEqual({ error: true, message: 'Invalid Address' })
    expect(err.statusText).toBe('Bad Request')
    expect(err.headers.get('content-type')).toMatch(/json/)
    expect(err.method).toBe('GET')
    expect(err.url).toBe('/x')
  })

  it('parses plain-text bodies', async () => {
    server.use(http.get(`${BASE}/x`, () => new HttpResponse('Invalid URL: notanid invalid length: 7', { status: 400, headers: { 'content-type': 'text/plain' } })))
    const err = await createClient(FAST).get('/x').catch((e) => e)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Invalid URL: notanid invalid length: 7')
  })

  it('parses {error:"..."} bodies and falls back for empty bodies', async () => {
    expect(extractErrorMessage({ error: 'unauthorized' })).toBe('unauthorized')
    expect(extractErrorMessage('')).toBeUndefined()
    server.use(http.get(`${BASE}/x`, () => new HttpResponse(null, { status: 404 })))
    const err = await createClient(FAST).get('/x').catch((e) => e)
    expect(err.status).toBe(404)
    expect(err.body).toBeUndefined()
    expect(err.message).toMatch(/^HTTP 404/)
  })

  it('reports network errors with status 0 and a code', async () => {
    server.use(http.get(`${BASE}/x`, () => HttpResponse.error()))
    const err = await createClient({ ...FAST, retries: 0 }).get('/x').catch((e) => e)
    expect(isOwApiError(err)).toBe(true)
    expect(err.status).toBe(0)
    expect(err.isTransient).toBe(true)
    expect(typeof err.code).toBe('string')
  })
})

describe('retries', () => {
  it('retries GETs on 5xx then succeeds', async () => {
    const calls = flaky('/wallet/fee-estimates', [new HttpResponse('boom', { status: 502 }), new HttpResponse('boom', { status: 503 })], { fastestFee: 9 })
    setClient(FAST)
    const fees = await walletApi.getFeeEstimates()
    expect(fees.fastestFee).toBe(9)
    expect(calls.n).toBe(3)
  })

  it('retries GETs on 429 and network errors', async () => {
    const calls = flaky('/x', [new HttpResponse(null, { status: 429 }), HttpResponse.error()], { ok: 1 })
    const data = await createClient(FAST).get('/x')
    expect(data).toEqual({ ok: 1 })
    expect(calls.n).toBe(3)
  })

  it('gives up after `retries` and reports the count', async () => {
    const calls = flaky('/x', Array.from({ length: 10 }, () => new HttpResponse('down', { status: 500 })), {})
    const err = await createClient({ ...FAST, retries: 3 }).get('/x').catch((e) => e)
    expect(calls.n).toBe(4)
    expect(err.status).toBe(500)
    expect(err.retries).toBe(3)
    expect(err.message).toBe('down')
  })

  it('does not retry 4xx', async () => {
    const calls = flaky('/x', [HttpResponse.json({ error: true, message: 'bad' }, { status: 400 })], {})
    await createClient(FAST).get('/x').catch(() => {})
    expect(calls.n).toBe(1)
  })

  it('never retries POSTs by default', async () => {
    const calls = flaky('/wallet/broadcast', [new HttpResponse('boom', { status: 503 })], { txid: 't' }, 'post')
    setClient(FAST)
    const err = await walletApi.broadcast('00').catch((e) => e)
    expect(isOwApiError(err)).toBe(true)
    expect(err.status).toBe(503)
    expect(calls.n).toBe(1)
  })

  it('retries a POST only when the request opts in', async () => {
    const calls = flaky('/y', [new HttpResponse('boom', { status: 503 })], { ok: true }, 'post')
    const data = await createClient(FAST).post('/y', {}, { retry: true })
    expect(data).toEqual({ ok: true })
    expect(calls.n).toBe(2)
  })

  it('can be disabled per client and per request', async () => {
    const a = flaky('/x', [new HttpResponse(null, { status: 500 })], {})
    await createClient({ ...FAST, retries: 0 }).get('/x').catch(() => {})
    expect(a.n).toBe(1)
    const b = flaky('/x', [new HttpResponse(null, { status: 500 })], {})
    await createClient(FAST).get('/x', { retry: false }).catch(() => {})
    expect(b.n).toBe(1)
  })

  it('honours Retry-After', async () => {
    const calls = flaky('/x', [new HttpResponse(null, { status: 429, headers: { 'Retry-After': '1' } })], { ok: 1 })
    const t0 = Date.now()
    await createClient({ ...FAST, maxDelay: 5000 }).get('/x')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950)
    expect(calls.n).toBe(2)
  })

  it('fails fast when Retry-After exceeds maxDelay', async () => {
    const calls = flaky('/x', [new HttpResponse(null, { status: 503, headers: { 'Retry-After': '120' } })], {})
    const err = await createClient(FAST).get('/x').catch((e) => e)
    expect(calls.n).toBe(1)
    expect(err.status).toBe(503)
  })
})

describe('retry delay maths', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('garbage')).toBeUndefined()
    const now = Date.parse('2026-09-26T00:00:00Z')
    expect(parseRetryAfter('Sat, 26 Sep 2026 00:00:03 GMT', now)).toBe(3000)
  })

  it('backs off exponentially with jitter, capped at maxDelay', () => {
    const opts = { retryDelay: 100, maxDelay: 1000 }
    expect(computeRetryDelay(1, opts, undefined, () => 0)).toBe(50)
    expect(computeRetryDelay(1, opts, undefined, () => 1)).toBe(100)
    expect(computeRetryDelay(3, opts, undefined, () => 1)).toBe(400)
    expect(computeRetryDelay(10, opts, undefined, () => 1)).toBe(1000)
    expect(computeRetryDelay(1, opts, '0.5')).toBe(500)
    expect(computeRetryDelay(1, opts, '5')).toBeUndefined()
  })
})
