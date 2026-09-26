import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setClient } from '../src/client.js'
import * as secureListing from '../src/secure-listing.js'
import * as securePurchase from '../src/secure-purchase.js'
import { server } from './setup.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })
const BASE = 'https://turbo.ordinalswallet.com'
const OUTPOINT = `${'ab'.repeat(32)}:0`

describe('secure listing API', () => {
  it('posts the bulk build payload and returns rows as-is', async () => {
    let body: unknown
    server.use(
      http.post(`${BASE}/market/secure-listing/build-bulk`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ version: 4, policy: 'passthrough_v4', items: [{ outpoint: OUTPOINT, error: true, code: 'postage_too_small' }] })
      }),
    )
    const res = await secureListing.buildBulk({
      protocol: 'ordinal',
      seller_address: 'bc1pseller',
      seller_public_key: '02'.padEnd(66, '1'),
      items: [{ outpoint: OUTPOINT, escrow_price_sats: 50_000 }],
    })
    expect(body).toMatchObject({ protocol: 'ordinal', items: [{ outpoint: OUTPOINT, escrow_price_sats: 50_000 }] })
    expect(res.items[0]).toMatchObject({ error: true, code: 'postage_too_small' })
  })

  it('normalizes a single-item authorize refusal to one row', async () => {
    server.use(
      http.post(`${BASE}/market/secure-listing/authorize-bulk`, () =>
        HttpResponse.json({ outpoint: OUTPOINT, error: true, code: 'template_digest_mismatch' }, { status: 400 })),
    )
    const res = await secureListing.authorizeBulk([
      { outpoint: OUTPOINT, protocol: 'ordinal', seller_public_key: '02', template_digest: '00', psbt: 'p', sale_psbt: 's' },
    ])
    expect(res.items).toEqual([{ outpoint: OUTPOINT, error: true, code: 'template_digest_mismatch' }])
  })

  it('throws request-level authorize refusals with their code', async () => {
    server.use(
      http.post(`${BASE}/market/secure-listing/authorize-bulk`, () =>
        HttpResponse.json({ error: true, code: 'invalid_batch_size', message: 'Select between 1 and 100 items' }, { status: 400 })),
    )
    await expect(
      secureListing.authorizeBulk([{ outpoint: OUTPOINT, protocol: 'ordinal', seller_public_key: '02', template_digest: '00', psbt: 'p', sale_psbt: 's' }]),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_batch_size', body: { code: 'invalid_batch_size' } })
  })

  it('reads listing status and returns null when there is none', async () => {
    server.use(
      http.get(`${BASE}/market/secure-listing/:outpoint`, ({ params }) =>
        params.outpoint === OUTPOINT
          ? HttpResponse.json({ secure_listing: { version: 2, state: 'listed', outpoint: OUTPOINT, protocol: 'ordinal', policy: 'passthrough_v4' } })
          : HttpResponse.json({ error: true, message: 'secure listing not found' }, { status: 404 })),
    )
    expect((await secureListing.status(OUTPOINT))?.state).toBe('listed')
    expect(await secureListing.status(`${'cd'.repeat(32)}:0`)).toBeNull()
  })

  it('posts recovery requests', async () => {
    let body: unknown
    server.use(
      http.post(`${BASE}/market/secure-listing/recover`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ version: 4, psbt: 'recovery_psbt', recovery_txid: 'e'.repeat(64), fee: 282 })
      }),
    )
    const res = await secureListing.recover({ passthrough_txid: 'f'.repeat(64), fee_rate: 2 })
    expect(body).toEqual({ passthrough_txid: 'f'.repeat(64), fee_rate: 2 })
    expect(res.psbt).toBe('recovery_psbt')
  })

  it('exposes purchase capabilities', async () => {
    const caps = await securePurchase.capabilities()
    expect(caps.cosigner_public_key).toBe('1d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7dee')
  })
})
