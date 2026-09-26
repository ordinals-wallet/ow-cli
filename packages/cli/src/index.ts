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
import { registerAuthCommands } from './commands/auth.js'
import { registerOffersCommands } from './commands/offers.js'

// Tag all CLI API traffic: `x-ow-client: ow-cli-cli/<v> ow-cli/<v>`
setClient({ appName: CLI_APP_NAME })

export const program = new Command()

program
  .name('ow')
  .description('Ordinals Wallet CLI')
  .version(CLI_VERSION)
  .option('--debug', 'Show debug output including full API errors')

registerWalletCommands(program)
registerCollectionCommands(program)
registerCollectionMarketCommands(program)
registerInscriptionCommands(program)
registerMarketCommands(program)
registerSendCommand(program)
registerFeeCommand(program)
registerAuthCommands(program)
registerOffersCommands(program)

export function isDebug(): boolean {
  return program.opts().debug === true
}
