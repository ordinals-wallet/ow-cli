import { Command } from 'commander'
import { signInWithKey } from '@ow-cli/shared'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword } from '../utils/prompts.js'
import { formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'

export function registerAuthCommands(parent: Command): void {
  const auth = parent.command('auth').description('Wallet sign-in (BIP-322 session tokens)')

  auth
    .command('login')
    .description('Sign in with the active wallet and print the session expiry')
    .option('--show-token', 'Also print the session token (treat it like a password)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const pubInfo = requirePublicInfo()
        const password = await promptPassword()
        const kp = unlockKeypair(password)
        const session = await signInWithKey(kp, pubInfo.address)
        const expires = new Date(session.expires_at * 1000).toISOString()
        if (opts.json) {
          console.log(formatJson({
            address: session.address,
            expires_at: session.expires_at,
            ...(opts.showToken ? { token: session.token } : {}),
          }))
        } else {
          console.log(`\nSigned in as ${session.address}`)
          console.log(`Session expires: ${expires}`)
          if (opts.showToken) console.log(`Token: ${session.token}`)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
