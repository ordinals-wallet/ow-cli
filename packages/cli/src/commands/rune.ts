import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { RuneBalance } from '@ow-cli/api'
import { requirePublicInfo } from '../keystore.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { registerEdictSend, registerEdictSplit } from './edict-transfer.js'

export { buildSplitEdicts } from '@ow-cli/shared'

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
