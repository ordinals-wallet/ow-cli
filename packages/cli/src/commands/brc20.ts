import { Command } from 'commander'
import { signPsbt, keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { Brc20Balance, WalletInscription } from '@ow-cli/api'
import { loadKeystore, getPublicInfo } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import { validateAmount, validateFeeRate, validateSplits, validateAddress, validateInscriptionId } from '../utils/validate.js'
import { CliError } from '../utils/errors.js'

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

function getKeypair(seed: string) {
  const words = seed.trim().split(/\s+/)
  if (words.length >= 12) {
    return keypairFromMnemonic(seed.trim())
  }
  return keypairFromWIF(seed.trim())
}

function isBrc20Transfer(i: WalletInscription): boolean {
  return i.content_type === 'text/plain;charset=utf-8' || i.content_type === 'text/plain'
}

export function registerBrc20Commands(parent: Command): void {
  const brc20 = parent.command('brc20').description('BRC-20 token commands')

  brc20
    .command('balance')
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

  brc20
    .command('inscribe-transfer')
    .description('Inscribe BRC-20 transfer inscription(s)')
    .requiredOption('--ticker <name>', 'BRC-20 ticker')
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

        const samplePayload = buildBrc20Payload(ticker, amounts[0])
        const sampleBytes = new TextEncoder().encode(samplePayload)

        const estimate = await api.inscribe.estimate({
          file_size: sampleBytes.length,
          fee_rate: feeRate,
          content_type: 'text/plain;charset=utf-8',
        })

        const totalCost = estimate.total_fees * amounts.length

        console.log(`\nBRC-20 transfer inscription${amounts.length > 1 ? 's' : ''}`)
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
          const payload = buildBrc20Payload(ticker, amt)
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

  brc20
    .command('send [inscription_id]')
    .description('Send a BRC-20 transfer inscription to a recipient')
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
          // Fetch wallet inscriptions and filter to text/plain (BRC-20 transfers)
          const walletData = await api.wallet.getWallet(pubInfo.address)
          const inscriptions = (walletData.inscriptions || []).filter(isBrc20Transfer)

          if (inscriptions.length === 0) {
            console.log('No BRC-20 transfer inscriptions found in wallet.')
            return
          }

          console.log('\nBRC-20 transfer inscriptions:')
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

        console.log(`\nSending BRC-20 transfer ${selectedId}`)
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
