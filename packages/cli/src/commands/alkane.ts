import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { AlkanesBalance } from '@ow-cli/api'
import { requirePublicInfo } from '../keystore.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { registerEdictSend, registerEdictSplit } from './edict-transfer.js'

export const ALKANES_COLUMNS = ['Ticker', 'ID', 'Balance', 'Available']

/** Table rows for `/wallet/:address/alkanes-balance` (balances are whole units). */
export function alkanesBalanceRows(tokens: AlkanesBalance[]): string[][] {
  return tokens.map((t) => [
    t.ticker || '',
    t.rune_id || '',
    t.overall_balance ?? '',
    t.available_balance ?? '',
  ])
}

export const ALKANES_COLD_WALLET_HINT =
  'No Alkanes balances. (A wallet queried for the first time can return empty while it is indexed; retry in a few seconds.)'

export function registerAlkaneCommands(parent: Command): void {
  const alkane = parent.command('alkane').description('Alkane commands')

  alkane
    .command('balance')
    .description('Show Alkanes token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = requirePublicInfo()
        const tokens = await api.wallet.getAlkanesBalance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log(ALKANES_COLD_WALLET_HINT)
          return
        }

        console.log(formatTable(ALKANES_COLUMNS, alkanesBalanceRows(tokens)))
      } catch (err) {
        handleError(err)
      }
    })

  const config = {
    label: 'Alkane',
    buildTransfer: api.transfer.buildAlkaneTransfer,
  }
  registerEdictSend(alkane, config)
  registerEdictSplit(alkane, config)
}
