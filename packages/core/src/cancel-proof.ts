import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { publicKeyToP2TR } from './address.js'
import { bytesToHex, hexToBytes } from './signer.js'
import { PassthroughError } from './passthrough.js'

/**
 * @deprecated Legacy owner proof for `POST /market/cancel-escrow`. Send an
 * `/auth/session` token as `signature` instead (`delistListing` does). The
 * API accepts this proof for one release only.
 *
 * The API accepts it when the input that spends the listed outpoint (the
 * listing outpoint for `{ outpoint }`, the inscription's current location for
 * `{ inscription_id }`) verifies against that output's script AND amount as
 * read from the chain, is signed SIGHASH_DEFAULT/ALL, and commits to an
 * output of at least 21M BTC. It refuses SIGHASH_ALL|ANYONECANPAY
 * (`seal_not_a_cancel_proof`), a proof over a different outpoint
 * (`cancel_proof_wrong_outpoint`) and a mineable one (`cancel_proof_not_bound`).
 *
 * The proof built here has exactly one input and one output, so input 0 is
 * also the last input and the same proof satisfies either route. It is
 * signed on the Taproot key path with SIGHASH_DEFAULT (a 64-byte signature,
 * committing to every input and output), never ANYONECANPAY or SINGLE.
 *
 * The output pays MAX_MONEY (21M BTC) back to the owner, far more than the
 * input holds, so the proof is consensus-invalid: it can never be mined and
 * never moves the item, even if it leaks. The frontend's proof (a listing
 * PSBT at a 21M BTC price) relies on the same property.
 */

/** 21,000,000 BTC in sats. An output this large always exceeds the proof's single input. */
export const CANCEL_PROOF_OUTPUT_SATS = 2_100_000_000_000_000n

/** SIGHASH_DEFAULT: Taproot's commit-to-everything type, signalled by a 64-byte signature. */
export const CANCEL_PROOF_SIGHASH = 0x00

const ALL_ANYONECANPAY = 0x81
const TXID_VOUT_RE = /^[0-9a-fA-F]{64}:\d+$/

export interface CancelProofInput {
  /** `txid:vout` the listed item sits on (the listing outpoint for protected listings). */
  outpoint: string
  /** Value of that output in sats. Must match the chain: the API verifies against the on-chain amount. */
  valueSats: number | bigint
  privateKey: Uint8Array
  /** 33-byte compressed or 32-byte x-only public key of the owner. */
  publicKey: Uint8Array
}

function parseOutpoint(outpoint: string): { txid: Uint8Array; index: number } {
  if (!TXID_VOUT_RE.test(outpoint)) {
    throw new PassthroughError('invalid_outpoint', `Invalid outpoint (expected <txid>:<vout>): ${outpoint}`)
  }
  const [txid, vout] = outpoint.split(':')
  const index = Number(vout)
  if (!Number.isSafeInteger(index) || index > 0xffffffff) {
    throw new PassthroughError('invalid_outpoint', `vout out of range: ${vout}`)
  }
  return { txid: hexToBytes(txid.toLowerCase()), index }
}

/** Build and sign the cancel proof. Returns PSBT hex for `market.cancelEscrow({ signature })`. */
export function buildCancelProof(input: CancelProofInput): string {
  const { txid, index } = parseOutpoint(input.outpoint)
  const amount = BigInt(input.valueSats)
  if (amount <= 0n || amount >= CANCEL_PROOF_OUTPUT_SATS) {
    throw new PassthroughError('invalid_outpoint_value', `Invalid outpoint value: ${String(input.valueSats)}`)
  }
  const owner = publicKeyToP2TR(input.publicKey)
  const xOnly = secp.schnorr.getPublicKey(input.privateKey)
  if (bytesToHex(xOnly) !== bytesToHex(owner.tapInternalKey)) {
    throw new PassthroughError('key_mismatch', 'The private key does not match the public key')
  }

  const tx = new btc.Transaction({ version: 2, allowUnknownOutputs: true })
  tx.addInput({
    txid,
    index,
    witnessUtxo: { script: owner.script, amount },
    tapInternalKey: xOnly,
    sighashType: CANCEL_PROOF_SIGHASH,
  })
  tx.addOutput({ script: owner.script, amount: CANCEL_PROOF_OUTPUT_SATS })
  tx.signIdx(input.privateKey, 0, [CANCEL_PROOF_SIGHASH])
  // finalizeIdx() refuses outputs above inputs, which is the point of this
  // proof; finalize the key-path spend by hand, as signPsbt does.
  const tapKeySig = tx.getInput(0).tapKeySig
  if (!tapKeySig) throw new PassthroughError('invalid_cancel_proof', 'Signing the cancel proof failed')
  tx.updateInput(0, { finalScriptWitness: [tapKeySig] } as Record<string, unknown>, true)
  const psbt = bytesToHex(tx.toPSBT())
  assertCancelProofShape(psbt, owner.script)
  return psbt
}

export interface CancelProofShape {
  inputs: number
  outputs: number
  /** Sighash byte of the proof signature; 0x00 for a 64-byte Schnorr signature. */
  sighash: number
  signatureLength: number
  outpoint: string
  outputSats: bigint
}

/** Decode a cancel proof. Used by tests and as a self-check before anything is sent. */
export function inspectCancelProof(psbtHex: string): CancelProofShape {
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex), { allowUnknownOutputs: true })
  const input = tx.getInput(0)
  const witness = input.finalScriptWitness ?? []
  const sig = witness[0] ?? new Uint8Array()
  const sighash = sig.length === 65 ? sig[64] : sig.length === 64 ? CANCEL_PROOF_SIGHASH : -1
  return {
    inputs: tx.inputsLength,
    outputs: tx.outputsLength,
    sighash,
    signatureLength: sig.length,
    outpoint: `${bytesToHex(input.txid ?? new Uint8Array())}:${input.index}`,
    outputSats: tx.getOutput(0).amount ?? 0n,
  }
}

function assertCancelProofShape(psbtHex: string, ownerScript: Uint8Array): void {
  const shape = inspectCancelProof(psbtHex)
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex), { allowUnknownOutputs: true })
  const out = tx.getOutput(0)
  if (
    shape.inputs !== 1 ||
    shape.outputs !== 1 ||
    shape.signatureLength !== 64 ||
    shape.sighash === ALL_ANYONECANPAY ||
    shape.outputSats !== CANCEL_PROOF_OUTPUT_SATS ||
    !out.script ||
    bytesToHex(out.script) !== bytesToHex(ownerScript)
  ) {
    throw new PassthroughError('invalid_cancel_proof', 'Refusing to send a malformed cancel proof')
  }
}
