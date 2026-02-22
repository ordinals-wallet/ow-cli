import { Command } from 'commander'
import * as api from '@ow-cli/api'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword, requireConfirm } from '../utils/prompts.js'
import { formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import { validateAddress, validateFeeRate, validateSats } from '../utils/validate.js'
import { signBroadcastAndPrint } from '../utils/tx.js'

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
        const pubInfo = requirePublicInfo()

        console.log(`\nSending ${formatSats(amount)} to ${opts.to}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await api.transfer.buildSend({
          from: pubInfo.address,
          to: opts.to,
          amount,
          fee_rate: feeRate,
          public_key: pubInfo.publicKey,
        })

        await signBroadcastAndPrint(psbt, kp, opts)
      } catch (err) {
        handleError(err)
      }
    })
}
