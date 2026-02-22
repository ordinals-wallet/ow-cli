import { Command } from 'commander'
import type { RuneEdict } from '@ow-cli/api'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword, requireConfirm } from '../utils/prompts.js'
import { handleError } from '../utils/errors.js'
import {
  validateRuneId,
  validateAmount,
  validateSplits,
  validateAddress,
  validateFeeRate,
  parseOutpoints,
} from '../utils/validate.js'
import { buildSplitEdicts } from './rune.js'
import { signBroadcastAndPrint } from '../utils/tx.js'

interface EdictConfig {
  label: string
  buildTransfer: (params: {
    fee_rate: number
    from: string
    public_key: string
    edicts: RuneEdict[]
    outpoints: { outpoint: string; sats: number }[]
  }) => Promise<{ psbt: string }>
}

export function registerEdictSend(parent: Command, config: EdictConfig): void {
  parent
    .command('send')
    .description(`Transfer ${config.label.toLowerCase()} via edicts`)
    .requiredOption('--rune-id <id>', `${config.label} ID (block:tx)`)
    .requiredOption('--amount <n>', 'Amount to send')
    .requiredOption('--divisibility <n>', `${config.label} divisibility`)
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .requiredOption('--outpoints <list>', 'Space-separated outpoint:vout,sats')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const runeId = validateRuneId(opts.runeId)
        const amount = validateAmount(opts.amount)
        const divisibility = parseInt(opts.divisibility, 10)
        validateAddress(opts.to)
        const feeRate = validateFeeRate(opts.feeRate)
        const outpoints = parseOutpoints(opts.outpoints)
        const pubInfo = requirePublicInfo()

        const edicts: RuneEdict[] = [{
          rune_id: runeId,
          amount,
          divisibility,
          destination: opts.to,
        }]

        console.log(`\nSending ${amount} of ${config.label.toLowerCase()} ${runeId} to ${opts.to}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed with transfer?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await config.buildTransfer({
          fee_rate: feeRate,
          from: pubInfo.address,
          public_key: pubInfo.publicKey,
          edicts,
          outpoints,
        })

        await signBroadcastAndPrint(psbt, kp, opts)
      } catch (err) {
        handleError(err)
      }
    })
}

export function registerEdictSplit(parent: Command, config: EdictConfig): void {
  parent
    .command('split')
    .description(`Split ${config.label.toLowerCase()} balance across N UTXOs`)
    .requiredOption('--rune-id <id>', `${config.label} ID (block:tx)`)
    .requiredOption('--amount <n>', 'Total amount to split')
    .requiredOption('--splits <n>', 'Number of splits (2-25)')
    .requiredOption('--divisibility <n>', `${config.label} divisibility`)
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .requiredOption('--outpoints <list>', 'Space-separated outpoint:vout,sats')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const runeId = validateRuneId(opts.runeId)
        const amount = validateAmount(opts.amount)
        const splits = validateSplits(opts.splits)
        const divisibility = parseInt(opts.divisibility, 10)
        const feeRate = validateFeeRate(opts.feeRate)
        const outpoints = parseOutpoints(opts.outpoints)
        const pubInfo = requirePublicInfo()

        const edicts = buildSplitEdicts(runeId, amount, splits, divisibility, pubInfo.address)

        console.log(`\nSplitting ${amount} of ${config.label.toLowerCase()} ${runeId} into ${splits} UTXOs`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed with split?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await config.buildTransfer({
          fee_rate: feeRate,
          from: pubInfo.address,
          public_key: pubInfo.publicKey,
          edicts,
          outpoints,
        })

        await signBroadcastAndPrint(psbt, kp, opts)
      } catch (err) {
        handleError(err)
      }
    })
}
