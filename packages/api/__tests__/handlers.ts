import { http, HttpResponse } from 'msw'
// Fixtures are real, trimmed responses from turbo.ordinalswallet.com (GET only).
import walletFx from './fixtures/wallet.json' with { type: 'json' }
import walletInscriptionsFx from './fixtures/wallet-inscriptions.json' with { type: 'json' }
import walletBalanceFx from './fixtures/wallet-balance.json' with { type: 'json' }
import alkanesBalanceFx from './fixtures/alkanes-balance.json' with { type: 'json' }
import alkanesOutpointsFx from './fixtures/alkanes-outpoints.json' with { type: 'json' }
import runeBalanceFx from './fixtures/rune-balance.json' with { type: 'json' }
import brc20BalanceFx from './fixtures/brc20-balance.json' with { type: 'json' }
import inscriptionFx from './fixtures/inscription.json' with { type: 'json' }
import inscriptionOutpointFx from './fixtures/inscription-outpoint.json' with { type: 'json' }
import collectionFx from './fixtures/collection.json' with { type: 'json' }
import collectionStatsFx from './fixtures/collection-stats.json' with { type: 'json' }
import escrowsFx from './fixtures/escrows.json' with { type: 'json' }
import soldEscrowsFx from './fixtures/sold-escrows.json' with { type: 'json' }
import searchCollectionsFx from './fixtures/search-collections.json' with { type: 'json' }
import searchUrlFx from './fixtures/search-url.json' with { type: 'json' }

const BASE = 'https://turbo.ordinalswallet.com'

export const handlers = [
  // Specific wallet POST routes MUST come before the wildcard /wallet/:address
  http.post(`${BASE}/wallet/broadcast`, () => {
    return HttpResponse.json({ txid: 'broadcasted_txid', success: true })
  }),

  http.post(`${BASE}/wallet/purchase-bulk`, () => {
    return HttpResponse.json({ setup: 'psbt_setup_hex', purchase: 'psbt_purchase_hex' })
  }),

  http.post(`${BASE}/wallet/secure-purchase/build`, async ({ request }) => {
    const body = (await request.json()) as { outpoints?: string[] }
    if (!body.outpoints?.length) {
      return HttpResponse.json({ error: true, code: 'no_outpoints', message: 'Select at least one item' }, { status: 400 })
    }
    return HttpResponse.json({
      version: 4,
      policy: 'passthrough_v4',
      sale_txid: 'a'.repeat(64),
      sales: body.outpoints.map((outpoint, i) => ({
        sale_txid: 'a'.repeat(64),
        chain_index: i,
        psbt: 'sale_psbt_hex',
        parent: { txid: 'b'.repeat(64), raw: 'parent_raw_hex', source_outpoint: outpoint },
      })),
    })
  }),

  http.post(`${BASE}/market/secure-purchase/submit`, () => {
    return HttpResponse.json({ accepted: true, txid: 'a'.repeat(64), state: 'broadcast' })
  }),

  http.get(`${BASE}/market/secure-purchase/capabilities`, () => {
    return HttpResponse.json({
      secure_purchase: {
        version: 2,
        escrow_policy: 'passthrough_v4',
        build_enabled: true,
        submit_enabled: true,
        cosigner_public_key: '1d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7dee',
      },
    })
  }),

  http.get(`${BASE}/market/escrow/:id`, ({ params }) => {
    if (String(params.id).startsWith('0')) {
      return HttpResponse.json({ error: true, message: 'not found' }, { status: 404 })
    }
    return HttpResponse.json({
      inscription_id: params.id,
      outpoint: 'c'.repeat(64) + ':0',
      seller_address: 'bc1pseller',
      satoshi_price: 50000,
      secure_purchase_version: 2,
      secure_purchase_state: 'listed',
      protected: true,
    })
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

  http.get(`${BASE}/wallet/:address/inscriptions`, () => HttpResponse.json(walletInscriptionsFx)),

  http.get(`${BASE}/wallet/:address/balance`, () => HttpResponse.json(walletBalanceFx)),

  http.get(`${BASE}/wallet/:address/rune-balance`, () => HttpResponse.json(runeBalanceFx)),

  http.get(`${BASE}/wallet/:address/brc20-balance`, () => HttpResponse.json(brc20BalanceFx)),

  http.get(`${BASE}/wallet/:address/alkanes-balance`, () => HttpResponse.json(alkanesBalanceFx)),

  http.get(`${BASE}/wallet/:address/alkanes-outpoints/:id`, () => HttpResponse.json(alkanesOutpointsFx)),

  // Inscription location (must be before /inscription/:id)
  http.get(`${BASE}/inscription/:id/outpoint`, () => HttpResponse.json(inscriptionOutpointFx)),

  // Inscription detail
  http.get(`${BASE}/inscription/:id`, () => HttpResponse.json(inscriptionFx)),

  // Wildcard wallet address route (must be AFTER all specific /wallet/* GET routes)
  http.get(`${BASE}/wallet/:address`, ({ params }) => {
    if (params.address === 'notanaddress') {
      return HttpResponse.json({ error: true, message: 'Invalid Address' }, { status: 400 })
    }
    return HttpResponse.json(walletFx)
  }),

  // Collection
  http.get(`${BASE}/collection/:slug/escrows`, () => HttpResponse.json(escrowsFx)),

  http.get(`${BASE}/collection/:slug/sold-escrows`, ({ request }) => {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit') ?? 100)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return HttpResponse.json(soldEscrowsFx.slice(offset, offset + limit))
  }),

  http.get(`${BASE}/collection/:slug/stats`, () => HttpResponse.json(collectionStatsFx)),

  http.get(`${BASE}/collection/:slug`, ({ params }) => {
    if (params.slug !== collectionFx.slug) {
      // Live API: 404 with a JSON error body for unknown slugs.
      return HttpResponse.json(
        { error: true, message: 'no rows returned by a query that expected to return at least one row' },
        { status: 404 },
      )
    }
    return HttpResponse.json(collectionFx)
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

  // Search: free text -> {collections}, address/id -> {url}, no match -> 404
  http.get(`${BASE}/v2/search/:input`, ({ params }) => {
    const input = String(params.input)
    if (input.startsWith('bc1')) return HttpResponse.json(searchUrlFx)
    if (input === 'zzqqxxnomatch123') {
      return HttpResponse.json({ error: true, message: 'not found' }, { status: 404 })
    }
    return HttpResponse.json(searchCollectionsFx)
  }),
]
