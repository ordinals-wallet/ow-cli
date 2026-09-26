import { Command } from 'commander'
import { setClient } from '@ow-cli/api'
import { CLI_APP_NAME, CLI_VERSION } from './version.js'
import { registerWalletCommands } from './commands/wallet.js'
import { registerCollectionCommands } from './commands/collection.js'
import { registerCollectionMarketCommands } from './commands/collection-market.js'
import { registerInscriptionCommands } from './commands/inscription.js'
import { registerMarketCommands } from './commands/market.js'
import { registerSendCommand } from './commands/send.js'
import { registerFeeCommand } from './commands/fee.js'

// Tag all CLI/TUI API traffic: `x-ow-client: ow-cli-cli/<v> ow-cli/<v>`
setClient({ appName: CLI_APP_NAME })

export const program = new Command()

program
  .name('ow')
  .description('Ordinals Wallet CLI')
  .version(CLI_VERSION)
  .option('--debug', 'Show debug output including full API errors')

program
  .command('tui')
  .description('Launch interactive terminal UI')
  .action(async () => {
    const { launch } = await import('@ow-cli/tui')
    await launch()
  })

registerWalletCommands(program)
registerCollectionCommands(program)
registerCollectionMarketCommands(program)
registerInscriptionCommands(program)
registerMarketCommands(program)
registerSendCommand(program)
registerFeeCommand(program)

export function isDebug(): boolean {
  return program.opts().debug === true
}
