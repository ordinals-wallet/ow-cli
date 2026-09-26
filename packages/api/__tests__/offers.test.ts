import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './setup.js'
import { setClient } from '../src/client.js'
import * as offers from '../src/offers.js'
import {
  OfferError,
  OfferExpiredError,
  OfferNotActiveError,
  OfferItemMovedError,
  OfferNotOwnerError,
  OfferItemNotEligibleError,
  OfferAttemptPendingError,
  OfferUnauthorizedError,
  offerErrorFromCode,
} from '../src/offers.js'
import type { Offer } from '../src/types-offers.js'
import { OwApiError, isOwApiError } from '../src/errors.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

const B = 'https://turbo.ordinalswallet.com/market/offers'
const live = JSON.parse(readFileSync(new URL('../../../fixtures/api/offers-live.json', import.meta.url), 'utf8'))
const ID = '6f1c1a3e-7c4b-4f7a-9d55-2f5a0b1c9e11'
const INSC = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0'

// Shaped like offer_json(DBOffer) in ow-api.
const OFFER: Offer = {
  id: ID,
  scope: 'item',
  inscription_id: INSC,
  item_outpoint: '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799:0',
  item_value: 546,
  seller_address: 'bc1pseller',
  buyer_address: 'bc1pbuyer',
  buyer_payment_address: 'bc1pbuyer',
  collection_slug: null,
  trait_type: null,
  trait_value: null,
  price_sats: 250000,
  market_fee_sats: 6750,
  network_fee_sats: 3300,
  escrow_value: 260050,
  total_sats: 256750,
  state: 'active',
  message: null,
  funding_txid: 'ab'.repeat(32),
  funding_vout: 0,
  accepted_txid: null,
  cancel_txid: null,
  filled_inscription_id: null,
  recovery_delay_blocks: 1008,
  expires_at: '2026-10-03T00:00:00Z',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
}

describe('offer reads', () => {
  it('forCollection returns the live shape', async () => {
    server.use(http.get(`${B}/collection/bitmap`, () => HttpResponse.json(live.collection_bitmap)))
    const r = await offers.forCollection('bitmap')
    expect(r.slug).toBe('bitmap')
    expect(Object.keys(r.summary).sort()).toEqual(
      ['collection_count', 'count', 'item_count', 'top_collection_sats', 'top_price_sats', 'total_sats', 'trait_count'],
    )
    expect(r).toHaveProperty('trait_offers')
  })

  it('forWallet and forInscription return the live shape', async () => {
    server.use(
      http.get(`${B}/wallet/:address`, () => HttpResponse.json(live.wallet)),
      http.get(`${B}/inscription/:id`, ({ params }) =>
        params.id === INSC
          ? HttpResponse.json({ ...live.inscription, offers: [OFFER] })
          : HttpResponse.json(live.invalid_inscription, { status: 400 }),
      ),
    )
    expect(await offers.forWallet('bc1pabc')).toEqual({ received: [], sent: [] })
    const r = await offers.forInscription(INSC)
    expect(r.offers[0].total_sats).toBe(r.offers[0].price_sats + r.offers[0].market_fee_sats)
    expect(r.collection_offers).toEqual([])
    const err = await offers.forInscription('bad').catch((e) => e)
    expect(err).toBeInstanceOf(OfferError)
    expect(err.code).toBe('invalid_inscription_id')
    expect(err.status).toBe(400)
  })

  it('encodes path segments', async () => {
    let seen = ''
    server.use(http.get(`${B}/collection/:slug`, ({ request }) => ((seen = new URL(request.url).pathname), HttpResponse.json(live.collection_bitmap))))
    await offers.forCollection('a b/c')
    expect(seen).toBe('/market/offers/collection/a%20b%2Fc')
  })
})

