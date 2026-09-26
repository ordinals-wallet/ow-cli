/**
 * BIP-322 "simple" message signatures for P2TR (key path) and P2WPKH.
 *
 * A simple signature is the witness stack of a virtual `to_sign` transaction
 * spending a virtual `to_spend` output locked to the signer's address,
 * serialized and base64 encoded. This is what Ordinals Wallet's
 * `POST /auth/session` verifies (`bip322::verify_simple_encoded`).
 *
 * https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 */
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from './signer.js'

const MESSAGE_TAG = 'BIP0322-signed-message'
const SIGHASH_DEFAULT = 0x00
const SIGHASH_ALL = 0x01

export type Bip322AddressType = 'p2tr' | 'p2wpkh'

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(encoder.encode(tag))
  return sha256(concat(t, t, msg))
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0, true)
  return b
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  return concat(Uint8Array.of(0xfe), u32le(n))
}

function varbytes(b: Uint8Array): Uint8Array {
  return concat(varint(b.length), b)
}

/** `tagged_hash("BIP0322-signed-message", message)`. */
export function bip322MessageHash(message: string | Uint8Array): Uint8Array {
  const bytes = typeof message === 'string' ? encoder.encode(message) : message
  return taggedHash(MESSAGE_TAG, bytes)
}

/** Output script for a mainnet bc1p / bc1q address, with its type. */
export function bip322AddressScript(address: string): { type: Bip322AddressType; script: Uint8Array } {
  const decoded = btc.Address(btc.NETWORK).decode(address)
  if (decoded.type === 'tr') return { type: 'p2tr', script: btc.OutScript.encode(decoded) }
  if (decoded.type === 'wpkh') return { type: 'p2wpkh', script: btc.OutScript.encode(decoded) }
  throw new Error(`BIP-322: unsupported address type ${decoded.type} (only bc1p and bc1q are supported)`)
}

/** Display-order txid of the virtual `to_spend` transaction. */
export function bip322ToSpendTxid(scriptPubKey: Uint8Array, message: string | Uint8Array): string {
  const scriptSig = concat(Uint8Array.of(0x00, 0x20), bip322MessageHash(message))
  const raw = concat(
    u32le(0), // version
    varint(1),
    new Uint8Array(32), // prevout txid
    u32le(0xffffffff), // prevout vout
    varbytes(scriptSig),
    u32le(0), // sequence
    varint(1),
    new Uint8Array(8), // value 0
    varbytes(scriptPubKey),
    u32le(0), // locktime
  )
  return bytesToHex(sha256(sha256(raw)).reverse())
}

function toSignTx(scriptPubKey: Uint8Array, message: string | Uint8Array, extra: Record<string, unknown> = {}) {
  const tx = new btc.Transaction({ version: 0, allowUnknownOutputs: true })
  tx.addInput({
    txid: bip322ToSpendTxid(scriptPubKey, message),
    index: 0,
    sequence: 0,
    witnessUtxo: { script: scriptPubKey, amount: 0n },
    ...extra,
  })
  tx.addOutput({ script: Uint8Array.of(0x6a), amount: 0n }) // OP_RETURN
  return tx
}

function encodeWitness(stack: Uint8Array[]): string {
  const bytes = concat(varint(stack.length), ...stack.map(varbytes))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function decodeWitness(encoded: string): Uint8Array[] {
  // Newer BIP-322 revisions prefix simple signatures with "smp"; accept both.
  const bin = atob(encoded.startsWith('smp') ? encoded.slice(3) : encoded)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  let off = 0
  const readVarint = (): number => {
    const first = bytes[off++]
    if (first === undefined) throw new Error('BIP-322: truncated signature')
    if (first < 0xfd) return first
    if (first === 0xfd) {
      const v = bytes[off] | (bytes[off + 1] << 8)
      off += 2
      return v
    }
    throw new Error('BIP-322: oversized witness item')
  }
  const n = readVarint()
  const stack: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const len = readVarint()
    if (off + len > bytes.length) throw new Error('BIP-322: truncated signature')
    stack.push(bytes.slice(off, off + len))
    off += len
  }
  if (off !== bytes.length) throw new Error('BIP-322: trailing bytes in signature')
  return stack
}

/**
 * Sign `message` for `address` with a BIP-322 simple signature (base64).
 *
 * - `bc1p…`: key-path Schnorr signature with SIGHASH_DEFAULT (64 bytes). The
 *   address must be the BIP-86 key-path output of `privateKey`.
 * - `bc1q…`: ECDSA signature with SIGHASH_ALL plus the compressed public key.
 */
export function signBip322Simple(address: string, message: string | Uint8Array, privateKey: Uint8Array): string {
  const { type, script } = bip322AddressScript(address)
  if (type === 'p2tr') {
    const xOnly = secp.schnorr.getPublicKey(privateKey)
    const expected = btc.p2tr(xOnly).script
    if (bytesToHex(expected) !== bytesToHex(script)) {
      throw new Error('BIP-322: private key does not control this taproot address')
    }
    const tx = toSignTx(script, message, { tapInternalKey: xOnly })
    tx.signIdx(privateKey, 0, [SIGHASH_DEFAULT])
    const sig = tx.getInput(0).tapKeySig
    if (!sig) throw new Error('BIP-322: taproot signing failed')
    return encodeWitness([sig])
  }
  const pubkey = secp.getPublicKey(privateKey, true)
  const expected = btc.p2wpkh(pubkey).script
  if (bytesToHex(expected) !== bytesToHex(script)) {
    throw new Error('BIP-322: private key does not control this segwit address')
  }
  const tx = toSignTx(script, message)
  tx.signIdx(privateKey, 0, [SIGHASH_ALL])
  const partial = tx.getInput(0).partialSig
  if (!partial || partial.length !== 1) throw new Error('BIP-322: segwit signing failed')
  const [pk, sig] = partial[0]
  return encodeWitness([sig, pk])
}

/**
 * Verify a BIP-322 simple signature for a bc1p (key path) or bc1q address.
 * Returns false for anything malformed rather than throwing.
 */
export async function verifyBip322Simple(
  address: string,
  message: string | Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    const { type, script } = bip322AddressScript(address)
    const stack = decodeWitness(signature)
    const tx = toSignTx(script, message)
    if (type === 'p2tr') {
      if (stack.length !== 1) return false
      const sig = stack[0]
      let hashType = SIGHASH_DEFAULT
      if (sig.length === 65) {
        hashType = sig[64]
        if (hashType !== SIGHASH_ALL) return false
      } else if (sig.length !== 64) {
        return false
      }
      const msg = tx.preimageWitnessV1(0, [script], hashType, [0n])
      const outputKey = script.slice(2, 34)
      return await secp.schnorr.verify(sig.slice(0, 64), msg, outputKey)
    }
    if (stack.length !== 2) return false
    const [sig, pubkey] = stack
    if (pubkey.length !== 33 || sig[sig.length - 1] !== SIGHASH_ALL) return false
    if (bytesToHex(btc.p2wpkh(pubkey).script) !== bytesToHex(script)) return false
    const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: script.slice(2) })
    const msg = tx.preimageWitnessV0(0, scriptCode, SIGHASH_ALL, 0n)
    return secp.verify(sig.slice(0, -1), msg, pubkey)
  } catch {
    return false
  }
}
