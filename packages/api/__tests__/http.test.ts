import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse, delay } from 'msw'
import { server } from './setup.js'
import { createClient, setClient, getClient, joinUrl, buildQuery, CLIENT_HEADER, SDK_CLIENT_TOKEN } from '../src/client.js'
import { isOwApiError, OwApiError } from '../src/errors.js'
import * as network from '../src/network.js'

const BASE = 'https://turbo.ordinalswallet.com'
const FAST = { baseUrl: BASE, retryDelay: 1, maxDelay: 50 }

afterEach(() => setClient({ baseUrl: BASE }))

function counter(method: 'get' | 'post', path: string, respond: (n: number, req: Request) => Response | Promise<Response>) {
  const calls = { n: 0, requests: [] as Request[] }
  server.use(
    http[method](`${BASE}${path}`, async ({ request }) => {
      calls.n++
      calls.requests.push(request.clone())
      return respond(calls.n, request)
    }),
  )
  return calls
}

describe('fetch client: requests', () => {
  it('get/post resolve to the parsed JSON body', async () => {
    counter('get', '/a', () => HttpResponse.json({ a: 1 }))
    counter('post', '/b', async (_n, req) => HttpResponse.json({ echo: await req.json() }))
    const c = createClient(FAST)
    expect(await c.get<{ a: number }>('/a')).toEqual({ a: 1 })
    expect(await c.post('/b', { x: [1, 2] })).toEqual({ echo: { x: [1, 2] } })
  })

  it('returns text for non-JSON bodies and undefined for empty ones', async () => {
    counter('get', '/t', () => new HttpResponse('912345', { headers: { 'content-type': 'text/plain' } }))
    counter('get', '/s', () => new HttpResponse('hello', { headers: { 'content-type': 'text/plain' } }))
    counter('get', '/e', () => new HttpResponse(null, { status: 204 }))
    const c = createClient(FAST)
    expect(await c.get('/t')).toBe(912345) // JSON-parseable text parses, as before
    expect(await c.get('/s')).toBe('hello')
    expect(await c.get('/e')).toBeUndefined()
  })

  it('request() exposes status and headers, and acceptStatus resolves chosen statuses', async () => {
    counter('get', '/nf', () => HttpResponse.json({ error: true, message: 'nope' }, { status: 404, headers: { 'x-id': '7' } }))
    const res = await createClient(FAST).request<{ message: string }>('/nf', { acceptStatus: (s) => s === 404 })
    expect(res.status).toBe(404)
    expect(res.headers.get('x-id')).toBe('7')
    expect(res.data.message).toBe('nope')
    await expect(createClient(FAST).request('/nf')).rejects.toMatchObject({ status: 404 })
  })

  it('serialises query params, skipping undefined and null', async () => {
    const calls = counter('get', '/q', () => HttpResponse.json({}))
    await createClient(FAST).get('/q', { params: { a: 'x y', b: 2, c: undefined, d: null, e: true, f: 'a,b' } })
    const url = new URL(calls.requests[0].url)
    expect(url.search).toBe('?a=x%20y&b=2&e=true&f=a%2Cb')
    expect(url.searchParams.get('f')).toBe('a,b')
  })

  it('joins base URLs and paths, and leaves absolute URLs alone', () => {
    expect(joinUrl('https://h/', '/p')).toBe('https://h/p')
    expect(joinUrl('https://h', 'p', { a: 1 })).toBe('https://h/p?a=1')
    expect(joinUrl('https://h', '/p?x=1', { a: 1 })).toBe('https://h/p?x=1&a=1')
    expect(joinUrl('https://h', 'https://other/z')).toBe('https://other/z')
    expect(buildQuery({})).toBe('')
    expect(getClient().url('/quotes', { collections: 'a' })).toBe(`${BASE}/quotes?collections=a`)
  })
})

