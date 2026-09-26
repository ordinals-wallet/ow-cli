import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { setClient } from '../src/client.js'
import { signInMessage, signIn, generateNonce, SessionManager, AuthError, createSession } from '../src/auth.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

const BASE = 'https://turbo.ordinalswallet.com'
const ADDR = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3'

describe('signInMessage', () => {
  it('matches the server format byte for byte', () => {
    expect(signInMessage(ADDR, '0123456789abcdef0123456789abcdef', 1700000000000)).toBe(
      'Sign in to Ordinals Wallet\n\nThis proves you own this address. It does not move funds or cost a fee.\n\nAddress: bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3\nNonce: 0123456789abcdef0123456789abcdef\nIssued At: 1700000000000',
    )
  })

  it('matches the server unit test (auth_session.rs message_is_stable)', () => {
    const a = 'bc1p3w07au5hu98gtuvjaruspma03pft77z59zvv9fa0j4gdfcfhqfss2cd529'
    expect(signInMessage(a, '00ff', 123)).toBe(
      `Sign in to Ordinals Wallet\n\nThis proves you own this address. It does not move funds or cost a fee.\n\nAddress: ${a}\nNonce: 00ff\nIssued At: 123`,
    )
  })
})

describe('generateNonce', () => {
  it('is 32 lowercase hex chars and random', () => {
    const a = generateNonce()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(generateNonce()).not.toBe(a)
  })
})

function sessionHandler(onBody?: (b: Record<string, unknown>) => void, expiresAt = 1_790_000_000) {
  return http.post(`${BASE}/auth/session`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    onBody?.(body)
    return HttpResponse.json({ token: `ows1.tok-${body.nonce}`, address: body.address, expires_at: expiresAt })
  })
}

describe('signIn', () => {
  it('signs the exact message and posts address, nonce, issued_at, signature', async () => {
    let posted: Record<string, unknown> = {}
    let signedMessage = ''
    server.use(sessionHandler((b) => (posted = b)))
    const s = await signIn({
      address: ADDR,
      nonce: 'ab'.repeat(16),
      issuedAt: 1700000000000,
      sign: async (m) => {
        signedMessage = m
        return 'SIG=='
      },
    })
    expect(signedMessage).toBe(signInMessage(ADDR, 'ab'.repeat(16), 1700000000000))
    expect(posted).toEqual({ address: ADDR, nonce: 'ab'.repeat(16), issued_at: 1700000000000, signature: 'SIG==' })
    expect(s).toEqual({ token: `ows1.tok-${'ab'.repeat(16)}`, address: ADDR, expires_at: 1_790_000_000 })
  })

  it('defaults to a fresh 32-hex nonce and the current time', async () => {
    let posted: Record<string, unknown> = {}
    server.use(sessionHandler((b) => (posted = b)))
    const before = Date.now()
    await signIn({ address: ADDR, sign: () => 'x' })
    expect(posted.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(posted.issued_at as number).toBeGreaterThanOrEqual(before)
  })

  it('maps API rejections to AuthError with the server message', async () => {
    server.use(
      http.post(`${BASE}/auth/session`, () =>
        HttpResponse.json({ error: true, message: 'Invalid wallet signature' }, { status: 401 }),
      ),
    )
    const err = await createSession({ address: ADDR, nonce: 'aa'.repeat(16), issued_at: 1, signature: 'x' }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(AuthError)
    expect(err.name).toBe('AuthError')
    expect(err.status).toBe(401)
    expect(err.message).toBe('Invalid wallet signature')
  })
})

it('sign-in POST is never retried (nonces are single use)', async () => {
  let calls = 0
  server.use(http.post(`${BASE}/auth/session`, () => (calls++, HttpResponse.json({ error: true, message: 'busy' }, { status: 503 }))))
  await expect(signIn({ address: ADDR, sign: () => 'x' })).rejects.toBeInstanceOf(AuthError)
  expect(calls).toBe(1)
})

describe('SessionManager', () => {
  it('caches per address and refreshes within 5 minutes of expiry', async () => {
    let calls = 0
    let now = 1_000_000_000_000 // ms
    const expires = now / 1000 + 3600
    server.use(sessionHandler(() => calls++, expires))
    const mgr = new SessionManager({ sign: () => 'sig', now: () => now })

    const t1 = await mgr.getToken(ADDR)
    expect(await mgr.getToken(ADDR)).toBe(t1)
    expect(calls).toBe(1)

    now += (3600 - 301) * 1000 // 5m01s before expiry: still cached
    expect(await mgr.getToken(ADDR)).toBe(t1)
    expect(calls).toBe(1)

    now += 2000 // 4m59s before expiry: refresh
    const t2 = await mgr.getToken(ADDR)
    expect(calls).toBe(2)
    expect(t2).not.toBe(t1)
  })

  it('shares one sign-in between concurrent callers', async () => {
    let calls = 0
    server.use(sessionHandler(() => calls++, Math.floor(Date.now() / 1000) + 86400))
    const mgr = new SessionManager({ sign: () => 'sig' })
    const [a, b] = await Promise.all([mgr.getToken(ADDR), mgr.getToken(ADDR)])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })

  it('keeps separate tokens per address and supports invalidate', async () => {
    let calls = 0
    server.use(sessionHandler(() => calls++, Math.floor(Date.now() / 1000) + 86400))
    const signs: string[] = []
    const mgr = new SessionManager({ sign: (address) => (signs.push(address), 'sig') })
    const other = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
    await mgr.getToken(ADDR)
    await mgr.getToken(other)
    expect(signs).toEqual([ADDR, other])
    mgr.invalidate(ADDR)
    await mgr.getToken(ADDR)
    expect(calls).toBe(3)
  })

  it('throws AuthError without a signer', async () => {
    await expect(new SessionManager().getToken(ADDR)).rejects.toBeInstanceOf(AuthError)
  })
})
