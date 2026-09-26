import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { Offer } from '@ow-cli/api'
import { formatJson, formatSats, formatTable } from '../output.js'
import { handleError } from '../utils/errors.js'

export type OfferTarget = 'inscription' | 'address' | 'collection'

/** Decide which offers route a `list` argument belongs to. */
export function classifyOfferTarget(target: string): OfferTarget {
  if (/^[0-9a-f]{64}i\d+$/i.test(target)) return 'inscription'
  if (/^(bc1[a-z0-9]{8,}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(target)) return 'address'
  return 'collection'
}

function offerRows(title: string, offers: Offer[]): string {
  if (offers.length === 0) return `${title}: none`
  const rows = offers.map((o) => [
    o.id,
    o.scope === 'item' ? (o.inscription_id ?? '') : [o.collection_slug, o.trait_type && `${o.trait_type}=${o.trait_value}`].filter(Boolean).join(' '),
    formatSats(o.price_sats),
    o.state,
    o.expires_at,
  ])
  return `${title}:\n${formatTable(['Offer', 'Target', 'Price', 'State', 'Expires'], rows)}`
}

export function registerOffersCommands(parent: Command): void {
  const offers = parent.command('offers').description('Funded offers on items, collections and traits')

  offers
    .command('list <target>')
    .description('List offers for a collection slug, inscription ID or wallet address')
    .option('--json', 'Output as JSON')
    .action(async (target: string, opts) => {
      try {
        const kind = classifyOfferTarget(target)
        if (kind === 'inscription') {
          const r = await api.offers.forInscription(target)
          if (opts.json) return console.log(formatJson(r))
          console.log([offerRows('Item offers', r.offers), offerRows('Collection/trait offers', r.collection_offers)].join('\n\n'))
        } else if (kind === 'address') {
          const r = await api.offers.forWallet(target)
          if (opts.json) return console.log(formatJson(r))
          console.log([offerRows('Received', r.received), offerRows('Sent', r.sent)].join('\n\n'))
        } else {
          const r = await api.offers.forCollection(target)
          if (opts.json) return console.log(formatJson(r))
          console.log(`${r.slug}: ${r.summary.count} offers, top ${formatSats(r.summary.top_price_sats)}\n`)
          console.log([
            offerRows('Item offers', r.offers),
            offerRows('Collection offers', r.collection_offers),
            offerRows('Trait offers', r.trait_offers),
          ].join('\n\n'))
        }
      } catch (err) {
        handleError(err)
      }
    })
}
