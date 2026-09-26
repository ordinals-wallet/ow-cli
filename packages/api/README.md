# @ow-cli/api

Typed client for the Ordinals Wallet API (`https://turbo.ordinalswallet.com`). Runs in Node 18+ and browsers.

```ts
import { setClient, charts, sales, feeds, quotes } from '@ow-cli/api'

setClient({ appName: 'my-app/1.0' }) // optional; identifies your traffic
```

Full endpoint reference: https://blog.ordinalswallet.com/docs/developers

## charts

Candles, the fair-value band, and valuations.

```ts
const { candles, trend } = await charts.getOhlcv('bitcoin-puppets', { interval: '4h', denom: 'usd' })
const v = await charts.getValuation('bitcoin-puppets') // { fair_sats, low_sats, high_sats, confidence, method, tape_source, inputs, … }
const many = await charts.getValuations(walletSlugs) // batched 200 per request; unknown slugs are omitted
```

`getOhlcv` options: `interval` (`5m`…`1w`, default `1d`), `denom` (`sats` | `usd` | `mcap`), `series` (`mark` | `trades`), `start`/`end` (unix seconds), `supply`. Candles with `synthetic: true` had no sales.

## sales

Every on-chain sale across marketplaces, newest first.

```ts
const page = await sales.getSales('bitcoin-puppets', { limit: 100 })
const older = await sales.getSales('bitcoin-puppets', { beforeHeight: page.sales.at(-1)!.block_height })
for await (const s of sales.iterateSales('bitcoin-puppets')) { /* pages until has_more=false */ }

await sales.getSalesVolume('bitcoin-puppets', { fromHeight: 960000 }) // daily buckets by marketplace
await sales.getWalletSales('bc1p…') // or sales.iterateWalletSales('bc1p…')
sales.MARKETPLACES[2] // 'Satflow'; sales.marketplaceName(id)
```

## feeds

The unified sales tape (Ordinals Wallet, other marketplaces, and pending mempool sales), as pages or a live stream. Page calls retry `503` / `429` after `Retry-After`.

```ts
const page = await feeds.getCollectionFeed('bitcoin-puppets', { limit: 100 })
const next = await feeds.getCollectionFeed('bitcoin-puppets', { cursor: page.next! })
await feeds.getActivityFeed()      // whole market
await feeds.getMempoolSales()
await feeds.getRecentListings(25)  // 25 | 50 | 100

const close = feeds.streamCollectionFeed('bitcoin-puppets', {
  onRows: (rows, { type }) => render(rows), // pending first, then newest; deduplicated by key
  onError: (err, { fatal }) => console.warn(err),
})
// feeds.streamActivityFeed({ onRows }) for the whole market
close()
```

The stream applies the `snapshot` and each `delta` (`added` / `updated` / `removed`) for you and keeps up to `maxRows` (default 200) rows. `feeds.createFeedStore()` exposes the same reducer if you manage the connection yourself.

## quotes

Live BTC/USD and each collection's fair line (up to 64 collections).

```ts
const { btc, marks } = await quotes.getQuotes(['bitcoin-puppets', 'nodemonkes'])
const close = quotes.streamQuotes(['bitcoin-puppets'], {
  onBtc: (b) => console.log(b.usd),
  onMark: (m) => console.log(m.slug, m.fair_sats),
})
```

The initial snapshot is also delivered through `onBtc` / `onMark` (and `onSnapshot` if given). For a value bounded by bids and listings, use `charts.getValuation`.

## stream

The Server-Sent Events client behind the streams. Uses `EventSource` in browsers and `fetch` with a streaming body in Node. Reconnects with exponential backoff (honours `retry:` and `Retry-After`) until you call the returned function; HTTP 4xx other than 408/429 stops it.

```ts
import { stream } from '@ow-cli/api'

const close = stream.subscribe('https://turbo.ordinalswallet.com/quotes/stream?collections=nodemonkes', {
  events: { btc: (data) => console.log(JSON.parse(data)) },
  onError: (err, { fatal }) => {},
}, { transport: 'auto', initialBackoffMs: 1000, maxBackoffMs: 30000 })
```

`stream.createSseParser(onEvent)` is the standalone incremental parser.
