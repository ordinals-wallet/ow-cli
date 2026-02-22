import { Command } from 'commander'
import { registerWalletCommands } from './commands/wallet.js'
import { registerCollectionCommands } from './commands/collection.js'
import { registerInscriptionCommands } from './commands/inscription.js'
import { registerMarketCommands } from './commands/market.js'
import { registerSendCommand } from './commands/send.js'
import { registerFeeCommand } from './commands/fee.js'

export const program = new Command()

program
  .name('ow')
  .description('Ordinals Wallet CLI')
  .version('0.1.0')
  .option('--debug', 'Show debug output including full API errors')

registerWalletCommands(program)
registerCollectionCommands(program)
registerInscriptionCommands(program)
registerMarketCommands(program)
registerSendCommand(program)
registerFeeCommand(program)

export function isDebug(): boolean {
  return program.opts().debug === true
}
