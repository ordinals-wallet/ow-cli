import { Command } from 'commander'
import {
  generateMnemonic,
  validateMnemonic,
  keypairFromMnemonic,
  keypairFromWIF,
  publicKeyToP2TR,
} from '@ow-cli/core'
import * as api from '@ow-cli/api'
import { saveKeystore, getPublicInfo, hasKeystore } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function registerWalletCommands(parent: Command): void {
  const wallet = parent.command('wallet').description('Wallet management')

  wallet
    .command('create')
    .description('Generate a new 12-word mnemonic wallet')
    .action(async () => {
      const mnemonic = generateMnemonic()
      console.log('\nYour 12-word recovery phrase:\n')
      console.log(`  ${mnemonic}\n`)
      console.log('IMPORTANT: Write this down and store it securely. It cannot be recovered.\n')

      const password = await promptPassword('Set a password to encrypt your wallet: ')
      const password2 = await promptPassword('Confirm password: ')

      if (password !== password2) {
        console.error('Passwords do not match')
        process.exit(1)
      }

      const kp = keypairFromMnemonic(mnemonic)
      const addr = publicKeyToP2TR(kp.publicKey)

      saveKeystore(mnemonic, password, bytesToHex(kp.publicKey), addr.address)

      console.log(`\nWallet created!`)
      console.log(`Address: ${addr.address}`)
    })

  wallet
    .command('import')
    .description('Import wallet from mnemonic or WIF')
    .action(async () => {
      const { default: inquirer } = await import('inquirer')
      const { seed } = await inquirer.prompt([
        {
          type: 'password',
          name: 'seed',
          message: 'Enter mnemonic or WIF:',
          mask: '*',
        },
      ])

      let kp
      const trimmed = seed.trim()

      if (trimmed.split(/\s+/).length >= 12) {
        if (!validateMnemonic(trimmed)) {
          console.error('Invalid mnemonic')
          process.exit(1)
        }
        kp = keypairFromMnemonic(trimmed)
      } else {
        try {
          kp = keypairFromWIF(trimmed)
        } catch (e: any) {
          console.error(`Invalid WIF: ${e.message}`)
          process.exit(1)
        }
      }

      const addr = publicKeyToP2TR(kp.publicKey)

      const password = await promptPassword('Set a password to encrypt your wallet: ')
      const password2 = await promptPassword('Confirm password: ')

      if (password !== password2) {
        console.error('Passwords do not match')
        process.exit(1)
      }

      saveKeystore(trimmed, password, bytesToHex(kp.publicKey), addr.address)

      console.log(`\nWallet imported!`)
      console.log(`Address: ${addr.address}`)
    })

  wallet
    .command('info')
    .description('Show wallet address, balance, and UTXOs')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const walletData = await api.wallet.getWallet(info.address)

        if (opts.json) {
          console.log(formatJson(walletData))
          return
        }

        const inscriptions = Array.isArray(walletData.inscriptions) ? walletData.inscriptions : []
        console.log(`\nAddress: ${info.address}`)
        console.log(`Balance: ${formatSats(walletData.balance)}`)
        console.log(`Inscriptions: ${inscriptions.length}`)
        console.log(`UTXOs: ${walletData.utxo_count ?? 'N/A'}`)
      } catch (err) {
        handleError(err)
      }
    })

  wallet
    .command('inscriptions')
    .description('List owned inscriptions')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const walletData = await api.wallet.getWallet(info.address)
        const inscriptions = Array.isArray(walletData.inscriptions) ? walletData.inscriptions : []

        if (opts.json) {
          console.log(formatJson(inscriptions))
          return
        }

        if (inscriptions.length === 0) {
          console.log('No inscriptions found.')
          return
        }

        const rows = inscriptions.map((i: any) => [
          String(i.num ?? ''),
          i.id,
          i.content_type || '',
          i.meta?.name || '',
        ])
        console.log(formatTable(['#', 'ID', 'Type', 'Name'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  wallet
    .command('runes')
    .description('Show rune balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const runes = await api.wallet.getRuneBalance(info.address)

        if (opts.json) {
          console.log(formatJson(runes))
          return
        }

        if (runes.length === 0) {
          console.log('No rune balances.')
          return
        }

        const rows = runes.map((r: any) => [r.name || '', r.amount || '', r.symbol || ''])
        console.log(formatTable(['Rune', 'Balance', 'Symbol'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  wallet
    .command('brc20')
    .description('Show BRC-20 token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const tokens = await api.wallet.getBrc20Balance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log('No BRC-20 balances.')
          return
        }

        const rows = tokens.map((t: any) => [
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

  wallet
    .command('tap')
    .description('Show TAP token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const tokens = await api.tap.getTapBalance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log('No TAP balances.')
          return
        }

        const rows = tokens.map((t: any) => [
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

  wallet
    .command('alkanes')
    .description('Show Alkanes token balances')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const tokens = await api.wallet.getAlkanesBalance(info.address)

        if (opts.json) {
          console.log(formatJson(tokens))
          return
        }

        if (tokens.length === 0) {
          console.log('No Alkanes balances.')
          return
        }

        const rows = tokens.map((t: any) => [t.id || '', t.balance || ''])
        console.log(formatTable(['ID', 'Balance'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  wallet
    .command('tokens')
    .description('Show all token balances (runes, BRC-20, TAP, alkanes)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const info = getPublicInfo()
        if (!info) {
          console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
          process.exit(1)
        }

        const [runes, brc20, alkanes, tapTokens] = await Promise.all([
          api.wallet.getRuneBalance(info.address),
          api.wallet.getBrc20Balance(info.address),
          api.wallet.getAlkanesBalance(info.address),
          api.tap.getTapBalance(info.address).catch(() => [] as any[]),
        ])

        if (opts.json) {
          console.log(formatJson({ runes, brc20, tap: tapTokens, alkanes }))
          return
        }

        // Runes
        if (runes.length > 0) {
          console.log('\nRunes:')
          const rows = runes.map((r: any) => [r.name || '', r.amount || '', r.symbol || ''])
          console.log(formatTable(['Rune', 'Balance', 'Symbol'], rows))
        }

        // BRC-20
        if (brc20.length > 0) {
          console.log('\nBRC-20:')
          const rows = brc20.map((t: any) => [
            t.ticker || '',
            t.overall_balance || '',
            t.available_balance || '',
          ])
          console.log(formatTable(['Ticker', 'Balance', 'Available'], rows))
        }

        // TAP
        if (tapTokens.length > 0) {
          console.log('\nTAP:')
          const rows = tapTokens.map((t: any) => [
            t.ticker || '',
            String(t.overall_balance ?? ''),
            String(t.available_balance ?? ''),
          ])
          console.log(formatTable(['Ticker', 'Balance', 'Available'], rows))
        }

        // Alkanes
        if (alkanes.length > 0) {
          console.log('\nAlkanes:')
          const rows = alkanes.map((t: any) => [t.id || '', t.balance || ''])
          console.log(formatTable(['ID', 'Balance'], rows))
        }

        const total = runes.length + brc20.length + tapTokens.length + alkanes.length
        if (total === 0) {
          console.log('No token balances found.')
        }
      } catch (err) {
        handleError(err)
      }
    })
}
