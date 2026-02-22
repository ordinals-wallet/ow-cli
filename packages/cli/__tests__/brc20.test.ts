import { describe, it, expect } from 'vitest'
import { buildBrc20Payload, splitAmount } from '../src/commands/brc20.js'
import { buildTapPayload } from '../src/commands/tap-cmd.js'

describe('BRC-20 commands', () => {
  describe('buildBrc20Payload', () => {
    it('should build correct BRC-20 transfer JSON', () => {
      const payload = buildBrc20Payload('ORDI', '100')
      const parsed = JSON.parse(payload)
      expect(parsed.p).toBe('brc-20')
      expect(parsed.op).toBe('transfer')
      expect(parsed.tick).toBe('ORDI')
      expect(parsed.amt).toBe('100')
    })

    it('should handle decimal amounts', () => {
      const payload = buildBrc20Payload('SATS', '0.5')
      const parsed = JSON.parse(payload)
      expect(parsed.amt).toBe('0.5')
    })

    it('should preserve ticker case', () => {
      const payload = buildBrc20Payload('ordi', '10')
      const parsed = JSON.parse(payload)
      expect(parsed.tick).toBe('ordi')
    })
  })

  describe('splitAmount', () => {
    it('should return single amount when splits is 1', () => {
      const amounts = splitAmount('100', 1)
      expect(amounts).toEqual(['100'])
    })

    it('should split evenly', () => {
      const amounts = splitAmount('100', 4)
      expect(amounts).toHaveLength(4)
      expect(amounts[0]).toBe('25')
      expect(amounts[3]).toBe('25')
    })

    it('should handle remainder', () => {
      const amounts = splitAmount('10', 3)
      expect(amounts).toHaveLength(3)
      const total = amounts.reduce((s, a) => s + parseFloat(a), 0)
      expect(total).toBeCloseTo(10, 6)
    })

    it('should handle decimal amounts', () => {
      const amounts = splitAmount('1.5', 2)
      expect(amounts).toHaveLength(2)
      const total = amounts.reduce((s, a) => s + parseFloat(a), 0)
      expect(total).toBeCloseTo(1.5, 6)
    })
  })
})

describe('TAP commands', () => {
  describe('buildTapPayload', () => {
    it('should build correct TAP transfer JSON', () => {
      const payload = buildTapPayload('GLYPH', '50')
      const parsed = JSON.parse(payload)
      expect(parsed.p).toBe('tap')
      expect(parsed.op).toBe('token-transfer')
      expect(parsed.tick).toBe('GLYPH')
      expect(parsed.amt).toBe('50')
    })
  })
})
