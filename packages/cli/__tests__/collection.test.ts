import { describe, it, expect } from 'vitest'
import { formatTable, formatSats } from '../src/output.js'

describe('collection commands', () => {
  it('should format collection listings table', () => {
    const rows = [
      ['abc123i0', 'Test #1', formatSats(50000), 'bc1ptest'],
      ['def456i0', 'Test #2', formatSats(60000), 'bc1pseller'],
    ]
    const table = formatTable(['Inscription', 'Name', 'Price', 'Seller'], rows)
    expect(table).toContain('abc123i0')
    expect(table).toContain('Test #1')
    expect(table).toContain('50,000 sats')
    expect(table).toContain('bc1pseller')
  })

  it('should format collection stats', () => {
    const floor = formatSats(50000)
    const volume = formatSats(100000000)
    expect(floor).toContain('sats')
    expect(volume).toContain('BTC')
  })

  it('should format search results table', () => {
    const rows = [['test-collection', 'Test Collection']]
    const table = formatTable(['Slug', 'Name'], rows)
    expect(table).toContain('test-collection')
    expect(table).toContain('Test Collection')
  })

  it('should handle N/A for null stats', () => {
    expect(formatSats(null)).toBe('N/A')
  })
})
