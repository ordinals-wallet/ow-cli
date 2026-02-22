import { Command } from 'commander'
import * as api from '@ow-cli/api'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'

export function registerCollectionCommands(parent: Command): void {
  const collection = parent.command('collection').description('Collection commands')

  collection
    .command('info <slug>')
    .description('Show collection metadata and stats')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts) => {
      try {
        const [meta, stats] = await Promise.all([
          api.collection.getMetadata(slug),
          api.collection.getStats(slug),
        ])

        if (opts.json) {
          console.log(formatJson({ ...meta, stats }))
          return
        }

        const s: any = stats
        console.log(`\n${meta.name}`)
        console.log(`Slug: ${meta.slug}`)
        console.log(`Supply: ${s.total_supply ?? meta.total_supply ?? 'N/A'}`)
        console.log(`Description: ${meta.description || 'N/A'}`)
        console.log(`\nStats:`)
        console.log(`  Floor: ${formatSats(s.floor_price)}`)
        console.log(`  Volume: ${formatSats(s.volume_total)}`)
        console.log(`  Listed: ${s.listed ?? 'N/A'}`)
        console.log(`  Sales: ${s.sales ?? 'N/A'}`)
      } catch (err) {
        handleError(err)
      }
    })

  collection
    .command('listings <slug>')
    .description('Show items listed for sale')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts) => {
      try {
        const escrows = await api.collection.getEscrows(slug)

        if (opts.json) {
          console.log(formatJson(escrows))
          return
        }

        if (escrows.length === 0) {
          console.log('No listings found.')
          return
        }

        const rows = escrows.map((e: any) => [
          e.inscription_id,
          e.name || '',
          formatSats(e.satoshi_price ?? e.price),
          e.seller_address || e.seller || '',
        ])
        console.log(formatTable(['Inscription', 'Name', 'Price', 'Seller'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  collection
    .command('history <slug>')
    .description('Show recent sales')
    .option('--limit <n>', 'Number of sales', '20')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts) => {
      try {
        const sold = await api.collection.getSoldEscrows(slug, parseInt(opts.limit))

        if (opts.json) {
          console.log(formatJson(sold))
          return
        }

        if (sold.length === 0) {
          console.log('No recent sales.')
          return
        }

        const rows = sold.map((e: any) => [
          e.inscription_id || '',
          e.name || '',
          formatSats(e.satoshi_price ?? e.price),
          e.buyer_address || e.buyer || '',
        ])
        console.log(formatTable(['Inscription', 'Name', 'Price', 'Buyer'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  collection
    .command('search <query>')
    .description('Search collections')
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts) => {
      try {
        const results = await api.search.search(query)

        if (opts.json) {
          console.log(formatJson(results))
          return
        }

        if (!results.collections || results.collections.length === 0) {
          console.log('No results found.')
          return
        }

        const rows = results.collections.map((c: any) => [c.slug || '', c.name || ''])
        console.log(formatTable(['Slug', 'Name'], rows))
      } catch (err) {
        handleError(err)
      }
    })
}
