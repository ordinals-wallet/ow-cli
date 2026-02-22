import { describe, it, expect } from 'vitest'
import {
  validateInscriptionId,
  validateOutpoint,
  validateAddress,
  validateFeeRate,
  validatePrice,
  validateSats,
  validateRuneId,
  validateAmount,
  validateSplits,
  validateOutpointWithSats,
  validateOutpointWithSatsShort,
  parseOutpoints,
  validateOutputPair,
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

  describe('validateRuneId', () => {
    it('should accept valid rune ID', () => {
      expect(validateRuneId('840000:1')).toBe('840000:1')
    })

    it('should accept rune ID with large values', () => {
      expect(validateRuneId('999999:42')).toBe('999999:42')
    })

    it('should reject missing colon', () => {
      expect(() => validateRuneId('8400001')).toThrow(CliError)
    })

    it('should reject non-numeric', () => {
      expect(() => validateRuneId('abc:1')).toThrow(CliError)
    })

    it('should reject empty string', () => {
      expect(() => validateRuneId('')).toThrow(CliError)
    })
  })

  describe('validateAmount', () => {
    it('should accept positive integer', () => {
      expect(validateAmount('100')).toBe('100')
    })

    it('should accept decimal amount', () => {
      expect(validateAmount('10.5')).toBe('10.5')
    })

    it('should reject zero', () => {
      expect(() => validateAmount('0')).toThrow(CliError)
    })

    it('should reject negative', () => {
      expect(() => validateAmount('-5')).toThrow(CliError)
    })

    it('should reject non-numeric', () => {
      expect(() => validateAmount('abc')).toThrow(CliError)
    })
  })

  describe('validateSplits', () => {
    it('should accept valid splits', () => {
      expect(validateSplits('5')).toBe(5)
    })

    it('should accept minimum splits', () => {
      expect(validateSplits('2')).toBe(2)
    })

    it('should accept maximum splits', () => {
      expect(validateSplits('25')).toBe(25)
    })

    it('should reject 1', () => {
      expect(() => validateSplits('1')).toThrow(CliError)
    })

    it('should reject 26', () => {
      expect(() => validateSplits('26')).toThrow(CliError)
    })

    it('should reject non-numeric', () => {
      expect(() => validateSplits('abc')).toThrow(CliError)
    })
  })

  describe('validateOutpointWithSats', () => {
    it('should accept valid outpoint with sats', () => {
      const result = validateOutpointWithSats('a'.repeat(64) + ':0:10000')
      expect(result.txid).toBe('a'.repeat(64))
      expect(result.vout).toBe(0)
      expect(result.sats).toBe(10000)
    })

    it('should reject missing sats', () => {
      expect(() => validateOutpointWithSats('a'.repeat(64) + ':0')).toThrow(CliError)
    })

    it('should reject short txid', () => {
      expect(() => validateOutpointWithSats('abc:0:10000')).toThrow(CliError)
    })
  })

  describe('validateOutpointWithSatsShort', () => {
    it('should accept valid outpoint with sats (comma format)', () => {
      const result = validateOutpointWithSatsShort('a'.repeat(64) + ':0,546')
      expect(result.outpoint).toBe('a'.repeat(64) + ':0')
      expect(result.sats).toBe(546)
    })

    it('should reject missing comma', () => {
      expect(() => validateOutpointWithSatsShort('a'.repeat(64) + ':0:546')).toThrow(CliError)
    })

    it('should reject short txid', () => {
      expect(() => validateOutpointWithSatsShort('abc:0,546')).toThrow(CliError)
    })
  })

  describe('validateOutputPair', () => {
    it('should accept valid address:sats pair', () => {
      const result = validateOutputPair('bc1p' + 'a'.repeat(58) + ':10000')
      expect(result.address).toBe('bc1p' + 'a'.repeat(58))
      expect(result.sats).toBe(10000)
    })

    it('should accept legacy address:sats pair', () => {
      const result = validateOutputPair('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2:50000')
      expect(result.address).toBe('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
      expect(result.sats).toBe(50000)
    })

    it('should reject missing colon', () => {
      expect(() => validateOutputPair('bc1paaaa10000')).toThrow(CliError)
    })

    it('should reject empty address', () => {
      expect(() => validateOutputPair(':10000')).toThrow(CliError)
    })

    it('should reject non-numeric sats', () => {
      expect(() => validateOutputPair('bc1paaa:abc')).toThrow(CliError)
    })

    it('should reject zero sats', () => {
      expect(() => validateOutputPair('bc1paaa:0')).toThrow(CliError)
    })

    it('should reject negative sats', () => {
      expect(() => validateOutputPair('bc1paaa:-100')).toThrow(CliError)
    })
  })

  describe('parseOutpoints', () => {
    it('should parse a single outpoint', () => {
      const result = parseOutpoints('a'.repeat(64) + ':0,546')
      expect(result).toHaveLength(1)
      expect(result[0].outpoint).toBe('a'.repeat(64) + ':0')
      expect(result[0].sats).toBe(546)
    })

    it('should parse multiple space-separated outpoints', () => {
      const raw = 'a'.repeat(64) + ':0,546 ' + 'b'.repeat(64) + ':1,1000'
      const result = parseOutpoints(raw)
      expect(result).toHaveLength(2)
      expect(result[0].outpoint).toBe('a'.repeat(64) + ':0')
      expect(result[0].sats).toBe(546)
      expect(result[1].outpoint).toBe('b'.repeat(64) + ':1')
      expect(result[1].sats).toBe(1000)
    })

    it('should trim whitespace', () => {
      const raw = '  ' + 'a'.repeat(64) + ':0,546   ' + 'b'.repeat(64) + ':2,800  '
      const result = parseOutpoints(raw)
      expect(result).toHaveLength(2)
    })
  })
})
