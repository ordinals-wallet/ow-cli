import { publicKeyToP2TR, signBip322Simple, keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import type { KeyPair } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { AuthSession, MessageSigner } from '@ow-cli/api'

/** The SDK wallet's sign-in address: the key's BIP-86 taproot address. */
export function keypairAddress(kp: KeyPair): string {
  return publicKeyToP2TR(kp.publicKey).address
}

/** A BIP-322 signer for `address` (bc1p key path or bc1q) backed by an in-memory key. */
export function keypairMessageSigner(kp: KeyPair, address: string = keypairAddress(kp)): MessageSigner {
  return (message: string) => signBip322Simple(address, message, kp.privateKey)
}

function toKeypair(key: KeyPair | { mnemonic: string } | { wif: string }): KeyPair {
  if ('mnemonic' in key) return keypairFromMnemonic(key.mnemonic)
  if ('wif' in key) return keypairFromWIF(key.wif)
  return key
}

/**
 * Sign in to Ordinals Wallet with a key the SDK manages (keypair, mnemonic
 * or WIF). Defaults to the key's taproot address. Returns a 24-hour session.
 */
export async function signInWithKey(
  key: KeyPair | { mnemonic: string } | { wif: string },
  address?: string,
): Promise<AuthSession> {
  const kp = toKeypair(key)
  const addr = address ?? keypairAddress(kp)
  return api.auth.signIn({ address: addr, sign: keypairMessageSigner(kp, addr) })
}

/** A `SessionManager` that signs in with this key when a token is missing or near expiry. */
export function sessionManagerForKey(
  key: KeyPair | { mnemonic: string } | { wif: string },
  opts: { refreshBeforeSecs?: number } = {},
): api.SessionManager {
  const kp = toKeypair(key)
  return new api.SessionManager({
    ...opts,
    sign: (address, message) => signBip322Simple(address, message, kp.privateKey),
  })
}
