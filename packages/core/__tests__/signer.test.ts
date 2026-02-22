import { describe, it, expect } from 'vitest'
import { signPsbt, bytesToHex, hexToBytes } from '../src/signer.js'
import { keypairFromMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('bytesToHex', () => {
  it('should convert bytes to hex string', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
  })

  it('should handle empty array', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('')
  })

  it('should pad single-digit hex values', () => {
    expect(bytesToHex(new Uint8Array([0]))).toBe('00')
    expect(bytesToHex(new Uint8Array([9]))).toBe('09')
  })
})

describe('hexToBytes', () => {
  it('should convert hex string to bytes', () => {
    const result = hexToBytes('00010f10ff')
    expect(result).toEqual(new Uint8Array([0, 1, 15, 16, 255]))
  })

  it('should handle empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array([]))
  })

  it('should round-trip with bytesToHex', () => {
    const original = new Uint8Array([10, 20, 30, 40, 50, 100, 200, 255])
    expect(hexToBytes(bytesToHex(original))).toEqual(original)
  })
})

describe('signer', () => {
  it('should sign a simple PSBT and extract raw tx', () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC)
    const addr = publicKeyToP2TR(kp.publicKey)
    const xOnlyPub = secp.schnorr.getPublicKey(kp.privateKey)

    const tx = new btc.Transaction({ version: 2 })
    tx.addInput({
      txid: '0000000000000000000000000000000000000000000000000000000000000001',
      index: 0,
      witnessUtxo: {
        script: addr.script,
        amount: 10000n,
      },
      tapInternalKey: xOnlyPub,
    })
    tx.addOutput({
      script: addr.script,
      amount: 9000n,
    })

    const psbtHex = bytesToHex(tx.toPSBT())

    const result = signPsbt({
      psbt: psbtHex,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      disableExtract: false,
    })

    // Result should be a valid hex raw transaction
    expect(result).toMatch(/^[0-9a-f]+$/)
    expect(result.length).toBeGreaterThan(0)
  })

  it('should return PSBT hex when disableExtract is true', () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC)
    const addr = publicKeyToP2TR(kp.publicKey)
    const xOnlyPub = secp.schnorr.getPublicKey(kp.privateKey)

    const tx = new btc.Transaction({ version: 2 })
    tx.addInput({
      txid: '0000000000000000000000000000000000000000000000000000000000000001',
      index: 0,
      witnessUtxo: {
        script: addr.script,
        amount: 10000n,
      },
      tapInternalKey: xOnlyPub,
      sighashType: btc.SigHash.SINGLE_ANYONECANPAY,
    })
    tx.addOutput({
      script: addr.script,
      amount: 9000n,
    })

    const psbtHex = bytesToHex(tx.toPSBT())

    const result = signPsbt({
      psbt: psbtHex,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      disableExtract: true,
    })

    // Should be valid PSBT hex
    expect(result).toMatch(/^[0-9a-f]+$/)
    // Verify it's a valid PSBT by parsing it
    const parsed = btc.Transaction.fromPSBT(hexToBytes(result))
    expect(parsed.inputsLength).toBe(1)
  })

  it('should skip signing at skipSignIndex', () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC)
    const addr = publicKeyToP2TR(kp.publicKey)
    const xOnlyPub = secp.schnorr.getPublicKey(kp.privateKey)

    const tx = new btc.Transaction({ version: 2 })
    // Input 0 - will be skipped
    tx.addInput({
      txid: '0000000000000000000000000000000000000000000000000000000000000001',
      index: 0,
      witnessUtxo: {
        script: addr.script,
        amount: 10000n,
      },
      tapInternalKey: xOnlyPub,
    })
    // Input 1 - will be signed
    tx.addInput({
      txid: '0000000000000000000000000000000000000000000000000000000000000002',
      index: 0,
      witnessUtxo: {
        script: addr.script,
        amount: 10000n,
      },
      tapInternalKey: xOnlyPub,
    })
    tx.addOutput({
      script: addr.script,
      amount: 18000n,
    })

    const psbtHex = bytesToHex(tx.toPSBT())

    // Sign with skipSignIndex=0, disableExtract=true so we can inspect
    const result = signPsbt({
      psbt: psbtHex,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      disableExtract: true,
      skipSignIndex: 0,
    })

    const parsed = btc.Transaction.fromPSBT(hexToBytes(result))
    // Input 0 should NOT have finalScriptWitness (was skipped)
    const input0 = parsed.getInput(0)
    expect(input0.finalScriptWitness).toBeUndefined()
    // Input 1 should have finalScriptWitness (was signed)
    const input1 = parsed.getInput(1)
    expect(input1.finalScriptWitness).toBeDefined()
  })
})
