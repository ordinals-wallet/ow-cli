import { unlockKeypair, getPublicInfo, signAndBroadcast } from '@ow-cli/shared'
import { bytesToHex } from '@ow-cli/core'
import type { KeyPair } from '@ow-cli/core'

export interface UnlockedWallet {
  kp: KeyPair
  address: string
  publicKey: string
  privateKey: Uint8Array
  publicKeyBytes: Uint8Array
}

export function unlockWallet(password: string, walletId: string): UnlockedWallet {
  const kp = unlockKeypair(password, walletId)
  const info = getPublicInfo(walletId)
  if (!info) throw new Error('Wallet not found')
  return {
    kp,
    address: info.address,
    publicKey: info.publicKey,
    privateKey: kp.privateKey,
    publicKeyBytes: kp.publicKey,
  }
}

export async function buildSignBroadcast(opts: {
  password: string
  walletId: string
  buildTx: (wallet: UnlockedWallet) => Promise<{ psbt: string }>
}): Promise<{ txid: string }> {
  const wallet = unlockWallet(opts.password, opts.walletId)
  const { psbt } = await opts.buildTx(wallet)
  return signAndBroadcast(psbt, wallet.kp)
}
