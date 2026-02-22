import { Command } from 'commander'
import { signPsbt, keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import { loadKeystore, getPublicInfo } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import { validateAddress, validateFeeRate, validateSats } from '../utils/validate.js'

function getKeypair(seed: string) {
  const words = seed.trim().split(/\s+/)
  if (words.length >= 12) {
    return keypairFromMnemonic(seed.trim())
  }
  return keypairFromWIF(seed.trim())
}

export function registerSendCommand(parent: Command): void {
  parent
    .command('send <sats>')
    .description('Send satoshis to an address')
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (sats: string, opts) => {
      try {
        const amount = validateSats(sats)
        validateAddress(opts.to)
        const feeRate = validateFeeRate(opts.feeRate)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        console.log(`\nSending ${formatSats(amount)} to ${opts.to}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        // Build send PSBT
        const { psbt } = await api.transfer.buildSend({
          from: pubInfo.address,
          to: opts.to,
          amount,
          fee_rate: feeRate,
          public_key: pubInfo.publicKey,
        })

        // Sign and extract
        const rawtx = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: false,
        })

        // Broadcast
        const result = await api.wallet.broadcast(rawtx)

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nTransaction broadcast!`)
          console.log(`TXID: ${result.txid}`)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
