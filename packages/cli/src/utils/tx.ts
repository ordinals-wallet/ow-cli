import type { KeyPair } from '@ow-cli/core'
import { signAndBroadcast } from '@ow-cli/shared'
import { formatJson } from '../output.js'

export async function signBroadcastAndPrint(
  psbt: string,
  kp: KeyPair,
  opts: { json?: boolean },
): Promise<void> {
  const result = await signAndBroadcast(psbt, kp)

  if (opts.json) {
    console.log(formatJson(result))
  } else {
    console.log(`\nTransaction broadcast!`)
    console.log(`TXID: ${result.txid}`)
  }
}
