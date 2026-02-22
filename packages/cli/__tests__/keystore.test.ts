import { describe, it, expect } from 'vitest'
import { getKeypair } from '../src/keystore.js'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('getKeypair', () => {
  it('should derive keypair from 12-word mnemonic', () => {
    const kp = getKeypair(TEST_MNEMONIC)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey.length).toBe(32)
  })

  it('should handle leading/trailing whitespace in mnemonic', () => {
    const kp = getKeypair(`  ${TEST_MNEMONIC}  `)
    const kp2 = getKeypair(TEST_MNEMONIC)
    expect(kp.privateKey).toEqual(kp2.privateKey)
  })

  it('should derive keypair from WIF', () => {
    // Standard test WIF (compressed mainnet)
    const wif = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn'
    const kp = getKeypair(wif)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
  })

  it('should treat short strings as WIF (not mnemonic)', () => {
    // 11 words is not a mnemonic, so should try WIF path
    expect(() => getKeypair('one two three four five six seven eight nine ten eleven')).toThrow()
  })
})
