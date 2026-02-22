import { Command } from 'commander'
import {
  signPsbt,
  signPurchaseFlow,
} from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { WalletInscription } from '@ow-cli/api'
import { requirePublicInfo, unlockKeypair } from '../keystore.js'
import { promptPassword, requireConfirm } from '../utils/prompts.js'
import { formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import {
  validateInscriptionId,
  validateOutpoint,
  validateFeeRate,
  validatePrice,
} from '../utils/validate.js'

export function registerMarketCommands(parent: Command): void {
  const market = parent.command('market').description('Marketplace commands')

  market
    .command('buy')
    .description('Purchase one or more inscriptions')
    .requiredOption('--ids <ids>', 'Comma-separated inscription IDs')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const ids = opts.ids.split(',').map((s: string) => s.trim())
        ids.forEach(validateInscriptionId)
        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        console.log(`\nBuying ${ids.length} inscription(s)`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed with purchase?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { setup, purchase } = await api.market.buildPurchaseBulk({
          inscriptions: ids,
          pay_address: pubInfo.address,
          receive_address: pubInfo.address,
          public_key: pubInfo.publicKey,
          fee_rate: feeRate,
          wallet_type: 'ow-cli',
        })

        const { signedSetup, signedPurchase } = signPurchaseFlow(
          kp.privateKey,
          kp.publicKey,
          setup,
          purchase,
        )

        const result = await api.market.submitPurchase({
          setup_rawtx: signedSetup,
          purchase_rawtx: signedPurchase,
          wallet_type: 'ow-cli',
        })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nPurchase submitted!`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  market
    .command('buy-rune <outpoint>')
    .description('Purchase a rune listing')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (outpoint: string, opts) => {
      try {
        validateOutpoint(outpoint)
        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        await requireConfirm(`Buy rune at outpoint ${outpoint}?`)
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { setup, purchase } = await api.market.buildPurchaseRunes({
          outpoints: [outpoint],
          pay_address: pubInfo.address,
          receive_address: pubInfo.address,
          public_key: pubInfo.publicKey,
          fee_rate: feeRate,
          wallet_type: 'ow-cli',
        })

        const { signedSetup, signedPurchase } = signPurchaseFlow(
          kp.privateKey,
          kp.publicKey,
          setup,
          purchase,
        )

        const result = await api.market.submitPurchaseRune({
          rawtx: signedPurchase,
          wallet_type: 'ow-cli',
        })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nRune purchase submitted!`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  market
    .command('buy-alkane')
    .description('Buy alkane listings')
    .requiredOption('--outpoints <list>', 'Comma-separated outpoints')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (outpointsArg: unknown, opts) => {
      try {
        const outpoints = opts.outpoints.split(',').map((s: string) => {
          const trimmed = s.trim()
          validateOutpoint(trimmed)
          return trimmed
        })
        const feeRate = validateFeeRate(opts.feeRate)
        const pubInfo = requirePublicInfo()

        console.log(`\nBuying ${outpoints.length} alkane listing(s)`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        await requireConfirm('Proceed with alkane purchase?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await api.market.buildPurchaseAlkanes({
          outpoints,
          pay_address: pubInfo.address,
          receive_address: pubInfo.address,
          public_key: pubInfo.publicKey,
          fee_rate: feeRate,
          wallet_type: 'ow-cli',
        })

        const rawtx = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: false,
        })

        const result = await api.market.submitPurchaseRune({
          rawtx,
          wallet_type: 'ow-cli',
        })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nAlkane purchase submitted!`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  market
    .command('list')
    .description('List one or more inscriptions for sale')
    .option('--collection <slug>', 'List all owned inscriptions from a collection')
    .option('--ids <ids>', 'Comma-separated inscription IDs to list')
    .option('--price <sats>', 'Price in satoshis (applies to all)')
    .option('--above-floor <percent>', 'Price at X% above collection floor')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const pubInfo = requirePublicInfo()

        let inscriptionIds: string[] = []
        let prices: number[] = []

        if (opts.collection) {
          const walletData = await api.wallet.getWallet(pubInfo.address)
          const inscriptions = walletData.inscriptions || []

          const collectionInscriptions = inscriptions.filter(
            (i: WalletInscription) => i.collection?.slug === opts.collection
          )

          if (collectionInscriptions.length === 0) {
            console.error(`No inscriptions found from collection "${opts.collection}" in your wallet.`)
            process.exit(1)
          }

          inscriptionIds = collectionInscriptions.map((i: WalletInscription) => i.id)
          console.log(`\nFound ${inscriptionIds.length} inscriptions from ${opts.collection}`)

          if (opts.aboveFloor) {
            const stats = await api.collection.getStats(opts.collection)
            const floor = stats.floor_price
            if (!floor) {
              console.error('Could not determine floor price.')
              process.exit(1)
            }
            const pct = parseFloat(opts.aboveFloor)
            const listPrice = Math.round(floor * (1 + pct / 100))
            prices = inscriptionIds.map(() => listPrice)
            console.log(`Floor: ${formatSats(floor)}`)
            console.log(`List price (${pct}% above): ${formatSats(listPrice)} each`)
          } else if (opts.price) {
            const p = parseInt(opts.price)
            prices = inscriptionIds.map(() => p)
            console.log(`Price: ${formatSats(p)} each`)
          } else {
            console.error('Must specify --price or --above-floor')
            process.exit(1)
          }
        } else if (opts.ids) {
          inscriptionIds = opts.ids.split(',').map((s: string) => s.trim())
          inscriptionIds.forEach(validateInscriptionId)
          if (!opts.price) {
            console.error('Must specify --price when using --ids')
            process.exit(1)
          }
          const p = validatePrice(opts.price)
          prices = inscriptionIds.map(() => p)
          console.log(`\nListing ${inscriptionIds.length} inscription(s) at ${formatSats(p)} each`)
        } else {
          console.error('Must specify --collection or --ids')
          process.exit(1)
        }

        for (let i = 0; i < inscriptionIds.length; i++) {
          console.log(`  ${i + 1}. ${inscriptionIds[i]} → ${formatSats(prices[i])}`)
        }

        await requireConfirm(`List ${inscriptionIds.length} inscription(s)?`)
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await api.market.buildEscrowBulk({
          inscriptions: inscriptionIds,
          from: pubInfo.address,
          prices,
          public_key: pubInfo.publicKey,
        })

        const signedPsbt = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: true,
        })

        const result = await api.market.submitEscrow({ psbt: signedPsbt })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\n${inscriptionIds.length} inscription(s) listed!`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  market
    .command('delist <inscription_id>')
    .description('Cancel a listing')
    .option('--json', 'Output as JSON')
    .action(async (inscriptionId: string, opts) => {
      try {
        validateInscriptionId(inscriptionId)
        const pubInfo = requirePublicInfo()

        console.log(`\nDelisting ${inscriptionId}`)

        await requireConfirm('Proceed?')
        const password = await promptPassword()
        const kp = unlockKeypair(password)

        const { psbt } = await api.market.buildEscrow({
          inscription: inscriptionId,
          from: pubInfo.address,
          price: 2.1e15,
          public_key: pubInfo.publicKey,
          dummy: false,
        })

        const signedPsbt = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: true,
        })

        const result = await api.market.cancelEscrow({
          inscription_id: inscriptionId,
          signature: signedPsbt,
        })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nListing cancelled!`)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
