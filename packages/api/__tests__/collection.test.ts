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
  })

  it('should get escrows', async () => {
    const escrows = await collectionApi.getEscrows('test-collection')
    expect(escrows).toHaveLength(1)
    expect(escrows[0].price).toBe(50000)
  })

  it('should get collection stats', async () => {
    const stats = await collectionApi.getStats('test-collection')
    expect(stats.floor_price).toBe(50000)
    expect(stats.listed_count).toBe(10)
  })
})
