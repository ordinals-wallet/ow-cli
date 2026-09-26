import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as searchApi from '../src/search.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com', retries: 0 })

describe('search API', () => {
  it('returns collections for free text', async () => {
    const result = await searchApi.search('puppets')
    expect(result.collections).toHaveLength(1)
    expect(result.collections![0].slug).toBe('bitcoin-puppets')
    expect(result.collections![0].name).toBe('Bitcoin Puppets')
    expect(result.url).toBeUndefined()
  })

  it('returns a url for an address', async () => {
    const result = await searchApi.search('bc1pnnaxl5v4sl6fzmwww53p9hsarcpyq3sl96vk8unxvc56dzt34tmsnxwmz0')
    expect(result.url).toBe('/address/bc1pnnaxl5v4sl6fzmwww53p9hsarcpyq3sl96vk8unxvc56dzt34tmsnxwmz0')
    expect(result.collections).toBeUndefined()
  })

  it('maps the 404 "no match" to empty collections', async () => {
    const result = await searchApi.search('zzqqxxnomatch123')
    expect(result).toEqual({ collections: [] })
  })
})
