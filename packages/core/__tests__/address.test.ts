import { describe, it, expect } from 'vitest'
import { publicKeyToP2TR, toXOnly } from '../src/address.js'
import { keypairFromMnemonic } from '../src/keys.js'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('address', () => {
  describe('toXOnly', () => {
    it('should strip prefix from 33-byte compressed pubkey', () => {
      const pubkey = new Uint8Array(33)
      pubkey[0] = 0x02
      pubkey.fill(0xab, 1)
      const xOnly = toXOnly(pubkey)
      expect(xOnly).toHaveLength(32)
      expect(xOnly[0]).toBe(0xab)
    })

    it('should pass through 32-byte x-only pubkey', () => {
      const xOnly = new Uint8Array(32).fill(0xcd)
      const result = toXOnly(xOnly)
      expect(result).toHaveLength(32)
      expect(result[0]).toBe(0xcd)
    })

    it('should throw for invalid pubkey length', () => {
      expect(() => toXOnly(new Uint8Array(31))).toThrow('Invalid public key length')
    })
  })

  describe('publicKeyToP2TR', () => {
    it('should produce a bc1p taproot address', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const addr = publicKeyToP2TR(kp.publicKey)
      expect(addr.address).toMatch(/^bc1p/)
    })

    it('should produce deterministic addresses', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const addr1 = publicKeyToP2TR(kp.publicKey)
      const addr2 = publicKeyToP2TR(kp.publicKey)
      expect(addr1.address).toBe(addr2.address)
    })

    it('should return script and tapInternalKey', () => {
      const kp = keypairFromMnemonic(TEST_MNEMONIC)
      const addr = publicKeyToP2TR(kp.publicKey)
      expect(addr.script).toBeInstanceOf(Uint8Array)
      expect(addr.tapInternalKey).toBeInstanceOf(Uint8Array)
      expect(addr.tapInternalKey).toHaveLength(32)
    })
  })
})
