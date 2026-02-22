import { describe, it, expect } from 'vitest'
import { formatTable, formatJson, formatSats } from '../src/output.js'

describe('formatTable', () => {
  it('should format simple table', () => {
    const result = formatTable(['Name', 'Value'], [['foo', 'bar']])
    expect(result).toContain('Name')
    expect(result).toContain('Value')
    expect(result).toContain('foo')
    expect(result).toContain('bar')
  })

  it('should pad columns correctly', () => {
    const result = formatTable(['A', 'B'], [['long value', 'x']])
    const lines = result.split('\n')
    expect(lines).toHaveLength(3) // header, separator, 1 row
  })

  it('should handle empty rows', () => {
    const result = formatTable(['Col1', 'Col2'], [])
    const lines = result.split('\n')
    expect(lines).toHaveLength(2) // header + separator only
  })

  it('should handle multiple rows', () => {
    const result = formatTable(['ID'], [['1'], ['2'], ['3']])
    const lines = result.split('\n')
    expect(lines).toHaveLength(5) // header + separator + 3 rows
  })

  it('should handle empty cells', () => {
    const result = formatTable(['A', 'B'], [['', 'val'], ['val', '']])
    expect(result).toContain('val')
  })
})

describe('formatJson', () => {
  it('should format object as pretty JSON', () => {
    const result = formatJson({ key: 'value' })
    expect(result).toBe('{\n  "key": "value"\n}')
  })

  it('should format array', () => {
    const result = formatJson([1, 2, 3])
    expect(JSON.parse(result)).toEqual([1, 2, 3])
  })

  it('should format null', () => {
    expect(formatJson(null)).toBe('null')
  })

  it('should format string', () => {
    expect(formatJson('hello')).toBe('"hello"')
  })

  it('should format nested objects', () => {
    const result = formatJson({ a: { b: 'c' } })
    const parsed = JSON.parse(result)
    expect(parsed.a.b).toBe('c')
  })
})

describe('formatSats', () => {
  it('should format small amounts in sats', () => {
    const result = formatSats(50000)
    expect(result).toContain('50')
    expect(result).toContain('sats')
  })

  it('should format large amounts in BTC', () => {
    const result = formatSats(100000000)
    expect(result).toContain('BTC')
    expect(result).toContain('1.00000000')
  })

  it('should format amounts just at BTC threshold', () => {
    const result = formatSats(1e8)
    expect(result).toContain('BTC')
  })

  it('should format amounts below BTC threshold', () => {
    const result = formatSats(99999999)
    expect(result).toContain('sats')
  })

  it('should return N/A for null', () => {
    expect(formatSats(null)).toBe('N/A')
  })

  it('should return N/A for undefined', () => {
    expect(formatSats(undefined)).toBe('N/A')
  })

  it('should handle zero', () => {
    const result = formatSats(0)
    expect(result).toContain('0')
    expect(result).toContain('sats')
  })
})
