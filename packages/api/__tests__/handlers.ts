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

  http.post(`${BASE}/wallet/escrow-bulk`, () => {
    return HttpResponse.json({ psbt: 'escrow_bulk_psbt_hex' })
  }),

  http.post(`${BASE}/wallet/send`, () => {
    return HttpResponse.json({ psbt: 'send_psbt_hex' })
  }),

  http.post(`${BASE}/wallet/inscription/send`, () => {
    return HttpResponse.json({ psbt: 'inscription_send_psbt_hex' })
  }),

  http.post(`${BASE}/wallet/build`, () => {
    return HttpResponse.json({ psbt: 'consolidate_psbt_hex', fees: 1500 })
  }),

  http.post(`${BASE}/wallet/purchase-bulk-alkanes`, () => {
    return HttpResponse.json({ psbt: 'alkane_purchase_psbt_hex' })
  }),

  http.post(`${BASE}/wallet/broadcast-bulk`, () => {
    return HttpResponse.json({ txids: ['txid1', 'txid2'] })
  }),

  http.get(`${BASE}/wallet/fee-estimates`, () => {
    return HttpResponse.json({
      fastestFee: 50,
      halfHourFee: 30,
      hourFee: 20,
      economyFee: 10,
      minimumFee: 5,
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
      { name: 'TESTRUNESTONE', rune_id: '100:1', amount: '1000', symbol: 'T', divisibility: 0 },
    ])
  }),

  http.get(`${BASE}/wallet/:address/brc20-balance`, () => {
    return HttpResponse.json([
      {
        ticker: 'ORDI',
        overall_balance: '100.00',
        available_balance: '80.00',
        transferable_balance: '20.00',
      },
    ])
  }),

  http.get(`${BASE}/wallet/:address/alkanes-balance`, () => {
    return HttpResponse.json([
      {
        rune_id: '200:1',
        id: 'alk1',
        outpoint: 'abc123:0',
        amount: '500',
        balance: '500',
        address: 'bc1ptest',
        sats: 546,
      },
    ])
  }),

  // Inscription detail
  http.get(`${BASE}/inscription/:id`, () => {
    return HttpResponse.json({
      id: 'abc123i0',
      num: 1,
      content_type: 'image/png',
      content_length: 12345,
      genesis_height: 800000,
      genesis_fee: 5000,
      sat: { value: 1234567890, rarity: 'common' },
      meta: { name: 'Test Inscription' },
      collection: { slug: 'test-collection', name: 'Test Collection' },
    })
  }),

  // Wildcard wallet address route (must be AFTER all specific /wallet/* GET routes)
  http.get(`${BASE}/wallet/:address`, () => {
    return HttpResponse.json({
      address: 'bc1ptest',
      balance: 100000,
      unconfirmed_balance: 0,
      confirmed_balance: 100000,
      inscription_balance: 0,
      frozen_balance: 0,
      inscription_count: 1,
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
      {
        id: 'esc1',
        inscription_id: 'abc123i0',
        name: 'Test #1',
        satoshi_price: 50000,
        price: 50000,
        seller_address: 'bc1ptest',
      },
    ])
  }),

  http.get(`${BASE}/collection/:slug/sold-escrows`, () => {
    return HttpResponse.json([
      {
        id: 'sold1',
        inscription_id: 'def456i0',
        name: 'Test #2',
        satoshi_price: 60000,
        price: 60000,
        buyer_address: 'bc1pbuyer',
      },
    ])
  }),

  http.get(`${BASE}/collection/:slug/stats`, () => {
    return HttpResponse.json({
      floor_price: 50000,
      total_volume: 1000000,
      total_supply: 100,
      listed_count: 10,
      listed: 10,
      sales: 50,
      owners: 42,
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
    return HttpResponse.json({ success: true, txid: 'purchase_txid' })
  }),

  http.post(`${BASE}/market/purchase-rune`, () => {
    return HttpResponse.json({ success: true, txid: 'rune_purchase_txid' })
  }),

  http.post(`${BASE}/market/escrow-bulk`, () => {
    return HttpResponse.json({ success: true, escrow_id: 'esc_123' })
  }),

  http.post(`${BASE}/market/cancel-escrow`, () => {
    return HttpResponse.json({ success: true })
  }),

  // Inscribe
  http.post(`${BASE}/inscribe/estimate`, () => {
    return HttpResponse.json({
      total_fees: 5000,
      inscription_fee: 4000,
      postage: 546,
      network_fee: 1000,
      base_fee: 500,
      size_fee: 3500,
      total_cost: 5546,
    })
  }),

  http.post(`${BASE}/inscribe/upload`, () => {
    return HttpResponse.json({
      inscription_id: 'newinscription123i0',
      txid: 'upload_txid',
      success: true,
    })
  }),

  // Transfer
  http.post(`${BASE}/rune/transfer`, () => {
    return HttpResponse.json({ psbt: 'rune_transfer_psbt_hex' })
  }),

  http.post(`${BASE}/alkane/transfer`, () => {
    return HttpResponse.json({ psbt: 'alkane_transfer_psbt_hex' })
  }),

  // Search
  http.get(`${BASE}/v2/search/:input`, () => {
    return HttpResponse.json({
      collections: [{ slug: 'test', name: 'Test', icon: 'https://example.com/icon.png' }],
      inscriptions: [],
      addresses: [],
    })
  }),
]
