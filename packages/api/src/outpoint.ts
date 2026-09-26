/**
 * Helpers for the API's serialized outpoints.
 *
 * `/wallet/:address`, `/wallet/:address/inscriptions` and
 * `/inscription/:id/outpoint` return outpoints as 72 hex chars: the txid in
 * little-endian (raw) byte order followed by `vout` as a 4-byte
 * little-endian integer. Listing endpoints (`/collection/:slug/escrows`)
 * already use `txid:vout`.
 */

const SERIALIZED_RE = /^[0-9a-fA-F]{72}$/
const TXID_VOUT_RE = /^[0-9a-fA-F]{64}:\d+$/

export function isSerializedOutpoint(value: unknown): value is string {
  return typeof value === 'string' && SERIALIZED_RE.test(value)
}

/** Splits a 72-hex serialized outpoint into `{ txid, vout }`. Works in Node and browsers. */
export function parseSerializedOutpoint(serialized: string): { txid: string; vout: number } {
  if (!isSerializedOutpoint(serialized)) {
    throw new TypeError(`Invalid serialized outpoint (expected 72 hex chars): ${String(serialized)}`)
  }
  const hex = serialized.toLowerCase()
  const txid = hex.slice(0, 64).match(/../g)!.reverse().join('')
  const v = hex.slice(64)
  const vout =
    (parseInt(v.slice(0, 2), 16) |
      (parseInt(v.slice(2, 4), 16) << 8) |
      (parseInt(v.slice(4, 6), 16) << 16)) +
    parseInt(v.slice(6, 8), 16) * 0x1000000
  return { txid, vout }
}

/**
 * Converts a serialized outpoint to `txid:vout`.
 *
 * Accepts `txid:vout` unchanged, so callers can normalise outpoints from any
 * endpoint without checking which format they got.
 *
 * @example outpointToTxidVout('73285f…c6f500000000') // 'f5c605…2873:0'
 */
export function outpointToTxidVout(serialized: string): string {
  if (typeof serialized === 'string' && TXID_VOUT_RE.test(serialized)) return serialized.toLowerCase()
  const { txid, vout } = parseSerializedOutpoint(serialized)
  return `${txid}:${vout}`
}

/** Inverse of {@link outpointToTxidVout}: `txid:vout` to the 72-hex serialized form. */
export function txidVoutToSerialized(txidVout: string): string {
  if (!TXID_VOUT_RE.test(txidVout)) {
    throw new TypeError(`Invalid outpoint (expected <64-hex txid>:<vout>): ${txidVout}`)
  }
  const [txid, voutStr] = txidVout.split(':')
  const vout = Number(voutStr)
  if (!Number.isSafeInteger(vout) || vout > 0xffffffff) {
    throw new TypeError(`vout out of range: ${voutStr}`)
  }
  const le = [vout & 0xff, (vout >>> 8) & 0xff, (vout >>> 16) & 0xff, (vout >>> 24) & 0xff]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return txid.toLowerCase().match(/../g)!.reverse().join('') + le
}
