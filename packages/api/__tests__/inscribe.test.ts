import { describe, it, expect } from 'vitest'
import { setClient } from '../src/client.js'
import * as inscribeApi from '../src/inscribe.js'

setClient({ baseUrl: 'https://turbo.ordinalswallet.com' })

describe('inscribe API', () => {
  it('should estimate inscription cost', async () => {
    const result = await inscribeApi.estimate({
      file_size: 1000,
      fee_rate: 20,
      content_type: 'image/png',
    })
    expect(result.total_fees).toBe(5000)
    expect(result.inscription_fee).toBe(4000)
    expect(result.postage).toBe(546)
    expect(result.network_fee).toBe(1000)
    expect(result.base_fee).toBe(500)
    expect(result.size_fee).toBe(3500)
    expect(result.total_cost).toBe(5546)
  })
})
