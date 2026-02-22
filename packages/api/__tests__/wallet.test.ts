import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as walletApi from '../src/wallet.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('wallet API', () => {
  it('should get wallet info', async () => {
    const info = await walletApi.getWallet('bc1ptest')
    expect(info.balance).toBe(100000)
    expect(info.utxo_count).toBe(2)
  })

  it('should get UTXOs', async () => {
    const utxos = await walletApi.getUtxos('bc1ptest')
    expect(utxos).toHaveLength(1)
    expect(utxos[0].txid).toBe('abc123')
  })

  it('should get rune balances', async () => {
    const runes = await walletApi.getRuneBalance('bc1ptest')
    expect(runes).toHaveLength(1)
    expect(runes[0].rune).toBe('TESTRUNESTONE')
  })

  it('should get fee estimates', async () => {
    const fees: any = await walletApi.getFeeEstimates()
    expect(fees.fastest).toBe(50)
    expect(fees.minimum).toBe(5)
  })

  it('should broadcast transaction', async () => {
    const result = await walletApi.broadcast('rawtxhex')
    expect(result.success).toBe(true)
    expect(result.txid).toBe('broadcasted_txid')
  })
})
