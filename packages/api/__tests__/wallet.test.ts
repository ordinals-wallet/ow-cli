import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as walletApi from '../src/wallet.js'
import { outpointToTxidVout } from '../src/outpoint.js'
import { isOwApiError } from '../src/errors.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('wallet API', () => {
  it('should get wallet info (live shape)', async () => {
    const info = await walletApi.getWallet('bc1ptest')
    expect(info.balance).toBe(412915)
    expect(info.utxo_count).toBe(4)
    expect(info.unconfirmed_balance).toBe(0)
    expect(info.confirmed_balance).toBe(412915)
    expect(info.inscription_balance).toBe(160498)
    expect(info.frozen_balance).toBe(196216)
    expect(info.private_pending_net).toBe(0)
    expect(info.address).toBeUndefined()
    expect(info.inscriptions).toHaveLength(2)
    const [plain, listed] = info.inscriptions
    expect(plain.id).toBe('1555c13da9831fb6de7c8c9283b4c64447d8704562ef8cbb5f5726074442fad2i0')
    expect(plain.escrow).toBeNull()
    // outpoint is an object carrying the 72-hex serialized outpoint
    expect(plain.outpoint).toEqual({
      outpoint: '70149b8954783f0996e4bf01582bc74bdb78c93aa3b2d4ae70fb2965170b9ea200000000',
      sat_offset: 0,
      sats: 1324,
    })
    expect(outpointToTxidVout(plain.outpoint!.outpoint)).toBe(
      'a29e0b176529fb70aed4b2a33ac978db4bc72b5801bfe496093f7854899b1470:0',
    )
    expect(listed.escrow?.satoshi_price).toBe(2569373)
    expect(listed.escrow?.protected).toBe(false)
    expect(listed.collection?.slug).toBe('bitcoin-puppets')
  })

  it('should get wallet inscriptions', async () => {
    const list = await walletApi.getWalletInscriptions('bc1ptest')
    expect(list).toHaveLength(2)
    expect(list[1].outpoint?.sats).toBe(10000)
  })

  it('should get balance only', async () => {
    const bal = await walletApi.getBalance('bc1ptest')
    expect(bal.balance).toBe(412915)
    expect(bal.frozen_balance).toBe(196216)
    expect(bal.utxo_count).toBe(4)
    expect('inscriptions' in bal).toBe(false)
  })

  it('should get the live inscription outpoint', async () => {
    const loc = await walletApi.getInscriptionOutpoint('cb5dbbf27058872e59888f8e34136059775e5021f8e479a4f6d4fb9bdefe0a37i0')
    expect(loc.owner).toBe('bc1pnnaxl5v4sl6fzmwww53p9hsarcpyq3sl96vk8unxvc56dzt34tmsnxwmz0')
    expect(loc.sats).toBe(10000)
    expect(outpointToTxidVout(loc.inscription.outpoint)).toBe(
      'f5c605b464aa837634f996fe8794fc2b314de112791374e569850379b35f2873:0',
    )
  })

  it('should get UTXOs', async () => {
    const utxos = await walletApi.getUtxos('bc1ptest')
    expect(utxos).toHaveLength(1)
    expect(utxos[0].txid).toBe('abc123')
  })

  it('should get rune balances', async () => {
    const runes = await walletApi.getRuneBalance('bc1ptest')
    expect(runes).toHaveLength(2)
    expect(runes[0].name).toBe('AI•ETCHED•THIS•RUNE')
    expect(runes[0].rune_id).toBe('840011:56')
    expect(runes[0].amount).toBe('10000000000')
    expect(runes[0].divisibility).toBe(0)
    expect(runes[0].collection?.slug).toBe('rune-AI•ETCHED•THIS•RUNE')
  })

  it('should get BRC-20 balances', async () => {
    const brc20 = await walletApi.getBrc20Balance('bc1ptest')
    expect(brc20).toHaveLength(1)
    expect(brc20[0].ticker).toBe('TRIO')
    expect(brc20[0].overall_balance).toBe('0')
    expect(brc20[0].collection?.slug).toBe('brc20-TRIO')
    expect(brc20[0].collection?.floor_price_per).toBeNull()
  })

  it('should get alkanes balances (live shape)', async () => {
    const alkanes = await walletApi.getAlkanesBalance('bc1ptest')
    expect(alkanes).toHaveLength(2)
    expect(alkanes[0]).toMatchObject({
      ticker: 'DIESEL',
      rune_id: '2:0',
      type: 'alkanes',
      divisibility: 8,
      overall_balance: '125',
      available_balance: '125',
      transferable_balance: '0',
    })
    expect(alkanes[0].collection?.slug).toBe('alkane-2:0')
    expect(alkanes[0].id).toBeUndefined()
  })

  it('should get alkanes outpoints', async () => {
    const outs = await walletApi.getAlkanesOutpoints('bc1ptest', '2:0')
    expect(outs.length).toBeGreaterThan(0)
    expect(outs[0].rune_id).toBe('2:0')
    expect(outs[0].outpoint).toMatch(/^[0-9a-f]{64}:\d+$/)
    expect(outs[0].sats).toBe(546)
  })

  it('should get inscription detail', async () => {
    const ins = await walletApi.getInscription('cb5dbbf27058872e59888f8e34136059775e5021f8e479a4f6d4fb9bdefe0a37i0')
    expect(ins.id).toBe('cb5dbbf27058872e59888f8e34136059775e5021f8e479a4f6d4fb9bdefe0a37i0')
    expect(ins.num).toBe(53149085)
    expect(ins.content_type).toBe('image/webp')
    expect(ins.content_length).toBe(7498)
    expect(ins.genesis_height).toBe(824265)
    expect(ins.genesis_fee).toBe(166800)
    expect(ins.sat).toBeNull()
    expect(ins.satpoint).toBe('f5c605b464aa837634f996fe8794fc2b314de112791374e569850379b35f2873:0:0')
    expect(ins.meta?.name).toBe('Bitcoin Puppet #7780')
    expect(ins.collection?.slug).toBe('bitcoin-puppets')
  })

  it('should surface API errors as OwApiError', async () => {
    const err = await walletApi.getWallet('notanaddress').catch((e) => e)
    expect(isOwApiError(err)).toBe(true)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Invalid Address')
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
