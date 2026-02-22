import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as walletApi from '../src/wallet.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('wallet API', () => {
  it('should get wallet info', async () => {
    const info = await walletApi.getWallet('bc1ptest')
    expect(info.balance).toBe(100000)
    expect(info.utxo_count).toBe(2)
    expect(info.unconfirmed_balance).toBe(0)
    expect(info.confirmed_balance).toBe(100000)
    expect(info.inscription_balance).toBe(0)
    expect(info.frozen_balance).toBe(0)
    expect(info.inscriptions).toHaveLength(1)
    expect(info.inscriptions[0].id).toBe('abc123i0')
  })

  it('should get UTXOs', async () => {
    const utxos = await walletApi.getUtxos('bc1ptest')
    expect(utxos).toHaveLength(1)
    expect(utxos[0].txid).toBe('abc123')
  })

  it('should get rune balances', async () => {
    const runes = await walletApi.getRuneBalance('bc1ptest')
    expect(runes).toHaveLength(1)
    expect(runes[0].name).toBe('TESTRUNESTONE')
    expect(runes[0].rune_id).toBe('100:1')
    expect(runes[0].amount).toBe('1000')
    expect(runes[0].symbol).toBe('T')
    expect(runes[0].divisibility).toBe(0)
  })

  it('should get BRC-20 balances', async () => {
    const brc20 = await walletApi.getBrc20Balance('bc1ptest')
    expect(brc20).toHaveLength(1)
    expect(brc20[0].ticker).toBe('ORDI')
    expect(brc20[0].overall_balance).toBe('100.00')
    expect(brc20[0].available_balance).toBe('80.00')
    expect(brc20[0].transferable_balance).toBe('20.00')
  })

  it('should get alkanes balances', async () => {
    const alkanes = await walletApi.getAlkanesBalance('bc1ptest')
    expect(alkanes).toHaveLength(1)
    expect(alkanes[0].id).toBe('alk1')
    expect(alkanes[0].balance).toBe('500')
    expect(alkanes[0].rune_id).toBe('200:1')
  })

  it('should get inscription detail', async () => {
    const ins = await walletApi.getInscription('abc123i0')
    expect(ins.id).toBe('abc123i0')
    expect(ins.num).toBe(1)
    expect(ins.content_type).toBe('image/png')
    expect(ins.content_length).toBe(12345)
    expect(ins.genesis_height).toBe(800000)
    expect(ins.genesis_fee).toBe(5000)
    expect(ins.sat).toEqual({ value: 1234567890, rarity: 'common' })
    expect(ins.meta?.name).toBe('Test Inscription')
    expect(ins.collection?.slug).toBe('test-collection')
  })

  it('should get fee estimates', async () => {
    const fees = await walletApi.getFeeEstimates()
    expect(fees.fastestFee).toBe(50)
    expect(fees.halfHourFee).toBe(30)
    expect(fees.hourFee).toBe(20)
    expect(fees.minimumFee).toBe(5)
  })

  it('should broadcast transaction', async () => {
    const result = await walletApi.broadcast('rawtxhex')
    expect(result.success).toBe(true)
    expect(result.txid).toBe('broadcasted_txid')
  })

  it('should build consolidate', async () => {
    const result = await walletApi.buildConsolidate({
      outputs: [['bc1ptest', 50000]],
      public_key: '02abc',
      from: 'bc1ptest',
      fee_rate: 20,
      utxos: [['a'.repeat(64), 0, 30000], ['b'.repeat(64), 1, 20000]],
    })
    expect(result.psbt).toBe('consolidate_psbt_hex')
    expect(result.fees).toBe(1500)
  })

  it('should broadcast bulk', async () => {
    const result = await walletApi.broadcastBulk(['rawtx1', 'rawtx2'])
    expect(result.txids).toEqual(['txid1', 'txid2'])
  })
})
