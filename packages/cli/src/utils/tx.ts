import { signPsbt } from '@ow-cli/core'
import type { KeyPair } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import { formatJson } from '../output.js'

export async function signBroadcastAndPrint(
  psbt: string,
  kp: KeyPair,
  opts: { json?: boolean },
): Promise<void> {
  const rawtx = signPsbt({
    psbt,
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    disableExtract: false,
  })

  const result = await api.wallet.broadcast(rawtx)

  if (opts.json) {
    console.log(formatJson(result))
  } else {
    console.log(`\nTransaction broadcast!`)
    console.log(`TXID: ${result.txid}`)
  }
}
