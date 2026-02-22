import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { Brc20Balance } from '@ow-cli/api'
import { requirePublicInfo } from '../keystore.js'
import { formatTable, formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { registerInscribeTransfer, registerTokenSend } from './token-transfer.js'

export function buildBrc20Payload(ticker: string, amount: string): string {
  return JSON.stringify({ p: 'brc-20', op: 'transfer', tick: ticker, amt: amount })
}

export function splitAmount(total: string, splits: number): string[] {
  const totalNum = parseFloat(total)
  const perSplit = Math.floor((totalNum / splits) * 1e8) / 1e8
  const amounts: string[] = []
  let remaining = totalNum
  for (let i = 0; i < splits - 1; i++) {
    amounts.push(String(perSplit))
    remaining -= perSplit
  }
  amounts.push(String(Math.round(remaining * 1e8) / 1e8))
  return amounts
}

export function registerBrc20Commands(parent: Command): void {
  const brc20 = parent.command('brc20').description('BRC-20 token commands')

  brc20
    .command('balance')
    .description('Show BRC-20 token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = requirePublicInfo()
        const tokens = await api.wallet.getBrc20Balance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log('No BRC-20 balances.')
          return
        }

        const rows = tokens.map((t: Brc20Balance) => [
          t.ticker || '',
          t.overall_balance || '',
          t.available_balance || '',
          t.transferable_balance || '',
        ])
        console.log(formatTable(['Ticker', 'Balance', 'Available', 'Transferable'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  const config = { label: 'BRC-20', buildPayload: buildBrc20Payload }
  registerInscribeTransfer(brc20, config)
  registerTokenSend(brc20, config)
}
