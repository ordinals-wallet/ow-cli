import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateMnemonic, keypairFromMnemonic, publicKeyToP2TR, bytesToHex } from '@ow-cli/core'

describe('wallet commands', () => {
  it('should generate valid mnemonic and derive address', () => {
    const mnemonic = generateMnemonic()
    const kp = keypairFromMnemonic(mnemonic)
    const addr = publicKeyToP2TR(kp.publicKey)

    expect(addr.address).toMatch(/^bc1p/)
    expect(kp.privateKey).toHaveLength(32)
    expect(kp.publicKey).toHaveLength(33)
  })

  it('should derive deterministic address from known mnemonic', () => {
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const kp = keypairFromMnemonic(mnemonic)
    const addr = publicKeyToP2TR(kp.publicKey)

    // Address should be consistent
    const kp2 = keypairFromMnemonic(mnemonic)
    const addr2 = publicKeyToP2TR(kp2.publicKey)
    expect(addr.address).toBe(addr2.address)
  })
})
