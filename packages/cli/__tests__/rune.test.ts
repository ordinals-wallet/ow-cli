import { describe, it, expect } from 'vitest'
import { buildSplitEdicts } from '../src/commands/rune.js'

describe('rune commands', () => {
  describe('buildSplitEdicts', () => {
    it('should divide evenly', () => {
      const edicts = buildSplitEdicts('840000:1', '100', 4, 0, 'bc1ptest')
      expect(edicts).toHaveLength(4)
      expect(edicts[0].amount).toBe('25')
      expect(edicts[1].amount).toBe('25')
      expect(edicts[2].amount).toBe('25')
      expect(edicts[3].amount).toBe('25')
      expect(edicts[0].rune_id).toBe('840000:1')
      expect(edicts[0].destination).toBe('bc1ptest')
    })

    it('should assign remainder to last edict', () => {
      const edicts = buildSplitEdicts('840000:1', '10', 3, 0, 'bc1ptest')
      expect(edicts).toHaveLength(3)
      expect(edicts[0].amount).toBe('3')
      expect(edicts[1].amount).toBe('3')
      expect(edicts[2].amount).toBe('4')
    })

    it('should handle divisibility', () => {
      const edicts = buildSplitEdicts('840000:1', '1', 2, 8, 'bc1ptest')
      expect(edicts).toHaveLength(2)
      // 1 * 10^8 = 100000000, split into 50000000 each
      expect(edicts[0].amount).toBe('50000000')
      expect(edicts[1].amount).toBe('50000000')
    })

    it('should set correct divisibility and rune_id on all edicts', () => {
      const edicts = buildSplitEdicts('100:5', '50', 2, 2, 'bc1paddr')
      expect(edicts).toHaveLength(2)
      edicts.forEach((e) => {
        expect(e.rune_id).toBe('100:5')
        expect(e.divisibility).toBe(2)
        expect(e.destination).toBe('bc1paddr')
      })
    })
  })
})
