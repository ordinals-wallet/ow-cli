import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { RuneEdict, RuneBalance } from '@ow-cli/api'
import { requirePublicInfo } from '../keystore.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { registerEdictSend, registerEdictSplit } from './edict-transfer.js'

export function registerRuneCommands(parent: Command): void {
  const rune = parent.command('rune').description('Rune commands')

  rune
    .command('balance')
    .description('Show rune balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = requirePublicInfo()
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

  const config = {
    label: 'Rune',
    buildTransfer: api.transfer.buildRuneEdictTransfer,
  }
  registerEdictSend(rune, config)
  registerEdictSplit(rune, config)
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
