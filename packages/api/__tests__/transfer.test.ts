import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as transferApi from '../src/transfer.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('transfer API', () => {
  it('should build send', async () => {
    const result = await transferApi.buildSend({
      from: 'bc1ptest',
      to: 'bc1preceiver',
      amount: 10000,
      fee_rate: 20,
      public_key: '02abc',
    })
    expect(result.psbt).toBe('send_psbt_hex')
  })

  it('should build inscription send', async () => {
    const result = await transferApi.buildInscriptionSend({
      inscription_id: 'abc123i0',
      from: 'bc1ptest',
      to: 'bc1preceiver',
      fee_rate: 20,
      public_key: '02abc',
    })
    expect(result.psbt).toBe('inscription_send_psbt_hex')
  })

  it('should build rune transfer', async () => {
    const result = await transferApi.buildRuneTransfer({
      from: 'bc1ptest',
      to: 'bc1preceiver',
      rune: 'TESTRUNESTONE',
      amount: '100',
      fee_rate: 20,
      public_key: '02abc',
    })
    expect(result.psbt).toBe('rune_transfer_psbt_hex')
  })
})
