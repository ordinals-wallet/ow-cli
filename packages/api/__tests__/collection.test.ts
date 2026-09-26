import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import { isOwApiError } from '../src/errors.js'
import * as collectionApi from '../src/collection.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com', retries: 0 })

describe('collection API', () => {
  it('should get collection metadata (live shape)', async () => {
    const meta = await collectionApi.getMetadata('bitcoin-puppets')
    expect(meta.slug).toBe('bitcoin-puppets')
    expect(meta.name).toBe('Bitcoin Puppets')
    expect(meta.total_supply).toBe(10001)
    expect(meta.verified).toBe(false)
    expect(meta.fair_sats).toBeGreaterThan(0)
    expect(typeof meta.change_week_fair).toBe('number')
    expect(meta.socials?.twitter).toBe('https://x.com/foufoufou67')
    expect(meta.image_url).toBeUndefined()
    expect(meta.supply).toBeUndefined()
  })

  it('should 404 as OwApiError for an unknown slug', async () => {
    const err = await collectionApi.getMetadata('no-such-slug').catch((e) => e)
    expect(isOwApiError(err)).toBe(true)
    expect(err.status).toBe(404)
  })

  it('should get escrows (live shape)', async () => {
    const escrows = await collectionApi.getEscrows('bitcoin-puppets')
    expect(escrows).toHaveLength(1)
    const e = escrows[0]
    expect(e.inscription_id).toBe('836430e4e0ef9809a1c9101e44805967a8ab46223719e709278f075c2c13b0bei0')
    expect(e.satoshi_price).toBe(102774922)
    expect(e.seller_address).toBe('bc1pc5lsnv0aduycfk5pk862axux8u4je3jyh7z93rcaehl7vkg3re6qxma9lt')
    expect(e.outpoint).toBe('33d3057475e332a278ae0376408490c52a6cab506588b88d3690fabc974e11e9:0')
    expect(e.price_per).toBe('')
    expect(e.amount).toBe('')
    expect(e.protected).toBe(false)
    expect(e.private_relay).toBe(false)
    expect(e.secure_purchase_version).toBeNull()
    expect(e.price).toBeUndefined()
  })

  it('should get sold escrows with {limit, offset}', async () => {
    const sold = await collectionApi.getSoldEscrows('bitcoin-puppets', { limit: 1, offset: 1 })
    expect(sold).toHaveLength(1)
    expect(sold[0].inscription_id).toBe('2045a0506aced3af6f131ba3b002261a41f84f0c280434c079eea3e94b0e8a48i0')
    expect(sold[0].buyer_address).toBe('bc1pj84xryc4f67tsnx9ucg66z9zzdjnuddzxt7za4scnkmwrgkjn5qqlg48x2')
  })

  it('should still accept a bare limit for sold escrows', async () => {
    const sold = await collectionApi.getSoldEscrows('bitcoin-puppets', 20)
    expect(sold).toHaveLength(2)
    expect(sold[0].secure_purchase_state).toBe('settled')
    expect(sold[0].protected).toBe(true)
    expect(sold[0].price_per).toBe('1747173')
    expect(sold[0].amount).toBe('1')
  })

  it('should get collection stats', async () => {
    const stats = await collectionApi.getStats('bitcoin-puppets')
    expect(stats.floor_price).toBe(2045220)
    expect(stats.total_supply).toBe(10001)
    expect(stats.listed).toBe(13)
    expect(stats.sales).toBe(32)
    expect(stats.owners).toBeNull()
  })
})
