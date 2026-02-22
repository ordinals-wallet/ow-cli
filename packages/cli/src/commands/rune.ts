import { Command } from 'commander'
import { signPsbt, keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { RuneEdict, RuneOutpoint, RuneBalance } from '@ow-cli/api'
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

export function registerRuneCommands(parent: Command): void {
  const rune = parent.command('rune').description('Rune commands')

  rune
    .command('balance')
    .description('Show rune balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const runes = await api.wallet.getRuneBalance(info.address)

        if (opts.json) {
          console.log(formatJson(runes))
          return
        }

        if (runes.length === 0) {
          console.log('No rune balances.')
          return
        }

        const rows = runes.map((r: RuneBalance) => [r.name || '', r.amount || '', r.symbol || ''])
        console.log(formatTable(['Rune', 'Balance', 'Symbol'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  rune
    .command('send')
    .description('Transfer runes via edicts')
    .requiredOption('--rune-id <id>', 'Rune ID (block:tx)')
    .requiredOption('--amount <n>', 'Amount to send')
    .requiredOption('--divisibility <n>', 'Rune divisibility')
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

        console.log(`\nSending ${amount} of rune ${runeId} to ${opts.to}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with transfer?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        const { psbt } = await api.transfer.buildRuneEdictTransfer({
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

  rune
    .command('split')
    .description('Split rune balance across N UTXOs')
    .requiredOption('--rune-id <id>', 'Rune ID (block:tx)')
    .requiredOption('--amount <n>', 'Total amount to split')
    .requiredOption('--splits <n>', 'Number of splits (2-25)')
    .requiredOption('--divisibility <n>', 'Rune divisibility')
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

        console.log(`\nSplitting ${amount} of rune ${runeId} into ${splits} UTXOs`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with split?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        const { psbt } = await api.transfer.buildRuneEdictTransfer({
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

export function buildSplitEdicts(
  runeId: string,
  totalAmount: string,
  splits: number,
  divisibility: number,
  address: string,
): RuneEdict[] {
  const total = BigInt(Math.round(parseFloat(totalAmount) * Math.pow(10, divisibility)))
  const perSplit = total / BigInt(splits)
  const remainder = total - perSplit * BigInt(splits)

  const edicts: RuneEdict[] = []
  for (let i = 0; i < splits; i++) {
    const amt = i === splits - 1 ? perSplit + remainder : perSplit
    edicts.push({
      rune_id: runeId,
      amount: amt.toString(),
      divisibility,
      destination: address,
    })
  }
  return edicts
}
