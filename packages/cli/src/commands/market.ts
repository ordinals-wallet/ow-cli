import { Command } from 'commander'
import {
  signPsbt,
  signPurchaseFlow,
  keypairFromMnemonic,
  keypairFromWIF,
} from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { WalletInscription } from '@ow-cli/api'
import { loadKeystore, getPublicInfo } from '../keystore.js'
import { promptPassword, promptConfirm } from '../utils/prompts.js'
import { formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'
import {
  validateInscriptionId,
  validateOutpoint,
  validateFeeRate,
  validatePrice,
} from '../utils/validate.js'

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

export function registerMarketCommands(parent: Command): void {
  const market = parent.command('market').description('Marketplace commands')

  market
    .command('buy <inscription_id>')
    .description('Purchase an inscription')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (inscriptionId: string, opts) => {
      try {
        validateInscriptionId(inscriptionId)
        const feeRate = validateFeeRate(opts.feeRate)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        console.log(`\nBuying inscription: ${inscriptionId}`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with purchase?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        // 1. Build purchase PSBTs
        const { setup, purchase } = await api.market.buildPurchase({
          inscription_id: inscriptionId,
          pay_address: pubInfo.address,
          receive_address: pubInfo.address,
          public_key: pubInfo.publicKey,
          fee_rate: feeRate,
          wallet_type: 'ow-cli',
        })

        // 2. Sign setup + purchase flow
        const { signedSetup, signedPurchase } = signPurchaseFlow(
          kp.privateKey,
          kp.publicKey,
          setup,
          purchase,
        )

        // 3. Submit
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

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        const confirmed = await promptConfirm(`Buy rune at outpoint ${outpoint}?`)
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

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
    .command('buy-bulk')
    .description('Buy multiple inscriptions')
    .requiredOption('--ids <ids>', 'Comma-separated inscription IDs')
    .requiredOption('--fee-rate <n>', 'Fee rate in sat/vB')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const ids = opts.ids.split(',').map((s: string) => s.trim())
        ids.forEach(validateInscriptionId)
        const feeRate = validateFeeRate(opts.feeRate)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        console.log(`\nBuying ${ids.length} inscription(s)`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with bulk purchase?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

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
          console.log(`\nBulk purchase submitted!`)
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

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        console.log(`\nBuying ${outpoints.length} alkane listing(s)`)
        console.log(`Fee rate: ${feeRate} sat/vB`)

        const confirmed = await promptConfirm('Proceed with alkane purchase?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

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
    .command('list <inscription_id>')
    .description('List inscription for sale')
    .requiredOption('--price <sats>', 'Price in satoshis')
    .option('--force-excess-sats', 'Force listing even if UTXO has excess sats')
    .option('--force-multi-inscriptions', 'Force listing even if UTXO has multiple inscriptions')
    .option('--json', 'Output as JSON')
    .action(async (inscriptionId: string, opts) => {
      try {
        validateInscriptionId(inscriptionId)
        const price = validatePrice(opts.price)

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        console.log(`\nListing ${inscriptionId} for ${formatSats(price)}`)

        const confirmed = await promptConfirm('Proceed?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        // Build escrow PSBT
        const { psbt } = await api.market.buildEscrow({
          inscription: inscriptionId,
          from: pubInfo.address,
          price,
          public_key: pubInfo.publicKey,
          dummy: false,
          force_excess_sats: opts.forceExcessSats || undefined,
          force_multi_inscriptions: opts.forceMultiInscriptions || undefined,
        })

        // Sign with disableExtract (PSBT output for escrow)
        const signedPsbt = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: true,
        })

        // Submit escrow
        const result = await api.market.submitEscrow({ psbt: signedPsbt })

        if (opts.json) {
          console.log(formatJson(result))
        } else {
          console.log(`\nInscription listed!`)
        }
      } catch (err) {
        handleError(err)
      }
    })

  market
    .command('list-bulk')
    .description('List multiple inscriptions for sale')
    .option('--collection <slug>', 'List all owned inscriptions from a collection')
    .option('--ids <ids>', 'Comma-separated inscription IDs to list')
    .option('--price <sats>', 'Price in satoshis (applies to all)')
    .option('--above-floor <percent>', 'Price at X% above collection floor')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        let inscriptionIds: string[] = []
        let prices: number[] = []

        if (opts.collection) {
          // Get wallet inscriptions and filter by collection
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

          // Calculate prices
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
          inscriptionIds = opts.ids.split(',')
          inscriptionIds.forEach(validateInscriptionId)
          if (!opts.price) {
            console.error('Must specify --price when using --ids')
            process.exit(1)
          }
          const p = parseInt(opts.price)
          prices = inscriptionIds.map(() => p)
          console.log(`\nListing ${inscriptionIds.length} inscriptions at ${formatSats(p)} each`)
        } else {
          console.error('Must specify --collection or --ids')
          process.exit(1)
        }

        // Show items
        for (let i = 0; i < inscriptionIds.length; i++) {
          console.log(`  ${i + 1}. ${inscriptionIds[i]} → ${formatSats(prices[i])}`)
        }

        const confirmed = await promptConfirm(`List ${inscriptionIds.length} inscription(s)?`)
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        // Build bulk escrow PSBT
        const { psbt } = await api.market.buildEscrowBulk({
          inscriptions: inscriptionIds,
          from: pubInfo.address,
          prices,
          public_key: pubInfo.publicKey,
        })

        // Sign with disableExtract
        const signedPsbt = signPsbt({
          psbt,
          privateKey: kp.privateKey,
          publicKey: kp.publicKey,
          disableExtract: true,
        })

        // Submit escrow
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

        const pubInfo = getPublicInfo()
        if (!pubInfo) {
          console.error('No wallet found.')
          process.exit(1)
        }

        console.log(`\nDelisting ${inscriptionId}`)

        const confirmed = await promptConfirm('Proceed?')
        if (!confirmed) {
          console.log('Cancelled.')
          return
        }

        const password = await promptPassword()
        const ks = loadKeystore(password)
        const kp = getKeypair(ks.seed)

        // Build dummy escrow with price 2.1e15 (per frontend wallet/index.tsx:334)
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
