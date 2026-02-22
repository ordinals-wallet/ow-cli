import { Command } from 'commander'
import * as api from '@ow-cli/api'
import { formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'

export function registerFeeCommand(parent: Command): void {
  parent
    .command('fee-estimate')
    .description('Show current fee rate estimates')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const fees = await api.wallet.getFeeEstimates()

        if (opts.json) {
          console.log(formatJson(fees))
          return
        }

        console.log('\nFee Estimates (sat/vB):')
        console.log(`  Fastest:  ${fees.fastestFee}`)
        console.log(`  30 min:   ${fees.halfHourFee}`)
        console.log(`  1 hour:   ${fees.hourFee}`)
        console.log(`  Minimum:  ${fees.minimumFee}`)
      } catch (err) {
        handleError(err)
      }
    })
}