describe('offer writes hit the right routes with the right bodies', () => {
  function capture(method: 'post' | 'get', path: string, response: unknown) {
    const seen: { body?: unknown; url?: string } = {}
    server.use(
      http[method](`${B}${path}`, async ({ request }) => {
        seen.url = request.url
        if (method === 'post') seen.body = await request.json()
        return HttpResponse.json(response)
      }),
    )
    return seen
  }

  it('build → prepare → activate', async () => {
    const b = capture('post', '/build', { offer_id: ID, funding_psbt: '70736274ff' })
    await offers.build({
      inscription_id: INSC,
      buyer_address: 'bc1pbuyer',
      buyer_public_key: '02' + '11'.repeat(32),
      buyer_payment_address: 'bc1pbuyer',
      buyer_payment_public_key: '02' + '11'.repeat(32),
      price_sats: 250000,
      fee_rate: 10,
    })
    expect(b.body).toMatchObject({ inscription_id: INSC, price_sats: 250000, fee_rate: 10 })

    const p = capture('post', `/${ID}/prepare`, { offer_id: ID, sign_input_index: 1, sighash: 1 })
    const prep = await offers.prepare(ID, 'signedfunding')
    expect(p.body).toEqual({ funding_psbt: 'signedfunding' })
    expect(prep.sighash).toBe(1)

    const a = capture('post', `/${ID}/activate`, { offer: OFFER, funding_txid: 'ab'.repeat(32) })
    await offers.activate(ID, { funding_psbt: 'f', accept_psbt: 'a' })
    expect(a.body).toEqual({ funding_psbt: 'f', accept_psbt: 'a' })
  })

  it('accept / fill', async () => {
    const ba = capture('post', `/${ID}/build-accept`, { offer: OFFER, accept_psbt: 'x', sign_input_index: 0, sighash: 1 })
    await offers.buildAccept(ID, { seller_address: 'bc1pseller', seller_public_key: '02aa' })
    expect(ba.body).toEqual({ seller_address: 'bc1pseller', seller_public_key: '02aa' })
    const ac = capture('post', `/${ID}/accept`, { offer_id: ID, txid: 'cd'.repeat(32), state: 'accepted' })
    expect((await offers.accept(ID, { seller_address: 'bc1pseller', signed_psbt: 's' })).state).toBe('accepted')
    expect(ac.body).toEqual({ seller_address: 'bc1pseller', signed_psbt: 's' })

    const bf = capture('post', `/${ID}/build-fill`, { offer: OFFER, fill_psbt: 'x', miner_fee_sats: 3300 })
    await offers.buildFill(ID, { seller_address: 'bc1pseller', inscription_id: INSC })
    expect(bf.body).toEqual({ seller_address: 'bc1pseller', inscription_id: INSC })
    const fl = capture('post', `/${ID}/fill`, { offer_id: ID, txid: 'cd'.repeat(32), state: 'accepted', inscription_id: INSC })
    await offers.fill(ID, { seller_address: 'bc1pseller', inscription_id: INSC, signed_psbt: 's' })
    expect(fl.body).toEqual({ seller_address: 'bc1pseller', inscription_id: INSC, signed_psbt: 's' })
  })

  it('reject sends the session token in `signature`', async () => {
    const r = capture('post', `/${ID}/reject`, { offer_id: ID, state: 'rejected' })
    const res = await offers.reject(ID, { address: 'bc1pseller', token: 'ows1.abc.def' })
    expect(r.body).toEqual({ address: 'bc1pseller', signature: 'ows1.abc.def' })
    expect(res.state).toBe('rejected')
  })

  it('cancel and reconcile', async () => {
    const bc = capture('post', `/${ID}/build-cancel`, { offer_id: ID, cancel_psbt: 'x', sighash: 1, fee_rate: 3 })
    await offers.buildCancel(ID, { buyer_address: 'bc1pbuyer', fee_rate: 3 })
    expect(bc.body).toEqual({ buyer_address: 'bc1pbuyer', fee_rate: 3 })
    const c = capture('post', `/${ID}/cancel`, { offer_id: ID, txid: 'ef'.repeat(32), state: 'cancelled' })
    await offers.cancel(ID, { buyer_address: 'bc1pbuyer', signed_psbt: 's' })
    expect(c.body).toEqual({ buyer_address: 'bc1pbuyer', signed_psbt: 's' })

    const r1 = capture('get', `/${ID}/reconcile`, { offer: OFFER })
    await offers.reconcile(ID)
    expect(new URL(r1.url!).search).toBe('')
    const r2 = capture('get', `/${ID}/reconcile`, { offer: { ...OFFER, state: 'cancelled' } })
    const out = await offers.reconcile(ID, 'ef'.repeat(32))
    expect(new URL(r2.url!).searchParams.get('txid')).toBe('ef'.repeat(32))
    expect(out.offer.state).toBe('cancelled')
  })
})

describe('offer error codes', () => {
  const cases: [string, new (...a: never[]) => OfferError][] = [
    ['offer_expired', OfferExpiredError],
    ['offer_not_active', OfferNotActiveError],
    ['item_moved', OfferItemMovedError],
    ['stale', OfferItemMovedError],
    ['not_the_owner', OfferNotOwnerError],
    ['item_not_eligible', OfferItemNotEligibleError],
    ['offer_attempt_pending', OfferAttemptPendingError],
    ['unauthorized', OfferUnauthorizedError],
  ]
  for (const [code, Cls] of cases) {
    it(`${code} → ${Cls.name}`, async () => {
      server.use(http.post(`${B}/:id/accept`, () => HttpResponse.json({ error: true, code }, { status: 409 })))
      const err = await offers.accept(ID, { seller_address: 'x', signed_psbt: 'y' }).catch((e) => e)
      expect(err).toBeInstanceOf(Cls)
      expect(err).toBeInstanceOf(OfferError)
      expect(err).toBeInstanceOf(OwApiError)
      expect(isOwApiError(err)).toBe(true)
      expect(err.name).toBe(Cls.name)
      expect(err.code).toBe(code)
      expect(err.status).toBe(409)
      expect(err.body).toEqual({ error: true, code })
    })
  }

  it('signing/submit POSTs are never retried', async () => {
    let calls = 0
    server.use(http.post(`${B}/:id/accept`, () => (calls++, HttpResponse.json({ error: true, code: 'broadcast_failed' }, { status: 503 }))))
    const err = await offers.accept(ID, { seller_address: 'x', signed_psbt: 'y' }).catch((e) => e)
    expect(err.code).toBe('broadcast_failed')
    expect(calls).toBe(1)
  })

  it('unknown codes become a plain OfferError', () => {
    const e = offerErrorFromCode('broadcast_rejected', 400)
    expect(e.constructor).toBe(OfferError)
    expect(e.code).toBe('broadcast_rejected')
  })

  it('live 404 reconcile maps to offer_not_found', async () => {
    server.use(http.get(`${B}/:id/reconcile`, () => HttpResponse.json(live.reconcile_not_found, { status: 404 })))
    const err = await offers.reconcile('00000000-0000-0000-0000-000000000000').catch((e) => e)
    expect(err.code).toBe('offer_not_found')
  })
})
