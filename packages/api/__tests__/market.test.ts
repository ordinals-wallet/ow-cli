import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as marketApi from '../src/market.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('market API', () => {
  it('should build purchase bulk', async () => {
    const result = await marketApi.buildPurchaseBulk({
      escrows: ['esc1', 'esc2'],
      pay_address: 'bc1ptest',
      receive_address: 'bc1ptest',
      public_key: '02abc',
      fee_rate: 20,
    })
    expect(result.setup).toBe('psbt_setup_hex')
    expect(result.purchase).toBe('psbt_purchase_hex')
  })

  it('should build purchase runes', async () => {
    const result = await marketApi.buildPurchaseRunes({
      outpoints: ['abc123:0'],
      pay_address: 'bc1ptest',
      receive_address: 'bc1ptest',
      public_key: '02abc',
      fee_rate: 20,
    })
    expect(result.setup).toBe('psbt_setup_hex')
    expect(result.purchase).toBe('psbt_purchase_hex')
  })

  it('should submit purchase', async () => {
    const result = await marketApi.submitPurchase({
      setup_rawtx: 'hex1',
      purchase_rawtx: 'hex2',
      wallet_type: 'ow-cli',
    })
    expect(result.success).toBe(true)
    expect(result.txid).toBe('purchase_txid')
  })

  it('should submit purchase rune', async () => {
    const result = await marketApi.submitPurchaseRune({
      rawtx: 'hex1',
      wallet_type: 'ow-cli',
    })
    expect(result.success).toBe(true)
    expect(result.txid).toBe('rune_purchase_txid')
  })

  it('should build escrow', async () => {
    const result = await marketApi.buildEscrow({
      inscription: 'abc123i0',
      from: 'bc1ptest',
      price: 50000,
      public_key: '02abc',
      dummy: false,
    })
    expect(result.psbt).toBe('escrow_psbt_hex')
  })

  it('should build escrow bulk', async () => {
    const result = await marketApi.buildEscrowBulk({
      inscriptions: ['abc123i0', 'def456i0'],
      from: 'bc1ptest',
      prices: [50000, 60000],
      public_key: '02abc',
    })
    expect(result.psbt).toBe('escrow_bulk_psbt_hex')
  })

  it('should submit escrow (via escrow-bulk endpoint)', async () => {
    const result = await marketApi.submitEscrow({
      psbt: 'signed_psbt_hex',
    })
    expect(result.success).toBe(true)
    expect(result.escrow_id).toBe('esc_123')
  })

  it('should cancel escrow', async () => {
    const result = await marketApi.cancelEscrow({
      inscription_id: 'abc123i0',
      signature: 'sig_hex',
    })
    expect(result.success).toBe(true)
  })

  it('should build purchase alkanes', async () => {
    const result = await marketApi.buildPurchaseAlkanes({
      outpoints: ['a'.repeat(64) + ':0'],
      pay_address: 'bc1ptest',
      receive_address: 'bc1ptest',
      public_key: '02abc',
      fee_rate: 20,
    })
    expect(result.psbt).toBe('alkane_purchase_psbt_hex')
  })

  it('should fetch a listing with its protection markers', async () => {
    const listing = await marketApi.getListing('a'.repeat(64) + 'i0')
    expect(listing?.protected).toBe(true)
    expect(listing?.satoshi_price).toBe(50000)
  })

  it('should return null for an inscription that is not listed', async () => {
    expect(await marketApi.getListing('0'.repeat(64) + 'i0')).toBeNull()
  })

  it('should fetch secure purchase capabilities', async () => {
    const caps = await marketApi.getSecurePurchaseCapabilities()
    expect(caps.escrow_policy).toBe('passthrough_v4')
    expect(caps.cosigner_public_key).toHaveLength(64)
  })

  it('should build a secure purchase with one sale per outpoint', async () => {
    const outpoints = ['c'.repeat(64) + ':0', 'd'.repeat(64) + ':1']
    const built = await marketApi.buildSecurePurchase({
      outpoints,
      protocol: 'ordinal',
      from: 'bc1ptest',
      public_key: '02abc',
      fee_rate: 20,
      wallet_type: 'ow-cli',
    })
    expect(built.policy).toBe('passthrough_v4')
    expect(built.sales.map((s) => s.parent.source_outpoint)).toEqual(outpoints)
  })

  it('should surface the build error code', async () => {
    await expect(
      marketApi.buildSecurePurchase({ outpoints: [], protocol: 'ordinal', from: 'bc1ptest', public_key: '02abc', fee_rate: 20 }),
    ).rejects.toMatchObject({ status: 400, code: 'no_outpoints', body: { code: 'no_outpoints' } })
  })

  it('should submit a secure purchase', async () => {
    const result = await marketApi.submitSecurePurchase({ sales: [{ sale_txid: 'a'.repeat(64), psbt: 'signed_psbt_hex' }] })
    expect(result.accepted).toBe(true)
    expect(result.txid).toBe('a'.repeat(64))
  })
})
