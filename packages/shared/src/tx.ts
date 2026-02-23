import { signPsbt } from '@ow-cli/core'
import type { KeyPair } from '@ow-cli/core'
import * as api from '@ow-cli/api'

export async function signAndBroadcast(
  psbt: string,
  kp: KeyPair,
): Promise<{ txid: string }> {
  const rawtx = signPsbt({
    psbt,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    disableExtract: false,
  })

  return api.wallet.broadcast(rawtx)
}
