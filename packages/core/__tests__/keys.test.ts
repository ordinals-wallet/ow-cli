import { describe, it, expect } from 'vitest'
import { generateMnemonic, validateMnemonic, keypairFromMnemonic, keypairFromWIF } from '../src/keys.js'

// Standard test vector: "abandon" x 11 + "about"
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('keys', () => {
  describe('generateMnemonic', () => {
    it('should generate a 12-word mnemonic', () => {
      const mnemonic = generateMnemonic()
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
    })

    it('should generate valid mnemonics', () => {
      const mnemonic = generateMnemonic()
      expect(validateMnemonic(mnemonic)).toBe(true)
    })

    it('should generate different mnemonics each time', () => {
      const m1 = generateMnemonic()
      const m2 = generateMnemonic()
      expect(m1).not.toBe(m2)
    })
  })

  describe('validateMnemonic', () => {
    it('should validate correct mnemonic', () => {
      expect(validateMnemonic(TEST_MNEMONIC)).toBe(true)
    })

    it('should reject invalid mnemonic', () => {
      expect(validateMnemonic('invalid words here')).toBe(false)
    })

    it('should reject empty string', () => {
      expect(validateMnemonic('')).toBe(false)
    })
  })

  describe('keypairFromMnemonic', () => {
    it('should derive deterministic keys from test mnemonic', () => {
      const kp1 = keypairFromMnemonic(TEST_MNEMONIC)
      const kp2 = keypairFromMnemonic(TEST_MNEMONIC)

      expect(bytesToHex(kp1.privateKey)).toBe(bytesToHex(kp2.privateKey))
      expect(bytesToHex(kp1.publicKey)).toBe(bytesToHex(kp2.publicKey))
      expect(bytesToHex(kp1.xOnlyPublicKey)).toBe(bytesToHex(kp2.xOnlyPublicKey))
    })

    it('should produce 32-byte private key', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      expect(kp.privateKey).toHaveLength(32)
    })

    it('should produce 33-byte compressed public key', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      expect(kp.publicKey).toHaveLength(33)
    })

    it('should produce 32-byte x-only public key', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      expect(kp.xOnlyPublicKey).toHaveLength(32)
    })

    it('should throw on invalid mnemonic', () => {
      expect(() => keypairFromMnemonic('bad mnemonic')).toThrow('Invalid mnemonic')
    })
  })
})

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
