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
})