describe('fetch client: headers', () => {
  it('sends identification + Accept on every request, Content-Type only with a JSON body', async () => {
    const g = counter('get', '/h', () => HttpResponse.json({}))
    const p = counter('post', '/h', () => HttpResponse.json({}))
    const c = createClient({ ...FAST, appName: 'bot/1' })
    await c.get('/h')
    await c.post('/h', { a: 1 })
    const gh = g.requests[0].headers
    expect(gh.get(CLIENT_HEADER)).toBe(`bot/1 ${SDK_CLIENT_TOKEN}`)
    expect(gh.get('user-agent')).toBe(SDK_CLIENT_TOKEN)
    expect(gh.get('accept')).toContain('application/json')
    expect(gh.get('content-type')).toBeNull()
    expect(p.requests[0].headers.get('content-type')).toBe('application/json')
  })

  it('merges per-request headers over the defaults', async () => {
    const calls = counter('post', '/h', () => HttpResponse.json({}))
    await createClient(FAST).post('/h', { a: 1 }, { headers: { 'Cache-Control': 'no-store', 'x-extra': '1' } })
    const h = calls.requests[0].headers
    expect(h.get('cache-control')).toBe('no-store')
    expect(h.get('x-extra')).toBe('1')
    expect(h.get(CLIENT_HEADER)).toBe(SDK_CLIENT_TOKEN)
  })

  it('lets fetch set the multipart boundary for FormData', async () => {
    const calls = counter('post', '/up', async (_n, req) => {
      const form = await req.formData()
      return HttpResponse.json({ fee_rate: form.get('fee_rate') })
    })
    const fd = new FormData()
    fd.append('fee_rate', '5')
    const res = await createClient(FAST).post<{ fee_rate: string }>('/up', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    expect(res.fee_rate).toBe('5')
    expect(calls.requests[0].headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
  })

  it('exposes frozen default headers', () => {
    const c = createClient(FAST)
    expect(Object.isFrozen(c.headers)).toBe(true)
    expect(c.baseUrl).toBe(BASE)
  })
})

describe('fetch client: errors', () => {
  const forms: [string, () => Response, { message: string | RegExp; code?: string; body: unknown }][] = [
    ['{error:true,message}', () => HttpResponse.json({ error: true, message: 'Invalid Address' }, { status: 400 }), { message: 'Invalid Address', body: { error: true, message: 'Invalid Address' } }],
    ['plain text', () => new HttpResponse('Invalid URL', { status: 400, headers: { 'content-type': 'text/plain' } }), { message: 'Invalid URL', body: 'Invalid URL' }],
    ['{error:"..."}', () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 }), { message: 'unauthorized', body: { error: 'unauthorized' } }],
    ['empty body', () => new HttpResponse(null, { status: 404, statusText: 'Not Found' }), { message: /^HTTP 404 Not Found \(GET \/err\)$/, body: undefined }],
    ['{error, code, message}', () => HttpResponse.json({ error: true, code: 'offer_expired', message: 'Offer has expired' }, { status: 409 }), { message: 'Offer has expired', code: 'offer_expired', body: { error: true, code: 'offer_expired', message: 'Offer has expired' } }],
    ['{error:"code", message}', () => HttpResponse.json({ error: 'stale', message: 'Item moved' }, { status: 409 }), { message: 'Item moved', code: 'stale', body: { error: 'stale', message: 'Item moved' } }],
  ]
  for (const [name, respond, want] of forms) {
    it(`parses ${name}`, async () => {
      counter('get', '/err', respond)
      const err = await createClient({ ...FAST, retries: 0 }).get('/err').catch((e) => e)
      expect(err).toBeInstanceOf(OwApiError)
      expect(isOwApiError(err)).toBe(true)
      expect(err.message).toMatch(want.message)
      expect(err.body).toEqual(want.body)
      expect(err.code).toBe(want.code)
      expect(err.method).toBe('GET')
      expect(err.url).toBe('/err')
      expect(err.retries).toBe(0)
    })
  }

  it('network failures have status 0, a code, and are transient', async () => {
    counter('get', '/down', () => HttpResponse.error())
    const err = await createClient({ ...FAST, retries: 0 }).get('/down').catch((e) => e)
    expect(err.status).toBe(0)
    expect(err.code).toBeTruthy()
    expect(err.isTransient).toBe(true)
  })

  it('reports a missing fetch clearly', async () => {
    const c = createClient({ ...FAST, fetch: undefined })
    const g = globalThis as { fetch?: typeof fetch }
    const saved = g.fetch
    g.fetch = undefined
    try {
      await expect(c.get('/x')).rejects.toMatchObject({ status: 0, code: 'ERR_NO_FETCH' })
    } finally {
      g.fetch = saved
    }
  })
})

