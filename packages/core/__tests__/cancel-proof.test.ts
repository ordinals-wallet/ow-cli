import { describe, it, expect } from 'vitest'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { keypairFromMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'
import {
  buildCancelProof,
  inspectCancelProof,
  CANCEL_PROOF_OUTPUT_SATS,
  CANCEL_PROOF_SIGHASH,
} from '../src/cancel-proof.js'
import { PassthroughError } from '../src/passthrough.js'

const owner = keypairFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
const other = keypairFromMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')
const TXID = 'ab'.repeat(16) + 'cd'.repeat(16)
const OUTPOINT = `${TXID}:3`
const VALUE = 546

const proof = () => buildCancelProof({ outpoint: OUTPOINT, valueSats: VALUE, privateKey: owner.privateKey, publicKey: owner.publicKey })

describe('buildCancelProof', () => {
  it('spends exactly the listed outpoint as input 0 (also the last input)', () => {
    const shape = inspectCancelProof(proof())
    expect(shape.inputs).toBe(1)
    expect(shape.outputs).toBe(1)
    expect(shape.outpoint).toBe(OUTPOINT)
    // Wire order: the serialized prevout carries the txid byte-reversed.
    const tx = btc.Transaction.fromPSBT(hexToBytes(proof()))
    const raw = bytesToHex(tx.unsignedTx)
    expect(raw).toContain(TXID.match(/../g)!.reverse().join('') + '03000000')
  })

  it('signs SIGHASH_DEFAULT on the key path: 64-byte signature, never ANYONECANPAY', () => {
    const shape = inspectCancelProof(proof())
    expect(shape.signatureLength).toBe(64)
    expect(shape.sighash).toBe(CANCEL_PROOF_SIGHASH)
    expect(shape.sighash & 0x80).toBe(0)
    const input = btc.Transaction.fromPSBT(hexToBytes(proof())).getInput(0)
    expect(input.finalScriptWitness).toHaveLength(1)
    expect(input.sighashType === undefined || input.sighashType === 0).toBe(true)
  })

  it('carries a signature that verifies against the owner output key (what the API checks)', async () => {
    const tx = btc.Transaction.fromPSBT(hexToBytes(proof()))
    const { script } = publicKeyToP2TR(owner.publicKey)
    const input = tx.getInput(0)
    expect(bytesToHex(input.witnessUtxo!.script)).toBe(bytesToHex(script))
    expect(input.witnessUtxo!.amount).toBe(BigInt(VALUE))
    const msg = tx.preimageWitnessV1(0, [script], CANCEL_PROOF_SIGHASH, [BigInt(VALUE)])
    const outputKey = script.slice(2)
    const sig = input.finalScriptWitness![0]
    expect(await secp.schnorr.verify(sig, msg, outputKey)).toBe(true)
    // Not valid for someone else's key.
    const { script: otherScript } = publicKeyToP2TR(other.publicKey)
    expect(await secp.schnorr.verify(sig, msg, otherScript.slice(2))).toBe(false)
  })

  it('pays 21M BTC back to the owner so the proof can never be mined', () => {
    const shape = inspectCancelProof(proof())
    expect(shape.outputSats).toBe(CANCEL_PROOF_OUTPUT_SATS)
    expect(shape.outputSats > BigInt(VALUE)).toBe(true)
    const out = btc.Transaction.fromPSBT(hexToBytes(proof())).getOutput(0)
    expect(bytesToHex(out.script!)).toBe(bytesToHex(publicKeyToP2TR(owner.publicKey).script))
  })

  it('refuses a mismatched key pair, bad outpoints and bad values', () => {
    expect(() => buildCancelProof({ outpoint: OUTPOINT, valueSats: VALUE, privateKey: other.privateKey, publicKey: owner.publicKey }))
      .toThrow(PassthroughError)
    expect(() => buildCancelProof({ outpoint: 'nope', valueSats: VALUE, privateKey: owner.privateKey, publicKey: owner.publicKey }))
      .toThrow(/Invalid outpoint/)
    expect(() => buildCancelProof({ outpoint: OUTPOINT, valueSats: 0, privateKey: owner.privateKey, publicKey: owner.publicKey }))
      .toThrow(/Invalid outpoint value/)
  })

  it('an ALL|ANYONECANPAY signature is reported as 0x81 by the inspector', () => {
    // Guard for the server rule: a 65-byte signature ending 0x81 is a seal, not a proof.
    const { script } = publicKeyToP2TR(owner.publicKey)
    const tx = new btc.Transaction({ allowUnknownOutputs: true })
    tx.addInput({ txid: hexToBytes(TXID), index: 3, witnessUtxo: { script, amount: BigInt(VALUE) }, tapInternalKey: script.slice(2), sighashType: 0x81 })
    tx.addOutput({ script, amount: 1n })
    tx.updateInput(0, { finalScriptWitness: [new Uint8Array([...new Uint8Array(64).fill(1), 0x81])] }, true)
    expect(inspectCancelProof(bytesToHex(tx.toPSBT())).sighash).toBe(0x81)
  })
})
