import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { AlkanesBalance } from '@ow-cli/api'
import { requirePublicInfo } from '../keystore.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { registerEdictSend, registerEdictSplit } from './edict-transfer.js'

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
          console.log('No Alkanes balances.')
          return
        }

        const rows = tokens.map((t: AlkanesBalance) => [t.id || '', t.balance || ''])
        console.log(formatTable(['ID', 'Balance'], rows))
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
