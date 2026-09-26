import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import * as api from '@ow-cli/api'
import type { WalletInscription } from '@ow-cli/api'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword, requireConfirm } from '../utils/prompts.js'
import { formatJson } from '../output.js'
import { CliError, handleError } from '../utils/errors.js'
import { validateInscriptionId, validateAddress, validateFeeRate } from '../utils/validate.js'
import { signBroadcastAndPrint } from '../utils/tx.js'
import {
  buildInscriptionMap,
  decodePsbtPreview,
  printPsbtPreview,
  lostToFeeWarning,
  type PsbtPreview,
} from '../utils/psbt-preview.js'

export function registerInscriptionCommands(parent: Command): void {
  const inscription = parent.command('inscription').description('Inscription commands')

  inscription
    .command('info <id>')
    .description('Show inscription details')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts) => {
      try {
        validateInscriptionId(id)
        const ins = await api.wallet.getInscription(id)

        if (opts.json) {
          console.log(formatJson(ins))
          return
        }

        console.log(`\nInscription: ${ins.id}`)
        console.log(`Number: ${ins.num ?? 'N/A'}`)
        console.log(`Content Type: ${ins.content_type || 'N/A'}`)
        console.log(`Content Length: ${ins.content_length ?? 'N/A'}`)
        if (ins.meta?.name) console.log(`Name: ${ins.meta.name}`)
        if (ins.collection?.name) console.log(`Collection: ${ins.collection.name}`)
        if (ins.sat) {
          console.log(`Sat: ${ins.sat.value ?? ''} (${ins.sat.rarity || 'common'})`)
        }
        console.log(`Genesis Height: ${ins.genesis_height ?? 'N/A'}`)
        console.log(`Genesis Fee: ${ins.genesis_fee ?? 'N/A'}`)
      } catch (err) {
        handleError(err)
      }
    })

  inscription
    .command('inscribe <file>')
    .description('Create a new inscription')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (file: string, opts) => {
      try {
        const feeRate = validateFeeRate(opts.feeRate)
        const info = requirePublicInfo()

        const fileData = readFileSync(file)
        const contentType = guessContentType(file)

        const estimate = await api.inscribe.estimate({
          file_size: fileData.length,
          fee_rate: feeRate,
          content_type: contentType,
        })

        console.log(`\nInscription cost: ${estimate.total_fees} sats`)
        console.log(`  Inscription fee: ${estimate.inscription_fee} sats`)
        console.log(`  Postage: ${estimate.postage} sats`)

        await requireConfirm('Proceed with inscription?')
        await promptPassword()

        const result = await api.inscribe.upload(fileData, {
          fee_rate: feeRate,
          receive_address: info.address,
          content_type: contentType,
        })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nInscription submitted!`)
          console.log(`Result: ${JSON.stringify(result)}`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  inscription
    .command('send <id>')
    .description('Transfer an inscription')
    .requiredOption('--to <address>', 'Recipient address')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (id: string, opts) => {
      try {
        validateInscriptionId(id)
        validateAddress(opts.to)
        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        console.log(`\nSending inscription ${id}`)
        console.log(`  To: ${opts.to}`)
        console.log(`  Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await api.transfer.buildInscriptionSend({
          inscription_id: id,
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

  inscription
    .command('strip')
    .description('Strip excess sats from inscription UTXOs')
    .option('--collection <slug>', 'Collection slug to strip')
    .option('--ids <ids>', 'Comma-separated inscription IDs')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        if (!opts.collection && !opts.ids) {
          throw new CliError('Must specify --collection or --ids')
        }
        if (opts.collection && opts.ids) {
          throw new CliError('Cannot specify both --collection and --ids')
        }

        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        // Fetch wallet info and cardinal UTXOs in parallel
        const [walletInfo, cardinalUtxos] = await Promise.all([
          api.wallet.getWallet(pubInfo.address),
          api.wallet.getUtxos(pubInfo.address),
        ])

        // Filter inscriptions by collection or IDs
        let inscriptions: WalletInscription[]
        if (opts.collection) {
          inscriptions = walletInfo.inscriptions.filter(
            (ins) => ins.collection?.slug === opts.collection,
          )
          if (inscriptions.length === 0) {
            throw new CliError(`No inscriptions found for collection "${opts.collection}"`)
          }
        } else {
          const ids = (opts.ids as string).split(',').map((s) => s.trim())
          for (const id of ids) validateInscriptionId(id)
          inscriptions = walletInfo.inscriptions.filter((ins) => ids.includes(ins.id))
          const found = new Set(inscriptions.map((ins) => ins.id))
          const missing = ids.filter((id) => !found.has(id))
          if (missing.length > 0) {
            throw new CliError(`Inscriptions not found in wallet: ${missing.join(', ')}`)
          }
        }

        console.log(`\nFound ${inscriptions.length} inscription(s) to strip`)

        // Build inscription outpoint (txid:vout) → label map
        const inscriptionMap = buildInscriptionMap(inscriptions)

        const utxos: [string, number, number][] = cardinalUtxos.map(
          (u) => [u.txid, u.vout, u.value],
        )

        // Auto-batch: each inscription adds ~150 vbytes (input + postage + padding outputs).
        // The last inscription's excess (~V-330) funds fees via the builder's change output.
        // Keep batch size small enough that fee < excess so no cardinal UTXOs are needed.
        const batchSize = Math.max(1, Math.floor(8000 / (150 * feeRate)))
        const batches: WalletInscription[][] = []
        for (let i = 0; i < inscriptions.length; i += batchSize) {
          batches.push(inscriptions.slice(i, i + batchSize))
        }
        const isSingleBatch = batches.length === 1

        if (!isSingleBatch) {
          console.log(`Splitting into ${batches.length} batches of up to ${batchSize}`)
        }

        // Build first batch for preview
        const { psbt: firstPsbt } = await api.transfer.buildInscriptionSend({
          inscriptions: batches[0].map((ins) => ins.id),
          from: pubInfo.address,
          to: pubInfo.address,
          fee_rate: feeRate,
          public_key: pubInfo.publicKey,
          utxos: isSingleBatch ? utxos : [],
          postage: 330,
        })

        // Decode and trace PSBT
        const preview = decodePsbtPreview(firstPsbt, inscriptionMap)

        if (opts.json) {
          console.log(formatJson(preview))
        } else {
          printPsbtPreview(preview, `Transaction Preview${isSingleBatch ? '' : ' (batch 1)'}`)
        }
        refuseIfInscriptionsLost(preview)

        const confirmMsg = isSingleBatch
          ? 'Broadcast this transaction?'
          : `Broadcast ${batches.length} transactions?`
        await requireConfirm(confirmMsg)
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        // Sign and broadcast first batch
        await signBroadcastAndPrint(firstPsbt, kp, opts)

        // Process remaining batches
        for (let b = 1; b < batches.length; b++) {
          const batch = batches[b]
          console.log(`\nBatch ${b + 1} of ${batches.length} (${batch.length} inscriptions)...`)
          const { psbt } = await api.transfer.buildInscriptionSend({
            inscriptions: batch.map((ins) => ins.id),
            from: pubInfo.address,
            to: pubInfo.address,
            fee_rate: feeRate,
            public_key: pubInfo.publicKey,
            utxos: [],
            postage: 330,
          })
          await signBroadcastAndPrint(psbt, kp, opts)
        }
      } catch (err) {
        handleError(err)
      }
    })

  inscription
    .command('consolidate')
    .description('Consolidate inscription UTXOs into a single output')
    .requiredOption('--to <address>', 'Destination address')
    .option('--collection <slug>', 'Collection slug to consolidate')
    .option('--ids <ids>', 'Comma-separated inscription IDs')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        if (!opts.collection && !opts.ids) {
          throw new CliError('Must specify --collection or --ids')
        }
        if (opts.collection && opts.ids) {
          throw new CliError('Cannot specify both --collection and --ids')
        }
        validateAddress(opts.to)

        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        const [walletInfo, cardinalUtxos] = await Promise.all([
          api.wallet.getWallet(pubInfo.address),
          api.wallet.getUtxos(pubInfo.address),
        ])

        let inscriptions: WalletInscription[]
        if (opts.collection) {
          inscriptions = walletInfo.inscriptions.filter(
            (ins) => ins.collection?.slug === opts.collection,
          )
          if (inscriptions.length === 0) {
            throw new CliError(`No inscriptions found for collection "${opts.collection}"`)
          }
        } else {
          const ids = (opts.ids as string).split(',').map((s) => s.trim())
          for (const id of ids) validateInscriptionId(id)
          inscriptions = walletInfo.inscriptions.filter((ins) => ids.includes(ins.id))
          const found = new Set(inscriptions.map((ins) => ins.id))
          const missing = ids.filter((id) => !found.has(id))
          if (missing.length > 0) {
            throw new CliError(`Inscriptions not found in wallet: ${missing.join(', ')}`)
          }
        }

        console.log(`\nConsolidating ${inscriptions.length} inscription(s) into 1 output`)
        console.log(`  To: ${opts.to}`)
        console.log(`  Fee rate: ${feeRate} sat/vB`)

        const utxos: [string, number, number][] = cardinalUtxos.map(
          (u) => [u.txid, u.vout, u.value],
        )

        const { psbt } = await api.transfer.buildInscriptionSend({
          inscriptions: inscriptions.map((ins) => ins.id),
          from: pubInfo.address,
          to: opts.to,
          fee_rate: feeRate,
          public_key: pubInfo.publicKey,
          utxos,
          consolidate: true,
        })

        // Build inscription map and preview
        const inscriptionMap = buildInscriptionMap(inscriptions)

        const preview = decodePsbtPreview(psbt, inscriptionMap)

        if (opts.json) {
          console.log(formatJson(preview))
        } else {
          printPsbtPreview(preview)
        }
        refuseIfInscriptionsLost(preview)

        await requireConfirm('Broadcast this transaction?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)
        await signBroadcastAndPrint(psbt, kp, opts)
      } catch (err) {
        handleError(err)
      }
    })
}

/** Never sign a transaction that would burn an inscription's sat as fee. */
function refuseIfInscriptionsLost(preview: PsbtPreview): void {
  const warning = lostToFeeWarning(preview)
  if (warning) {
    throw new CliError(`${warning}\nRefusing to sign. Rebuild with a lower fee rate or more funding.`)
  }
}

export function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    txt: 'text/plain',
    html: 'text/html',
    json: 'application/json',
  }
  return types[ext || ''] || 'application/octet-stream'
}
