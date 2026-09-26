import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  bip322MessageHash,
  bip322ToSpendTxid,
  bip322AddressScript,
  signBip322Simple,
  verifyBip322Simple,
} from '../src/bip322.js'
import { keypairFromWIF } from '../src/keys.js'
import { bytesToHex } from '../src/signer.js'

// Official vectors: bitcoin/bips bip-0322/basic-test-vectors.json
interface Vectors {
  tx_hashes: { message: string; address: string; message_hash: string; to_spend_tx_hash: string }[]
  simple: { message: string; private_keys: string[]; address: string; type: string; bip322_signatures: string[] }[]
  error: { description: string; message: string; address: string; signature: string }[]
}
const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/bip322-basic-test-vectors.json', import.meta.url), 'utf8'),
) as Vectors
const supported = vectors.simple.filter((v) => v.type === 'p2wpkh' || v.type === 'p2tr')

// Public BIP-322 test-vector key. Not a real wallet.
const WIF = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k'
const SEGWIT = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
const TAPROOT = 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3'
// Older BIP text's taproot "Hello World" vector (SIGHASH_ALL, 65-byte sig).
const TAPROOT_HELLO =
  'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ=='

const { privateKey } = keypairFromWIF(WIF)

describe('BIP-322 hashes (official vectors)', () => {
  for (const v of vectors.tx_hashes) {
    it(`message hash + to_spend txid for ${JSON.stringify(v.message)}`, () => {
      expect(bytesToHex(bip322MessageHash(v.message))).toBe(v.message_hash)
      const { script } = bip322AddressScript(v.address)
      expect(bip322ToSpendTxid(script, v.message)).toBe(v.to_spend_tx_hash)
    })
  }
})

describe('BIP-322 verify (official vectors)', () => {
  for (const v of supported) {
    for (const sig of v.bip322_signatures) {
      it(`${v.type} ${JSON.stringify(v.message)} ${sig.slice(0, 12)}…`, async () => {
        expect(await verifyBip322Simple(v.address, v.message, sig)).toBe(true)
        expect(await verifyBip322Simple(v.address, v.message + ' tampered', sig)).toBe(false)
      })
    }
  }

  it('verifies the taproot SIGHASH_ALL vector for the test key', async () => {
    expect(await verifyBip322Simple(TAPROOT, 'Hello World', TAPROOT_HELLO)).toBe(true)
  })

  for (const e of vectors.error) {
    it(`rejects: ${e.description}`, async () => {
      expect(await verifyBip322Simple(e.address, e.message, e.signature)).toBe(false)
    })
  }
})

describe('BIP-322 sign', () => {
  it('P2WPKH signatures reproduce the official RFC6979 vectors byte for byte', () => {
    for (const v of supported.filter((x) => x.type === 'p2wpkh')) {
      const { privateKey: pk } = keypairFromWIF(v.private_keys[0])
      const sig = signBip322Simple(v.address, v.message, pk)
      expect(v.bip322_signatures.map((s) => s.replace(/^smp/, ''))).toContain(sig)
    }
  })

  it('P2TR signatures for the official taproot key verify', async () => {
    for (const v of supported.filter((x) => x.type === 'p2tr')) {
      const { privateKey: pk } = keypairFromWIF(v.private_keys[0])
      const sig = signBip322Simple(v.address, v.message, pk)
      expect(await verifyBip322Simple(v.address, v.message, sig)).toBe(true)
    }
  })

  it('P2TR signatures use SIGHASH_DEFAULT (single 64-byte witness item)', async () => {
    for (const msg of ['', 'Hello World', 'Sign in to Ordinals Wallet\n\nmulti\nline']) {
      const sig = signBip322Simple(TAPROOT, msg, privateKey)
      const raw = atob(sig)
      expect(raw.length).toBe(66)
      expect(raw.charCodeAt(0)).toBe(1)
      expect(raw.charCodeAt(1)).toBe(64)
      expect(await verifyBip322Simple(TAPROOT, msg, sig)).toBe(true)
      expect(await verifyBip322Simple(TAPROOT, msg + '.', sig)).toBe(false)
    }
  })

  it('P2WPKH signatures for the test key verify', async () => {
    const sig = signBip322Simple(SEGWIT, 'Hello World', privateKey)
    expect(await verifyBip322Simple(SEGWIT, 'Hello World', sig)).toBe(true)
  })

  it('refuses to sign for an address the key does not control', () => {
    const other = 'bc1p3w07au5hu98gtuvjaruspma03pft77z59zvv9fa0j4gdfcfhqfss2cd529'
    expect(() => signBip322Simple(other, 'x', privateKey)).toThrow(/does not control/)
  })

  it('refuses legacy addresses', () => {
    expect(() => signBip322Simple('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'x', privateKey)).toThrow(/unsupported/)
  })
})
