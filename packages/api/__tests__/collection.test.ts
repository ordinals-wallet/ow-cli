import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as collectionApi from '../src/collection.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('collection API', () => {
  it('should get collection metadata', async () => {
    const meta = await collectionApi.getMetadata('test-collection')
    expect(meta.slug).toBe('test-collection')
    expect(meta.name).toBe('Test Collection')
    expect(meta.supply).toBe(100)
    expect(meta.description).toBe('A test')
    expect(meta.image_url).toBe('https://example.com/img.png')
  })

  it('should get escrows', async () => {
    const escrows = await collectionApi.getEscrows('test-collection')
    expect(escrows).toHaveLength(1)
    expect(escrows[0].inscription_id).toBe('abc123i0')
    expect(escrows[0].satoshi_price).toBe(50000)
    expect(escrows[0].seller_address).toBe('bc1ptest')
    expect(escrows[0].name).toBe('Test #1')
  })

  it('should get sold escrows', async () => {
    const sold = await collectionApi.getSoldEscrows('test-collection')
    expect(sold).toHaveLength(1)
    expect(sold[0].inscription_id).toBe('def456i0')
    expect(sold[0].buyer_address).toBe('bc1pbuyer')
    expect(sold[0].satoshi_price).toBe(60000)
  })

  it('should get collection stats', async () => {
    const stats = await collectionApi.getStats('test-collection')
    expect(stats.floor_price).toBe(50000)
    expect(stats.total_supply).toBe(100)
    expect(stats.listed).toBe(10)
    expect(stats.sales).toBe(50)
    expect(stats.owners).toBe(42)
  })
})
