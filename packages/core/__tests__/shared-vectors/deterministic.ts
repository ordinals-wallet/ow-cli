/**
 * Makes every Schnorr signature this package produces reproducible by
 * passing all-zero BIP-340 auxiliary randomness: `Transaction.signIdx`
 * (btc-signer) gets `_auxRand = 0x00…00`, and `@noble/secp256k1`'s
 * `schnorr.signSync` default aux (from `utils.randomBytes`) returns zeros.
 *
 * Only the shared-vector generator and its test use this, so the TypeScript
 * implementation reproduces the vectors byte for byte and the Rust SDK
 * (`SigningKey::with_aux_rand([0; 32])`) must produce the same bytes. ECDSA
 * is RFC 6979 deterministic already.
 */
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'

export const ZERO_AUX_HEX = '00'.repeat(32)

export function useZeroAuxRand(): () => void {
  const proto = btc.Transaction.prototype as unknown as {
    signIdx: (this: unknown, key: unknown, idx: number, allowed?: number[], aux?: Uint8Array) => boolean
  }
  const signIdx = proto.signIdx
  proto.signIdx = function (key, idx, allowed, aux) {
    return signIdx.call(this, key, idx, allowed, aux ?? new Uint8Array(32))
  }
  const utils = secp.utils as { randomBytes: (n?: number) => Uint8Array }
  const randomBytes = utils.randomBytes
  utils.randomBytes = (n = 32) => new Uint8Array(n)
  return () => {
    proto.signIdx = signIdx
    utils.randomBytes = randomBytes
  }
}
