import { Command } from 'commander'
import {
  generateMnemonic,
  validateMnemonic,
  keypairFromMnemonic,
  keypairFromWIF,
  publicKeyToP2TR,
  signPsbt,
} from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { WalletInscription, RuneBalance, Brc20Balance, AlkanesBalance, TapToken } from '@ow-cli/api'
import { saveKeystore, loadKeystore, getPublicInfo, hasKeystore } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import { validateFeeRate, validateOutpointWithSats } from '../utils/validate.js'
import { registerRuneCommands } from './rune.js'
import { registerAlkaneCommands } from './alkane.js'
import { registerBrc20Commands } from './brc20.js'
import { registerTapCommands } from './tap-cmd.js'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function getKeypair(seed: string) {
  const words = seed.trim().split(/\s+/)
  if (words.length >= 12) {
    return keypairFromMnemonic(seed.trim())
  }
  return keypairFromWIF(seed.trim())
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
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          console.error(`Invalid WIF: ${message}`)
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

        const rows = inscriptions.map((i: WalletInscription) => [
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
          api.tap.getTapBalance(info.address).catch((): TapToken[] => []),
        ])

        if (opts.json) {
          console.log(formatJson({ runes, brc20, tap: tapTokens, alkanes }))
          return
        }

        // Runes
        if (runes.length > 0) {
          console.log('\nRunes:')
          const rows = runes.map((r: RuneBalance) => [r.name || '', r.amount || '', r.symbol || ''])
          console.log(formatTable(['Rune', 'Balance', 'Symbol'], rows))
        }

        // BRC-20
        if (brc20.length > 0) {
          console.log('\nBRC-20:')
          const rows = brc20.map((t: Brc20Balance) => [
            t.ticker || '',
            t.overall_balance || '',
            t.available_balance || '',
          ])
          console.log(formatTable(['Ticker', 'Balance', 'Available'], rows))
        }

        // TAP
        if (tapTokens.length > 0) {
          console.log('\nTAP:')
          const rows = tapTokens.map((t: TapToken) => [
            t.ticker || '',
            String(t.overall_balance ?? ''),
            String(t.available_balance ?? ''),
          ])
          console.log(formatTable(['Ticker', 'Balance', 'Available'], rows))
        }

        // Alkanes
        if (alkanes.length > 0) {
          console.log('\nAlkanes:')
          const rows = alkanes.map((t: AlkanesBalance) => [t.id || '', t.balance || ''])
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

  wallet
    .command('consolidate')
    .description('Merge UTXOs into a single output')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--utxos <list>', 'Comma-separated txid:vout:value (omit to use all)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const feeRate = validateFeeRate(opts.feeRate)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        let utxos: [string, number, number][]

        if (opts.utxos) {
          const parsed = opts.utxos.split(',').map((s: string) => validateOutpointWithSats(s.trim()))
          utxos = parsed.map((u: { txid: string; vout: number; sats: number }) => [u.txid, u.vout, u.sats] as [string, number, number])
        } else {
          const fetched = await api.wallet.getUtxos(pubInfo.address)
          utxos = fetched.map((u) => [u.txid, u.vout, u.value] as [string, number, number])
        }

        if (utxos.length < 2) {
          console.log('Need at least 2 UTXOs to consolidate.')
          return
        }

        const totalValue = utxos.reduce((sum, u) => sum + u[2], 0)
        const outputs: [string, number][] = [[pubInfo.address, totalValue]]

        console.log(`\nConsolidating ${utxos.length} UTXOs`)
        console.log(`Total value: ${formatSats(totalValue)}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with consolidation?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        const { psbt, fees } = await api.wallet.buildConsolidate({
          outputs,
          public_key: pubInfo.publicKey,
          from: pubInfo.address,
          fee_rate: feeRate,
          utxos,
        })

        const rawtx = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: false,
        })

        const result = await api.wallet.broadcast(rawtx)

        if (opts.json) {
          console.log(formatJson({ ...result, fees }))
        } else {
          console.log(`\nConsolidation broadcast!`)
          console.log(`TXID: ${result.txid}`)
          console.log(`Fees: ${formatSats(fees)}`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  registerRuneCommands(wallet)
  registerAlkaneCommands(wallet)
  registerBrc20Commands(wallet)
  registerTapCommands(wallet)
}
