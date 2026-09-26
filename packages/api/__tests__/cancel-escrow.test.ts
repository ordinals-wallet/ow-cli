import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setClient } from '../src/client.js'
import * as marketApi from '../src/market.js'
import { isOwApiError } from '../src/errors.js'
import { server } from './setup.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })
const BASE = 'https://turbo.ordinalswallet.com'
const OUTPOINT = `${'ab'.repeat(32)}:0`
const ID = `${'cd'.repeat(32)}i0`

function capture() {
  const bodies: unknown[] = []
  server.use(
    http.post(`${BASE}/market/cancel-escrow`, async ({ request }) => {
      bodies.push(await request.json())
      return HttpResponse.json({
        success: true,
        transition: 'cancelled',
        listing: { escrow_id: 'e1', secure_v2: true, previous_state: 'listed', state: 'cancelled' },
      })
    }),
  )
  return bodies
}

describe('market.cancelEscrow', () => {
  it('sends only the outpoint for an outpoint-keyed cancel', async () => {
    const bodies = capture()
    const res = await marketApi.cancelEscrow({ outpoint: OUTPOINT, signature: 'aa' })
    expect(bodies).toEqual([{ outpoint: OUTPOINT, signature: 'aa' }])
    expect(res.transition).toBe('cancelled')
    expect(res.listing?.secure_v2).toBe(true)
  })

  it('sends only the inscription id for an inscription-keyed cancel', async () => {
    const bodies = capture()
    await marketApi.cancelEscrow({ inscription_id: ID, signature: 'bb' })
    expect(bodies).toEqual([{ inscription_id: ID, signature: 'bb' }])
  })

  it('refuses both or neither identifier before any request', async () => {
    const bodies = capture()
    await expect(marketApi.cancelEscrow({ outpoint: OUTPOINT, inscription_id: ID, signature: 'aa' } as never)).rejects.toThrow(TypeError)
    await expect(marketApi.cancelEscrow({ signature: 'aa' } as never)).rejects.toThrow(TypeError)
    expect(bodies).toHaveLength(0)
  })

  it('surfaces the server code on refusal and is not retried', async () => {
    let calls = 0
    server.use(
      http.post(`${BASE}/market/cancel-escrow`, () => {
        calls += 1
        return HttpResponse.json(
          { error: true, code: 'listing_cancellation_unavailable', message: 'Listing cancellation is temporarily unavailable.' },
          { status: 503 },
        )
      }),
    )
    const err = await marketApi.cancelEscrow({ outpoint: OUTPOINT, signature: 'aa' }).catch((e) => e)
    expect(isOwApiError(err)).toBe(true)
    expect(err.status).toBe(503)
    expect(err.code).toBe('listing_cancellation_unavailable')
    expect(calls).toBe(1)
  })
})
