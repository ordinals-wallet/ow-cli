import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import {
  createClient,
  setClient,
  buildClientHeader,
  CLIENT_HEADER,
  SDK_CLIENT_TOKEN,
} from '../src/client.js'
import { VERSION } from '../src/version.js'
import * as walletApi from '../src/wallet.js'
import pkg from '../package.json' with { type: 'json' }

const BASE = 'https://turbo.ordinalswallet.com'

function captureHeaders(): { headers: Headers | null } {
  const seen: { headers: Headers | null } = { headers: null }
  server.use(
    http.get(`${BASE}/wallet/fee-estimates`, ({ request }) => {
      seen.headers = request.headers
      return HttpResponse.json({ fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 })
    }),
  )
  return seen
}

afterEach(() => {
  setClient({ baseUrl: BASE })
})

describe('client identification', () => {
  it('bakes the package version into the SDK token', () => {
    expect(VERSION).toBe(pkg.version)
    expect(SDK_CLIENT_TOKEN).toBe(`ow-cli/${pkg.version}`)
  })

  it('sends x-ow-client and User-Agent (Node) on every request', async () => {
    const seen = captureHeaders()
    setClient({ baseUrl: BASE })
    await walletApi.getFeeEstimates()
    expect(seen.headers?.get(CLIENT_HEADER)).toBe(`ow-cli/${pkg.version}`)
    expect(seen.headers?.get('user-agent')).toBe(`ow-cli/${pkg.version}`)
  })

  it('prepends a caller appName ahead of the SDK token', async () => {
    const seen = captureHeaders()
    setClient({ baseUrl: BASE, appName: 'my-bot/1.2' })
    await walletApi.getFeeEstimates()
    expect(seen.headers?.get(CLIENT_HEADER)).toBe(`my-bot/1.2 ow-cli/${pkg.version}`)
    // User-Agent stays the SDK token; app identity lives in x-ow-client.
    expect(seen.headers?.get('user-agent')).toBe(`ow-cli/${pkg.version}`)
  })

  it('applies to standalone createClient instances too', async () => {
    const seen = captureHeaders()
    await createClient({ baseUrl: BASE, appName: 'svc/2.0 worker/3' }).get('/wallet/fee-estimates')
    expect(seen.headers?.get(CLIENT_HEADER)).toBe(`svc/2.0 worker/3 ow-cli/${pkg.version}`)
  })

  it('normalises whitespace and ignores empty appName', () => {
    expect(buildClientHeader('  a/1   b/2 ')).toBe(`a/1 b/2 ${SDK_CLIENT_TOKEN}`)
    expect(buildClientHeader('   ')).toBe(SDK_CLIENT_TOKEN)
    expect(buildClientHeader()).toBe(SDK_CLIENT_TOKEN)
  })

  it('does not set User-Agent in a browser environment', () => {
    const g = globalThis as { window?: unknown }
    g.window = {}
    try {
      const client = createClient({ baseUrl: BASE })
      expect(client.headers['User-Agent']).toBeUndefined()
      expect(client.headers[CLIENT_HEADER]).toBe(SDK_CLIENT_TOKEN)
    } finally {
      delete g.window
    }
  })
})
