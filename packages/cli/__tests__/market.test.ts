import { describe, it, expect } from 'vitest'
import { formatSats } from '../src/output.js'
import {
  validateInscriptionId,
  validateOutpoint,
  validateFeeRate,
  validatePrice,
} from '../src/utils/validate.js'
import { CliError } from '../src/utils/errors.js'

describe('market commands', () => {
  it('should validate inscription ID for purchase', () => {
    const id = 'a'.repeat(64) + 'i0'
    expect(validateInscriptionId(id)).toBe(id)
  })

  it('should reject invalid inscription ID', () => {
    expect(() => validateInscriptionId('bad')).toThrow(CliError)
  })

  it('should validate outpoint for rune purchase', () => {
    const op = 'a'.repeat(64) + ':0'
    expect(validateOutpoint(op)).toBe(op)
  })

  it('should validate fee rate', () => {
    expect(validateFeeRate('20')).toBe(20)
    expect(() => validateFeeRate('0')).toThrow(CliError)
  })

  it('should validate price for listing', () => {
    expect(validatePrice('50000')).toBe(50000)
    expect(() => validatePrice('-1')).toThrow(CliError)
  })

  it('should format listing price correctly', () => {
    expect(formatSats(50000)).toContain('sats')
    expect(formatSats(200000000)).toContain('BTC')
  })
})
