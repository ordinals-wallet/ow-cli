import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setClient, signInMessage } from '@ow-cli/api'
import { verifyBip322Simple, keypairFromWIF } from '@ow-cli/core'
import { signInWithKey, sessionManagerForKey, keypairAddress } from '../src/auth.js'

// Public BIP-322 test-vector key. Not a real wallet.
const WIF = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k'
const TAPROOT = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3'
const SEGWIT = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'

// A local stand-in for POST /auth/session that, like the API, rebuilds the
// message from the request fields and checks the BIP-322 signature.
let srv: Server
let hits = 0
beforeAll(async () => {
  srv = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      hits++
      const b = JSON.parse(raw)
      const ok =
        req.url === '/auth/session' &&
        /^[0-9a-f]{16,64}$/.test(b.nonce) &&
        (await verifyBip322Simple(b.address, signInMessage(b.address, b.nonce, b.issued_at), b.signature))
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok
        ? { token: `ows1.${b.nonce}`, address: b.address, expires_at: Math.floor(Date.now() / 1000) + 86400 }
        : { error: true, message: 'Invalid wallet signature' }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  setClient({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` })
})
afterAll(() => new Promise<void>((r) => srv.close(() => r())))

describe('sign in with an SDK-managed key', () => {
  it('uses the key taproot address by default', () => {
    expect(keypairAddress(keypairFromWIF(WIF))).toBe(TAPROOT)
  })

  it('signs in from a WIF (taproot) with a verifiable BIP-322 signature', async () => {
    const s = await signInWithKey({ wif: WIF })
    expect(s.address).toBe(TAPROOT)
    expect(s.token).toMatch(/^ows1\.[0-9a-f]{32}$/)
  })

  it('signs in for the native segwit address of the same key', async () => {
    const s = await signInWithKey({ wif: WIF }, SEGWIT)
    expect(s.address).toBe(SEGWIT)
  })

  it('signs in from a mnemonic', async () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const s = await signInWithKey({ mnemonic })
    expect(s.address).toMatch(/^bc1p/)
  })

  it('session manager signs in once and reuses the token', async () => {
    const before = hits
    const mgr = sessionManagerForKey({ wif: WIF })
    const a = await mgr.getToken(TAPROOT)
    expect(await mgr.getToken(TAPROOT)).toBe(a)
    expect(hits - before).toBe(1)
  })
})
