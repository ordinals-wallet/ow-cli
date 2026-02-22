import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import * as api from '@ow-cli/api'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword, requireConfirm } from '../utils/prompts.js'
import { formatJson } from '../output.js'
import { handleError } from '../utils/errors.js'
import { validateInscriptionId, validateAddress, validateFeeRate } from '../utils/validate.js'
import { signBroadcastAndPrint } from '../utils/tx.js'

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
