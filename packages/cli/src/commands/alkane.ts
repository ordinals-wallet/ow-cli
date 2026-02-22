import { Command } from 'commander'
import { signPsbt, keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { RuneEdict, RuneOutpoint, AlkanesBalance } from '@ow-cli/api'
import { loadKeystore, getPublicInfo } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import {
  validateRuneId,
  validateAmount,
  validateSplits,
  validateAddress,
  validateFeeRate,
  validateOutpointWithSatsShort,
} from '../utils/validate.js'
import { buildSplitEdicts } from './rune.js'

function getKeypair(seed: string) {
  const words = seed.trim().split(/\s+/)
  if (words.length >= 12) {
    return keypairFromMnemonic(seed.trim())
  }
  return keypairFromWIF(seed.trim())
}

function parseOutpoints(raw: string): RuneOutpoint[] {
  return raw.split(',').map((s) => {
    const parsed = validateOutpointWithSatsShort(s.trim())
    return parsed
  })
}

export function registerAlkaneCommands(parent: Command): void {
  const alkane = parent.command('alkane').description('Alkane commands')

  alkane
    .command('balance')
    .description('Show Alkanes token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const tokens = await api.wallet.getAlkanesBalance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log('No Alkanes balances.')
          return
        }

        const rows = tokens.map((t: AlkanesBalance) => [t.id || '', t.balance || ''])
        console.log(formatTable(['ID', 'Balance'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  alkane
    .command('send')
    .description('Transfer alkanes via edicts')
    .requiredOption('--rune-id <id>', 'Alkane ID (block:tx)')
    .requiredOption('--amount <n>', 'Amount to send')
    .requiredOption('--divisibility <n>', 'Alkane divisibility')
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .requiredOption('--outpoints <list>', 'Comma-separated outpoint:vout,sats')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const runeId = validateRuneId(opts.runeId)
        const amount = validateAmount(opts.amount)
        const divisibility = parseInt(opts.divisibility, 10)
        validateAddress(opts.to)
        const feeRate = validateFeeRate(opts.feeRate)
        const outpoints = parseOutpoints(opts.outpoints)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        const edicts: RuneEdict[] = [{
          rune_id: runeId,
          amount,
          divisibility,
          destination: opts.to,
        }]

        console.log(`\nSending ${amount} of alkane ${runeId} to ${opts.to}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with transfer?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        const { psbt } = await api.transfer.buildAlkaneTransfer({
          fee_rate: feeRate,
          from: pubInfo.address,
          public_key: pubInfo.publicKey,
          edicts,
          outpoints,
        })

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
      } catch (err) {
        handleError(err)
      }
    })

  alkane
    .command('split')
    .description('Split alkane balance across N UTXOs')
    .requiredOption('--rune-id <id>', 'Alkane ID (block:tx)')
    .requiredOption('--amount <n>', 'Total amount to split')
    .requiredOption('--splits <n>', 'Number of splits (2-25)')
    .requiredOption('--divisibility <n>', 'Alkane divisibility')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .requiredOption('--outpoints <list>', 'Comma-separated outpoint:vout,sats')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const runeId = validateRuneId(opts.runeId)
        const amount = validateAmount(opts.amount)
        const splits = validateSplits(opts.splits)
        const divisibility = parseInt(opts.divisibility, 10)
        const feeRate = validateFeeRate(opts.feeRate)
        const outpoints = parseOutpoints(opts.outpoints)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        const edicts = buildSplitEdicts(runeId, amount, splits, divisibility, pubInfo.address)

        console.log(`\nSplitting ${amount} of alkane ${runeId} into ${splits} UTXOs`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with split?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        const { psbt } = await api.transfer.buildAlkaneTransfer({
          fee_rate: feeRate,
          from: pubInfo.address,
          public_key: pubInfo.publicKey,
          edicts,
          outpoints,
        })

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
      } catch (err) {
        handleError(err)
      }
    })
}
