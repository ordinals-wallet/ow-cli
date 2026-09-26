import { Command } from 'commander'
import type { TapToken } from '../utils/tap.js'
import { buildTapPayload } from '@ow-cli/shared'
import { requirePublicInfo } from '../keystore.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { registerInscribeTransfer, registerTokenSend } from './token-transfer.js'

export { buildTapPayload } from '@ow-cli/shared'

export function registerTapCommands(parent: Command): void {
  const tap = parent.command('tap').description('TAP token commands')

  tap
    .command('balance')
    .description('Show TAP token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = requirePublicInfo()
        const { getTapBalance } = await import('../utils/tap.js')
        const tokens = await getTapBalance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log('No TAP balances.')
          return
        }

        const rows = tokens.map((t: TapToken) => [
          t.ticker || '',
          String(t.overall_balance ?? ''),
          String(t.available_balance ?? ''),
          String(t.transferable_balance ?? ''),
        ])
        console.log(formatTable(['Ticker', 'Balance', 'Available', 'Transferable'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  const config = { label: 'TAP', buildPayload: buildTapPayload }
  registerInscribeTransfer(tap, config)
  registerTokenSend(tap, config)
}
