import { Command } from 'commander'
import { signPsbt, keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { TapToken, WalletInscription } from '@ow-cli/api'
import { loadKeystore, getPublicInfo } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import { validateAmount, validateFeeRate, validateSplits, validateAddress, validateInscriptionId } from '../utils/validate.js'
import { CliError } from '../utils/errors.js'
import { splitAmount } from './brc20.js'

export function buildTapPayload(ticker: string, amount: string): string {
  return JSON.stringify({ p: 'tap', op: 'token-transfer', tick: ticker, amt: amount })
}

function getKeypair(seed: string) {
  const words = seed.trim().split(/\s+/)
  if (words.length >= 12) {
    return keypairFromMnemonic(seed.trim())
  }
  return keypairFromWIF(seed.trim())
}

function isTapTransfer(i: WalletInscription): boolean {
  return i.content_type === 'text/plain;charset=utf-8' || i.content_type === 'text/plain'
}

export function registerTapCommands(parent: Command): void {
  const tap = parent.command('tap').description('TAP token commands')

  tap
    .command('balance')
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

  tap
    .command('inscribe-transfer')
    .description('Inscribe TAP token transfer inscription(s)')
    .requiredOption('--ticker <name>', 'TAP ticker')
    .requiredOption('--amount <n>', 'Total amount to transfer')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--splits <n>', 'Split into N transfer inscriptions (2-25)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const ticker = opts.ticker.trim()
        if (!ticker) {
          throw new CliError('Ticker cannot be empty')
        }
        const amount = validateAmount(opts.amount)
        const feeRate = validateFeeRate(opts.feeRate)
        const splits = opts.splits ? validateSplits(opts.splits) : 1

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        const amounts = splits > 1 ? splitAmount(amount, splits) : [amount]

        const samplePayload = buildTapPayload(ticker, amounts[0])
        const sampleBytes = new TextEncoder().encode(samplePayload)

        const estimate = await api.inscribe.estimate({
          file_size: sampleBytes.length,
          fee_rate: feeRate,
          content_type: 'text/plain;charset=utf-8',
        })

        const totalCost = estimate.total_fees * amounts.length

        console.log(`\nTAP token transfer inscription${amounts.length > 1 ? 's' : ''}`)
        console.log(`  Ticker: ${ticker}`)
        console.log(`  Total amount: ${amount}`)
        if (amounts.length > 1) {
          console.log(`  Splits: ${amounts.length}`)
          amounts.forEach((a, i) => console.log(`    ${i + 1}. ${a}`))
        }
        console.log(`  Cost per inscription: ${formatSats(estimate.total_fees)}`)
        console.log(`  Total cost: ${formatSats(totalCost)}`)

        const confirmed = await promptConfirm('Proceed with inscription?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)

        const results = []
        for (const amt of amounts) {
          const payload = buildTapPayload(ticker, amt)
          const payloadBytes = new TextEncoder().encode(payload)

          const result = await api.inscribe.upload(payloadBytes, {
            fee_rate: feeRate,
            receive_address: pubInfo.address,
            content_type: 'text/plain;charset=utf-8',
          })
          results.push(result)
        }

        if (opts.json) {
          console.log(formatJson(results.length === 1 ? results[0] : results))
        } else {
          console.log(`\n${results.length} inscription(s) submitted!`)
          for (const r of results) {
            if (r.inscription_id) console.log(`  Inscription ID: ${r.inscription_id}`)
            if (r.txid) console.log(`  TXID: ${r.txid}`)
          }
        }
      } catch (err) {
        handleError(err)
      }
    })

  tap
    .command('send [inscription_id]')
    .description('Send a TAP transfer inscription to a recipient')
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (inscriptionId: string | undefined, opts) => {
      try {
        validateAddress(opts.to)
        const feeRate = validateFeeRate(opts.feeRate)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        let selectedId: string

        if (inscriptionId) {
          validateInscriptionId(inscriptionId)
          selectedId = inscriptionId
        } else {
          const walletData = await api.wallet.getWallet(pubInfo.address)
          const inscriptions = (walletData.inscriptions || []).filter(isTapTransfer)

          if (inscriptions.length === 0) {
            console.log('No TAP transfer inscriptions found in wallet.')
            return
          }

          console.log('\nTAP transfer inscriptions:')
          const rows = inscriptions.map((i: WalletInscription, idx: number) => [
            String(idx + 1),
            i.id,
            i.meta?.name || '',
          ])
          console.log(formatTable(['#', 'ID', 'Name'], rows))

          const { default: inquirer } = await import('inquirer')
          const { choice } = await inquirer.prompt([{
            type: 'input',
            name: 'choice',
            message: `Select inscription (1-${inscriptions.length}):`,
          }])

          const idx = parseInt(choice, 10) - 1
          if (isNaN(idx) || idx < 0 || idx >= inscriptions.length) {
            throw new CliError('Invalid selection')
          }
          selectedId = inscriptions[idx].id
        }

        console.log(`\nSending TAP transfer ${selectedId}`)
        console.log(`  To: ${opts.to}`)
        console.log(`  Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        const { psbt } = await api.transfer.buildInscriptionSend({
          inscription_id: selectedId,
          from: pubInfo.address,
          to: opts.to,
          fee_rate: feeRate,
          public_key: pubInfo.publicKey,
        })

        const rawtx = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: false,
        })

        const result = await api.wallet.broadcast(rawtx)

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nTransaction broadcast!`)
          console.log(`TXID: ${result.txid}`)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
