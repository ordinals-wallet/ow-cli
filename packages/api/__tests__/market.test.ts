import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as marketApi from '../src/market.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('market API', () => {
  it('should build purchase', async () => {
    const result = await marketApi.buildPurchase({
      inscription_id: 'abc123i0',
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

  it('should cancel escrow', async () => {
    const result = await marketApi.cancelEscrow({
      inscription_id: 'abc123i0',
      signature: 'sig_hex',
    })
    expect(result.success).toBe(true)
  })
})
