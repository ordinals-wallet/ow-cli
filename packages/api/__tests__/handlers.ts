import { http, HttpResponse } from 'msw'

const BASE = 'https://turbo.ordinalswallet.com'

export const handlers = [
  // Specific wallet POST routes MUST come before the wildcard /wallet/:address
  http.post(`${BASE}/wallet/broadcast`, () => {
    return HttpResponse.json({ txid: 'broadcasted_txid', success: true })
  }),

  http.post(`${BASE}/wallet/purchase`, () => {
    return HttpResponse.json({ setup: 'psbt_setup_hex', purchase: 'psbt_purchase_hex' })
  }),

  http.post(`${BASE}/wallet/purchase-bulk`, () => {
    return HttpResponse.json({ setup: 'psbt_setup_hex', purchase: 'psbt_purchase_hex' })
  }),

  http.post(`${BASE}/wallet/purchase-bulk-runes`, () => {
    return HttpResponse.json({ setup: 'psbt_setup_hex', purchase: 'psbt_purchase_hex' })
  }),

  http.post(`${BASE}/wallet/escrow`, () => {
    return HttpResponse.json({ psbt: 'escrow_psbt_hex' })
  }),

  http.post(`${BASE}/wallet/send`, () => {
    return HttpResponse.json({ psbt: 'send_psbt_hex' })
  }),

  http.post(`${BASE}/wallet/inscription/send`, () => {
    return HttpResponse.json({ psbt: 'inscription_send_psbt_hex' })
  }),

  http.get(`${BASE}/wallet/fee-estimates`, () => {
    return HttpResponse.json({
      fastest: 50,
      halfHour: 30,
      hour: 20,
      economy: 10,
      minimum: 5,
    })
  }),

  http.get(`${BASE}/wallet/:address/utxos`, () => {
    return HttpResponse.json([
      { txid: 'abc123', vout: 0, value: 50000, status: { confirmed: true } },
    ])
  }),

  http.get(`${BASE}/wallet/:address/inscriptions`, () => {
    return HttpResponse.json([
      { id: 'abc123i0', number: 1, content_type: 'image/png' },
    ])
  }),

  http.get(`${BASE}/wallet/:address/rune-balance`, () => {
    return HttpResponse.json([
      { rune: 'TESTRUNESTONE', balance: '1000', symbol: 'T' },
    ])
  }),

  http.get(`${BASE}/wallet/:address/alkanes-balance`, () => {
    return HttpResponse.json([])
  }),

  // Wildcard wallet address route (must be AFTER all specific /wallet/* GET routes)
  http.get(`${BASE}/wallet/:address`, () => {
    return HttpResponse.json({
      balance: 100000,
      unconfirmed_balance: 0,
      confirmed_balance: 100000,
      inscription_balance: 0,
      frozen_balance: 0,
      utxo_count: 2,
      inscriptions: [
        { id: 'abc123i0', num: 1, content_type: 'image/png', meta: { name: 'Test' } },
      ],
      brc20: [],
    })
  }),

  // Collection
  http.get(`${BASE}/collection/:slug/escrows`, () => {
    return HttpResponse.json([
      { id: 'esc1', inscription_id: 'abc123i0', price: 50000, seller: 'bc1ptest' },
    ])
  }),

  http.get(`${BASE}/collection/:slug/sold-escrows`, () => {
    return HttpResponse.json([])
  }),

  http.get(`${BASE}/collection/:slug/stats`, () => {
    return HttpResponse.json({
      floor_price: 50000,
      total_volume: 1000000,
      listed_count: 10,
    })
  }),

  http.get(`${BASE}/collection/:slug`, ({ params }) => {
    return HttpResponse.json({
      slug: params.slug,
      name: 'Test Collection',
      description: 'A test',
      image_url: 'https://example.com/img.png',
      banner_url: 'https://example.com/banner.png',
      supply: 100,
    })
  }),

  // Market
  http.post(`${BASE}/market/purchase`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE}/market/purchase-rune`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE}/market/escrow`, () => {
    return HttpResponse.json({ success: true })
  }),

  http.post(`${BASE}/market/cancel-escrow`, () => {
    return HttpResponse.json({ success: true })
  }),

  // Inscribe
  http.post(`${BASE}/inscribe/estimate`, () => {
    return HttpResponse.json({ total_fees: 5000, inscription_fee: 4000, postage: 546 })
  }),

  // Transfer
  http.post(`${BASE}/rune/transfer`, () => {
    return HttpResponse.json({ psbt: 'rune_transfer_psbt_hex' })
  }),

  // Search
  http.get(`${BASE}/v2/search/:input`, () => {
    return HttpResponse.json({
      collections: [{ slug: 'test', name: 'Test' }],
      inscriptions: [],
      addresses: [],
    })
  }),
]
