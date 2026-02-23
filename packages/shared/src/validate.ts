import type { RuneOutpoint } from '@ow-cli/api'

// inscription_id: 64 hex chars + 'i' + non-negative integer
const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d+$/

// outpoint: 64 hex chars + ':' + non-negative integer
const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/

// Bitcoin address: mainnet bech32/bech32m (bc1), legacy (1), p2sh (3)
const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function validateInscriptionId(value: string): string {
  if (!INSCRIPTION_ID_RE.test(value)) {
    throw new ValidationError(
      `Invalid inscription ID: "${value}"\nExpected format: <64-char txid>i<index>  (e.g. abc123...i0)`
    )
  }
  return value
}

export function validateOutpoint(value: string): string {
  if (!OUTPOINT_RE.test(value)) {
    throw new ValidationError(
      `Invalid outpoint: "${value}"\nExpected format: <64-char txid>:<vout>  (e.g. abc123...ef:0)`
    )
  }
  return value
}

export function validateAddress(value: string): string {
  if (!BTC_ADDRESS_RE.test(value)) {
    throw new ValidationError(`Invalid Bitcoin address: "${value}"`)
  }
  return value
}

export function validateFeeRate(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) {
    throw new ValidationError(`Invalid fee rate: "${value}" (must be a positive integer)`)
  }
  return n
}

export function validatePrice(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) {
    throw new ValidationError(`Invalid price: "${value}" (must be a positive integer in sats)`)
  }
  return n
}

export function validateSats(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) {
    throw new ValidationError(`Invalid amount: "${value}" (must be a positive integer in sats)`)
  }
  return n
}

// rune_id: block:tx (e.g. "840000:1")
const RUNE_ID_RE = /^\d+:\d+$/

export function validateRuneId(value: string): string {
  if (!RUNE_ID_RE.test(value)) {
    throw new ValidationError(
      `Invalid rune ID: "${value}"\nExpected format: <block>:<tx>  (e.g. 840000:1)`
    )
  }
  return value
}

export function validateAmount(value: string): string {
  const n = parseFloat(value)
  if (isNaN(n) || n <= 0) {
    throw new ValidationError(`Invalid amount: "${value}" (must be a positive number)`)
  }
  return value
}

export function validateSplits(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 2 || n > 25) {
    throw new ValidationError(`Invalid splits: "${value}" (must be an integer between 2 and 25)`)
  }
  return n
}

// outpoint with sats for consolidation: <64hex>:<vout>:<sats>
const OUTPOINT_WITH_SATS_RE = /^[0-9a-f]{64}:\d+:\d+$/

export function validateOutpointWithSats(value: string): { txid: string; vout: number; sats: number } {
  if (!OUTPOINT_WITH_SATS_RE.test(value)) {
    throw new ValidationError(
      `Invalid outpoint: "${value}"\nExpected format: <64-char txid>:<vout>:<sats>  (e.g. abc123...ef:0:10000)`
    )
  }
  const parts = value.split(':')
  return { txid: parts[0], vout: parseInt(parts[1], 10), sats: parseInt(parts[2], 10) }
}

// outpoint with sats for rune outpoints: <64hex>:<vout>,<sats>
const OUTPOINT_WITH_SATS_SHORT_RE = /^[0-9a-f]{64}:\d+,\d+$/

export function validateOutpointWithSatsShort(value: string): { outpoint: string; sats: number } {
  if (!OUTPOINT_WITH_SATS_SHORT_RE.test(value)) {
    throw new ValidationError(
      `Invalid outpoint: "${value}"\nExpected format: <64-char txid>:<vout>,<sats>  (e.g. abc123...ef:0,546)`
    )
  }
  const commaIdx = value.lastIndexOf(',')
  return { outpoint: value.slice(0, commaIdx), sats: parseInt(value.slice(commaIdx + 1), 10) }
}

export function validateOutputPair(value: string): { address: string; sats: number } {
  const idx = value.lastIndexOf(':')
  if (idx === -1) {
    throw new ValidationError(
      `Invalid output pair: "${value}"\nExpected format: <address>:<sats>  (e.g. bc1p...abc:10000)`
    )
  }
  const address = value.slice(0, idx)
  const satsStr = value.slice(idx + 1)
  if (!address) {
    throw new ValidationError(`Invalid output pair: "${value}"\nAddress cannot be empty`)
  }
  const sats = parseInt(satsStr, 10)
  if (isNaN(sats) || sats < 1) {
    throw new ValidationError(`Invalid output pair: "${value}"\nSats must be a positive integer`)
  }
  return { address, sats }
}

export function parseOutpoints(raw: string): RuneOutpoint[] {
  return raw.trim().split(/\s+/).map((s) => validateOutpointWithSatsShort(s))
}
