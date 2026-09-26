import { Command } from 'commander'
import * as api from '@ow-cli/api'
import type { OhlcvInterval, OhlcvDenom } from '@ow-cli/api'
import { formatTable, formatJson, formatSats } from '../output.js'
import { handleError } from '../utils/errors.js'

const INTERVALS: OhlcvInterval[] = ['5m', '15m', '1h', '4h', '12h', '1d', '1w']

function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z')
}

/** `ow collection chart|value|sales`, attached to the existing `collection` command. */
export function registerCollectionMarketCommands(program: Command): void {
  const collection =
    program.commands.find((c) => c.name() === 'collection') ??
    program.command('collection').description('Collection commands')

  collection
    .command('chart <slug>')
    .description('Show price candles and the fair-value band')
    .option('--interval <i>', `Bucket size (${INTERVALS.join(', ')})`, '1d')
    .option('--denom <d>', 'sats, usd or mcap', 'sats')
    .option('--limit <n>', 'Candles to show (newest)', '14')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts) => {
      try {
        if (!INTERVALS.includes(opts.interval)) throw new Error(`--interval must be one of ${INTERVALS.join(', ')}`)
        const res = await api.charts.getOhlcv(slug, { interval: opts.interval, denom: opts.denom as OhlcvDenom })
        if (opts.json) {
          console.log(formatJson(res))
          return
        }
        const n = Math.max(1, parseInt(opts.limit))
        const trend = new Map(res.trend.map((t) => [t.time, t]))
        const fmt = (v: number) => (res.denom === 'sats' ? formatSats(Math.round(v)) : v.toFixed(2))
        const rows = res.candles.slice(-n).map((c) => [
          isoTime(c.time),
          fmt(c.open),
          fmt(c.high),
          fmt(c.low),
          fmt(c.close),
          trend.has(c.time) ? fmt(trend.get(c.time)!.fair) : '',
          c.synthetic ? '-' : String(c.trades),
        ])
        console.log(`${slug} ${res.interval} ${res.series} (${res.denom})`)
        console.log(formatTable(['Time', 'Open', 'High', 'Low', 'Close', 'Fair', 'Trades'], rows))
      } catch (err) {
        handleError(err)
      }
    })

  collection
    .command('value <slug>')
    .description('Show fair value, range and confidence')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts) => {
      try {
        const v = await api.charts.getValuation(slug)
        if (opts.json) {
          console.log(formatJson(v))
          return
        }
        const usd = (x: number | null) => (x == null ? 'N/A' : `$${x.toFixed(2)}`)
        console.log(`\n${v.slug}`)
        console.log(`Fair:       ${formatSats(v.fair_sats == null ? null : Math.round(v.fair_sats))} (${usd(v.fair_usd)})`)
        console.log(
          `Range:      ${formatSats(v.low_sats == null ? null : Math.round(v.low_sats))} to ${formatSats(v.high_sats == null ? null : Math.round(v.high_sats))}`,
        )
        console.log(`Confidence: ${Math.round(v.confidence * 100)}%`)
        console.log(`Method:     ${v.method} (tape: ${v.tape_source})`)
        console.log(`Floor:      ${formatSats(v.inputs.floor_sats)}`)
        console.log(`Trades:     ${v.inputs.trades_7d} (7d), ${v.inputs.trades_30d} (30d)`)
      } catch (err) {
        handleError(err)
      }
    })

  collection
    .command('sales <slug>')
    .description('Show recent sales across marketplaces')
    .option('--limit <n>', 'Number of sales', '20')
    .option('--before-height <h>', 'Only sales before this block height')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, opts) => {
      try {
        const page = await api.sales.getSales(slug, {
          limit: parseInt(opts.limit),
          beforeHeight: opts.beforeHeight ? parseInt(opts.beforeHeight) : undefined,
        })
        if (opts.json) {
          console.log(formatJson(page))
          return
        }
        if (page.sales.length === 0) {
          console.log('No sales found.')
          return
        }
        const rows = page.sales.map((s) => [
          isoTime(s.block_timestamp),
          String(s.block_height),
          s.inscription_id,
          formatSats(s.price_sats),
          api.sales.marketplaceName(s.marketplace),
        ])
        console.log(formatTable(['Time', 'Block', 'Inscription', 'Price', 'Marketplace'], rows))
        if (page.has_more) {
          console.log(`\nMore: --before-height ${page.sales[page.sales.length - 1].block_height}`)
        }
      } catch (err) {
        handleError(err)
      }
    })
}
