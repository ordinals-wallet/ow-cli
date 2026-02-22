import * as btc from '@scure/btc-signer'
import type { AddressInfo } from './types.js'

export function toXOnly(pubkey: Uint8Array): Uint8Array {
  // If 33-byte compressed pubkey, strip the prefix byte
  if (pubkey.length === 33) {
    return pubkey.slice(1)
  }
  // Already 32-byte x-only
  if (pubkey.length === 32) {
    return pubkey
  }
  throw new Error('Invalid public key length: ' + pubkey.length)
}

export function publicKeyToP2TR(pubkey: Uint8Array): AddressInfo {
  const xOnly = toXOnly(pubkey)
  const p2tr = btc.p2tr(xOnly)

  return {
    address: p2tr.address!,
    script: p2tr.script,
    tapInternalKey: xOnly,
  }
}
