import { describe, it, expect } from 'vitest'
import { generateMnemonic, keypairFromMnemonic, publicKeyToP2TR } from '@ow-cli/core'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('E2E flow', () => {
  it('should create wallet and derive correct info', () => {
    // Simulate wallet create flow
    const mnemonic = generateMnemonic()
    expect(mnemonic.split(' ')).toHaveLength(12)

    const kp = keypairFromMnemonic(mnemonic)
    const addr = publicKeyToP2TR(kp.publicKey)

    expect(addr.address).toMatch(/^bc1p/)
    expect(addr.script).toBeInstanceOf(Uint8Array)
    expect(kp.xOnlyPublicKey).toHaveLength(32)

    // Verify public key hex is correct format
    const pubHex = bytesToHex(kp.publicKey)
    expect(pubHex).toMatch(/^(02|03)[0-9a-f]{64}$/)
  })

  it('should produce stable addresses for same mnemonic', () => {
    const mnemonic = generateMnemonic()

    const kp1 = keypairFromMnemonic(mnemonic)
    const addr1 = publicKeyToP2TR(kp1.publicKey)

    const kp2 = keypairFromMnemonic(mnemonic)
    const addr2 = publicKeyToP2TR(kp2.publicKey)

    expect(addr1.address).toBe(addr2.address)
  })
})
