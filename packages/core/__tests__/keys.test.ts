import { describe, it, expect } from 'vitest'
import { generateMnemonic, validateMnemonic, keypairFromMnemonic, keypairFromWIF } from '../src/keys.js'
import { bytesToHex } from '../src/signer.js'
import * as secp from '@noble/secp256k1'

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

    it('should reject wrong word count', () => {
      expect(validateMnemonic('abandon abandon abandon')).toBe(false)
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

    it('should derive different keys from different mnemonics', () => {
      const kp1 = keypairFromMnemonic(TEST_MNEMONIC)
      const m2 = generateMnemonic()
      const kp2 = keypairFromMnemonic(m2)
      expect(bytesToHex(kp1.privateKey)).not.toBe(bytesToHex(kp2.privateKey))
    })

    it('should produce x-only key matching schnorr derivation', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const xOnly = secp.schnorr.getPublicKey(kp.privateKey)
      expect(bytesToHex(kp.xOnlyPublicKey)).toBe(bytesToHex(xOnly))
    })
  })

  describe('keypairFromWIF', () => {
    it('should derive keypair from compressed WIF', () => {
      // Generate a known keypair from mnemonic, encode as WIF, round-trip
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const wif = encodeWIF(kp.privateKey, true)
      const kp2 = keypairFromWIF(wif)

      expect(bytesToHex(kp2.privateKey)).toBe(bytesToHex(kp.privateKey))
      expect(bytesToHex(kp2.publicKey)).toBe(bytesToHex(kp.publicKey))
      expect(kp2.publicKey).toHaveLength(33)
    })

    it('should produce valid x-only public key', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const wif = encodeWIF(kp.privateKey, true)
      const kp2 = keypairFromWIF(wif)

      expect(kp2.xOnlyPublicKey).toHaveLength(32)
      expect(bytesToHex(kp2.xOnlyPublicKey)).toBe(bytesToHex(kp.xOnlyPublicKey))
    })

    it('should throw on invalid WIF character', () => {
      expect(() => keypairFromWIF('0OIl')).toThrow('Invalid WIF character')
    })

    it('should throw on bad checksum', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const wif = encodeWIF(kp.privateKey, true)
      // Corrupt last character
      const corrupted = wif.slice(0, -1) + (wif.endsWith('1') ? '2' : '1')
      expect(() => keypairFromWIF(corrupted)).toThrow('Invalid WIF checksum')
    })

    it('should produce consistent results', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const wif = encodeWIF(kp.privateKey, true)
      const a = keypairFromWIF(wif)
      const b = keypairFromWIF(wif)
      expect(bytesToHex(a.privateKey)).toBe(bytesToHex(b.privateKey))
    })
  })
})

// Helper: encode private key as compressed mainnet WIF for round-trip testing
function encodeWIF(privateKey: Uint8Array, compressed: boolean): string {
  const { sha256 } = require('@noble/hashes/sha256')
  const payload = new Uint8Array(compressed ? 34 : 33)
  payload[0] = 0x80 // mainnet version
  payload.set(privateKey, 1)
  if (compressed) payload[33] = 0x01

  const hash = sha256(sha256(payload))
  const full = new Uint8Array(payload.length + 4)
  full.set(payload)
  full.set(hash.slice(0, 4), payload.length)

  // Base58 encode
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = 0n
  for (const byte of full) num = num * 256n + BigInt(byte)
  let str = ''
  while (num > 0n) {
    str = ALPHABET[Number(num % 58n)] + str
    num = num / 58n
  }
  for (const byte of full) {
    if (byte === 0) str = '1' + str
    else break
  }
  return str
}
