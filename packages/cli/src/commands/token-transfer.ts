import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { WalletInscription } from '@ow-cli/api'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword, requireConfirm } from '../utils/prompts.js'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError, CliError } from '../utils/errors.js'
import { validateAmount, validateFeeRate, validateSplits, validateAddress, validateInscriptionId } from '../utils/validate.js'
import { splitAmount } from '@ow-cli/shared'
import { signBroadcastAndPrint } from '../utils/tx.js'

function isTextPlain(i: WalletInscription): boolean {
  return i.content_type === 'text/plain;charset=utf-8' || i.content_type === 'text/plain'
}

interface TokenConfig {
  label: string
  buildPayload: (ticker: string, amount: string) => string
}

export function registerInscribeTransfer(parent: Command, config: TokenConfig): void {
  parent
    .command('inscribe-transfer')
    .description(`Inscribe ${config.label} transfer inscription(s)`)
    .requiredOption('--ticker <name>', `${config.label} ticker`)
    .requiredOption('--amount <n>', 'Total amount to transfer')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--splits <n>', 'Split into N transfer inscriptions (2-25)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const ticker = opts.ticker.trim()
        if (!ticker) throw new CliError('Ticker cannot be empty')
        const amount = validateAmount(opts.amount)
        const feeRate = validateFeeRate(opts.feeRate)
        const splits = opts.splits ? validateSplits(opts.splits) : 1
        const pubInfo = requirePublicInfo()

        const amounts = splits > 1 ? splitAmount(amount, splits) : [amount]

        const samplePayload = config.buildPayload(ticker, amounts[0])
        const sampleBytes = new TextEncoder().encode(samplePayload)

        const estimate = await api.inscribe.estimate({
          file_size: sampleBytes.length,
          fee_rate: feeRate,
          content_type: 'text/plain;charset=utf-8',
        })

        const totalCost = estimate.total_fees * amounts.length

        console.log(`\n${config.label} transfer inscription${amounts.length > 1 ? 's' : ''}`)
        console.log(`  Ticker: ${ticker}`)
        console.log(`  Total amount: ${amount}`)
        if (amounts.length > 1) {
          console.log(`  Splits: ${amounts.length}`)
          amounts.forEach((a, i) => console.log(`    ${i + 1}. ${a}`))
        }
        console.log(`  Cost per inscription: ${formatSats(estimate.total_fees)}`)
        console.log(`  Total cost: ${formatSats(totalCost)}`)

        await requireConfirm('Proceed with inscription?')
        await promptPassword()

        const results = []
        for (const amt of amounts) {
          const payload = config.buildPayload(ticker, amt)
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
}

export function registerTokenSend(parent: Command, config: TokenConfig): void {
  parent
    .command('send [inscription_id]')
    .description(`Send a ${config.label} transfer inscription to a recipient`)
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (inscriptionId: string | undefined, opts) => {
      try {
        validateAddress(opts.to)
        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        let selectedId: string

        if (inscriptionId) {
          validateInscriptionId(inscriptionId)
          selectedId = inscriptionId
        } else {
          const walletData = await api.wallet.getWallet(pubInfo.address)
          const inscriptions = (walletData.inscriptions || []).filter(isTextPlain)

          if (inscriptions.length === 0) {
            console.log(`No ${config.label} transfer inscriptions found in wallet.`)
            return
          }

          console.log(`\n${config.label} transfer inscriptions:`)
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

        console.log(`\nSending ${config.label} transfer ${selectedId}`)
        console.log(`  To: ${opts.to}`)
        console.log(`  Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await api.transfer.buildInscriptionSend({
          inscription_id: selectedId,
          from: pubInfo.address,
          to: opts.to,
          fee_rate: feeRate,
          public_key: pubInfo.publicKey,
        })

        await signBroadcastAndPrint(psbt, kp, opts)
      } catch (err) {
        handleError(err)
      }
    })
}
