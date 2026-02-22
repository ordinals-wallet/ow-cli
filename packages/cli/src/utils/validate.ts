import { CliError } from './errors.js'

// inscription_id: 64 hex chars + 'i' + non-negative integer
const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d+$/

// outpoint: 64 hex chars + ':' + non-negative integer
const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/

// Bitcoin address: mainnet bech32/bech32m (bc1), legacy (1), p2sh (3)
const BTC_ADDRESS_RE = /^(bc1[a-z0-9]{25,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/

export function validateInscriptionId(value: string): string {
  if (!INSCRIPTION_ID_RE.test(value)) {
    throw new CliError(
      `Invalid inscription ID: "${value}"\nExpected format: <64-char txid>i<index>  (e.g. abc123...i0)`
    )
  }
  return value
}

export function validateOutpoint(value: string): string {
  if (!OUTPOINT_RE.test(value)) {
    throw new CliError(
      `Invalid outpoint: "${value}"\nExpected format: <64-char txid>:<vout>  (e.g. abc123...ef:0)`
    )
  }
  return value
}

export function validateAddress(value: string): string {
  if (!BTC_ADDRESS_RE.test(value)) {
    throw new CliError(`Invalid Bitcoin address: "${value}"`)
  }
  return value
}

export function validateFeeRate(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) {
    throw new CliError(`Invalid fee rate: "${value}" (must be a positive integer)`)
  }
  return n
}

export function validatePrice(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) {
    throw new CliError(`Invalid price: "${value}" (must be a positive integer in sats)`)
  }
  return n
}

export function validateSats(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 1) {
    throw new CliError(`Invalid amount: "${value}" (must be a positive integer in sats)`)
  }
  return n
}