describe('fetch client: timeout, abort, retry', () => {
  it('times out with ETIMEDOUT and retries GETs after a timeout', async () => {
    const calls = counter('get', '/slow', async (n) => {
      if (n === 1) await delay(500)
      return HttpResponse.json({ ok: n })
    })
    const res = await createClient({ ...FAST, timeout: 50 }).get('/slow')
    expect(res).toEqual({ ok: 2 })
    expect(calls.n).toBe(2)
  })

  it('gives up on repeated timeouts with ETIMEDOUT and the retry count', async () => {
    counter('get', '/slow', async () => {
      await delay(500)
      return HttpResponse.json({})
    })
    const err = await createClient({ ...FAST, timeout: 30, retries: 1 }).get('/slow').catch((e) => e)
    expect(err.status).toBe(0)
    expect(err.code).toBe('ETIMEDOUT')
    expect(err.message).toMatch(/timeout of 30ms exceeded/)
    expect(err.retries).toBe(1)
  })

  it('per-request timeout overrides the client timeout', async () => {
    counter('get', '/slow', async () => {
      await delay(300)
      return HttpResponse.json({})
    })
    const err = await createClient({ ...FAST, retries: 0 }).get('/slow', { timeout: 20 }).catch((e) => e)
    expect(err.code).toBe('ETIMEDOUT')
  })

  it('a caller abort is ERR_CANCELED and never retried', async () => {
    const calls = counter('get', '/slow', async () => {
      await delay(500)
      return HttpResponse.json({})
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    const err = await createClient(FAST).get('/slow', { signal: ac.signal }).catch((e) => e)
    expect(err.code).toBe('ERR_CANCELED')
    expect(err.isTransient).toBe(false)
    expect(calls.n).toBe(1)
  })

  it('does not retry a POST on 5xx or network errors unless opted in', async () => {
    const a = counter('post', '/p', () => new HttpResponse('boom', { status: 502 }))
    const err = await createClient(FAST).post('/p', {}).catch((e) => e)
    expect(err.status).toBe(502)
    expect(a.n).toBe(1)
    const b = counter('post', '/p', () => HttpResponse.error())
    await createClient(FAST).post('/p', {}).catch(() => {})
    expect(b.n).toBe(1)
    const c = counter('post', '/p', (n) => (n < 3 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ ok: true })))
    expect(await createClient(FAST).post('/p', {}, { retry: 2 })).toEqual({ ok: true })
    expect(c.n).toBe(3)
  })

  it('retries GET on 429 honouring Retry-After (HTTP-date form too)', async () => {
    const soon = new Date(Date.now() + 1000).toUTCString()
    const calls = counter('get', '/r', (n) =>
      n === 1 ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': soon } }) : HttpResponse.json({ ok: 1 }))
    expect(await createClient({ ...FAST, maxDelay: 5000 }).get('/r')).toEqual({ ok: 1 })
    expect(calls.n).toBe(2)
  })

  it('does not retry 4xx other than 429', async () => {
    const calls = counter('get', '/four', () => HttpResponse.json({ error: true, message: 'x' }, { status: 409 }))
    await createClient(FAST).get('/four').catch(() => {})
    expect(calls.n).toBe(1)
  })

  it('uses an injected fetch', async () => {
    const seen: string[] = []
    const fake: typeof fetch = async (input) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ via: 'fake' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    expect(await createClient({ ...FAST, fetch: fake }).get('/anything', { params: { a: 1 } })).toEqual({ via: 'fake' })
    expect(seen).toEqual([`${BASE}/anything?a=1`])
  })
})

describe('network helpers', () => {
  it('only talk to the OW API', async () => {
    const hosts: string[] = []
    server.events.on('request:start', ({ request }) => {
      hosts.push(new URL(request.url).host)
    })
    server.use(
      http.get(`${BASE}/blockheight`, () => HttpResponse.json(968721)),
      http.get(`${BASE}/quotes`, () => HttpResponse.json({ type: 'snapshot', btc: { usd: 84029.5, ts: 1790443388 }, marks: [], ts: 1 })),
    )
    expect(await network.getBlockHeight()).toBe(968721)
    expect(await network.getExchangeRate()).toEqual({ price: 84029.5, ts: 1790443388 })
    server.events.removeAllListeners()
    expect(new Set(hosts)).toEqual(new Set(['turbo.ordinalswallet.com']))
  })
})
