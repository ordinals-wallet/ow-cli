import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as searchApi from '../src/search.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('search API', () => {
  it('should search and return results', async () => {
    const result = await searchApi.search('test')
    expect(result.collections).toHaveLength(1)
    expect(result.collections[0].slug).toBe('test')
    expect(result.collections[0].name).toBe('Test')
    expect(result.collections[0].icon).toBe('https://example.com/icon.png')
    expect(result.inscriptions).toHaveLength(0)
    expect(result.addresses).toHaveLength(0)
  })
})
