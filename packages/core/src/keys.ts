import { HDKey } from '@scure/bip32'
import {
  generateMnemonic as genMnemonic,
  mnemonicToSeedSync,
  validateMnemonic as validateMnemo,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import type { KeyPair } from './types.js'

const DERIVATION_PATH = "m/86'/0'/0'/0/0"

export function generateMnemonic(): string {
  return genMnemonic(wordlist, 128)
}

export function validateMnemonic(mnemonic: string): boolean {
  return validateMnemo(mnemonic, wordlist)
}

export function keypairFromMnemonic(mnemonic: string): KeyPair {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic')
  }
  const seed = mnemonicToSeedSync(mnemonic)
  const master = HDKey.fromMasterSeed(seed)
  const derived = master.derive(DERIVATION_PATH)

  if (!derived.privateKey) {
    throw new Error('Failed to derive private key')
  }

  const privateKey = new Uint8Array(derived.privateKey)
  const publicKey = new Uint8Array(derived.publicKey!)
  const xOnlyPublicKey = secp.schnorr.getPublicKey(privateKey)

  return { privateKey, publicKey, xOnlyPublicKey }
}

export function keypairFromWIF(wif: string): KeyPair {
  const privateKey = decodeWIF(wif)
  const publicKey = secp.getPublicKey(privateKey, true)
  const xOnlyPublicKey = secp.schnorr.getPublicKey(privateKey)

  return { privateKey, publicKey, xOnlyPublicKey }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decodeWIF(wif: string): Uint8Array {
  // Base58 decode
  let num = 0n
  for (const char of wif) {
    const idx = BASE58_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error('Invalid WIF character: ' + char)
    num = num * 58n + BigInt(idx)
  }

  // Determine expected length from WIF prefix
  // Compressed WIF starts with K or L (mainnet): 38 bytes
  // Uncompressed WIF starts with 5 (mainnet): 37 bytes
  const isCompressed = wif[0] === 'K' || wif[0] === 'L'
  const expectedLen = isCompressed ? 38 : 37

  let hex = num.toString(16)
  hex = hex.padStart(expectedLen * 2, '0')

  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))

  // Verify checksum
  const payload = bytes.slice(0, -4)
  const checksum = bytes.slice(-4)
  const hash = sha256(sha256(payload))
  for (let i = 0; i < 4; i++) {
    if (hash[i] !== checksum[i]) {
      throw new Error('Invalid WIF checksum')
    }
  }

  // Extract private key (skip version byte)
  return payload.slice(1, 33)
}
