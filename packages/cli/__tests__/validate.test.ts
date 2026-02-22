import { describe, it, expect } from 'vitest'
import {
  validateInscriptionId,
  validateOutpoint,
  validateAddress,
  validateFeeRate,
  validatePrice,
  validateSats,
} from '../src/utils/validate.js'
import { CliError } from '../src/utils/errors.js'

describe('validators', () => {
  describe('validateInscriptionId', () => {
    it('should accept valid inscription IDs', () => {
      const id = 'a'.repeat(64) + 'i0'
      expect(validateInscriptionId(id)).toBe(id)
    })

    it('should accept inscription ID with large index', () => {
      const id = 'ab12cd34'.repeat(8) + 'i999'
      expect(validateInscriptionId(id)).toBe(id)
    })

    it('should reject missing "i" separator', () => {
      expect(() => validateInscriptionId('a'.repeat(64) + '0')).toThrow(CliError)
    })

    it('should reject short txid', () => {
      expect(() => validateInscriptionId('abc123i0')).toThrow(CliError)
    })

    it('should reject uppercase hex', () => {
      expect(() => validateInscriptionId('A'.repeat(64) + 'i0')).toThrow(CliError)
    })

    it('should reject empty string', () => {
      expect(() => validateInscriptionId('')).toThrow(CliError)
    })
  })

  describe('validateOutpoint', () => {
    it('should accept valid outpoints', () => {
      const op = 'a'.repeat(64) + ':0'
      expect(validateOutpoint(op)).toBe(op)
    })

    it('should accept outpoint with large vout', () => {
      const op = 'ab12cd34'.repeat(8) + ':42'
      expect(validateOutpoint(op)).toBe(op)
    })

    it('should reject missing colon', () => {
      expect(() => validateOutpoint('a'.repeat(64) + '0')).toThrow(CliError)
    })

    it('should reject short txid', () => {
      expect(() => validateOutpoint('abc:0')).toThrow(CliError)
    })
  })

  describe('validateAddress', () => {
    it('should accept bech32m taproot address', () => {
      expect(validateAddress('bc1p' + 'a'.repeat(58))).toBe('bc1p' + 'a'.repeat(58))
    })

    it('should accept legacy P2PKH address', () => {
      expect(validateAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
    })

    it('should accept P2SH address', () => {
      expect(validateAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')
    })

    it('should reject empty string', () => {
      expect(() => validateAddress('')).toThrow(CliError)
    })

    it('should reject random text', () => {
      expect(() => validateAddress('not-an-address')).toThrow(CliError)
    })
  })

  describe('validateFeeRate', () => {
    it('should accept valid fee rate', () => {
      expect(validateFeeRate('20')).toBe(20)
    })

    it('should accept fee rate of 1', () => {
      expect(validateFeeRate('1')).toBe(1)
    })

    it('should reject zero', () => {
      expect(() => validateFeeRate('0')).toThrow(CliError)
    })

    it('should reject negative', () => {
      expect(() => validateFeeRate('-5')).toThrow(CliError)
    })

    it('should reject non-numeric', () => {
      expect(() => validateFeeRate('abc')).toThrow(CliError)
    })
  })

  describe('validatePrice', () => {
    it('should accept valid price', () => {
      expect(validatePrice('50000')).toBe(50000)
    })

    it('should reject zero', () => {
      expect(() => validatePrice('0')).toThrow(CliError)
    })

    it('should reject non-numeric', () => {
      expect(() => validatePrice('free')).toThrow(CliError)
    })
  })

  describe('validateSats', () => {
    it('should accept valid sats amount', () => {
      expect(validateSats('10000')).toBe(10000)
    })

    it('should reject zero', () => {
      expect(() => validateSats('0')).toThrow(CliError)
    })

    it('should reject negative', () => {
      expect(() => validateSats('-100')).toThrow(CliError)
    })
  })
})
