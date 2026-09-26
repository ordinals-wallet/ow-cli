# Shared test fixtures

Language-neutral test vectors and recorded API responses. The TypeScript SDK (`packages/api/__tests__/shared-vectors.test.ts`, plus the msw handlers) and the Rust SDK (`rust/ordinalswallet/tests/`) both read these files, so the two implementations are held to the same behaviour. Change a file here and both suites must still pass.

## Vectors

| File | What it pins | Consumed by |
| --- | --- | --- |
| `sign-in-message.json` | The exact BIP-322 sign-in message for `POST /auth/session`, and the nonce shape (32 lowercase hex). | TS `shared-vectors.test.ts`; Rust `tests/vectors.rs::sign_in_message_vectors` |
| `outpoint.json` | 72-hex serialized outpoints to `txid:vout` (including a real mainnet case that matches `api/inscription.json`'s satpoint), passthrough and lowercasing of `txid:vout`, round trips, rejected inputs. | TS `shared-vectors.test.ts`; Rust `outpoint_vectors` |
| `client-header.json` | The `x-ow-client` value for an app name: whitespace collapsed, blank names ignored. `{sdk}` is `ow-cli/<version>` in TypeScript and `ordinalswallet-rs/<version>` in Rust. | TS `shared-vectors.test.ts`; Rust `client_header_vectors` (also checks the wire) |
| `retry.json` | Default retry settings, `Retry-After` parsing (seconds, fractions, IMF-fixdate), the backoff formula at fixed random values, bounds for the default backoff, and which statuses a GET retries. | TS `shared-vectors.test.ts`; Rust `retry_vectors` |
| `feeds-deltas.json` | Feed store behaviour: snapshot, delta order (removed, added, updated merged), `removed` as strings or `{key}`, pending-first/newest/key ordering, `max_rows`. `sse_replay` gives the expected state after every event of `sse/activity_stream.txt`. | TS `shared-vectors.test.ts`; Rust `feeds_delta_vectors`, `tests/sse.rs::activity_feed_stream_replays_the_capture` |
| `error-bodies.json` | Error bodies the API returns and the `status` / `message` / `code` / `body` each SDK must report. | TS `shared-vectors.test.ts`; Rust `error_body_vectors` |
| `sse/*.txt` + `sse/*.expected.json` | SSE streams (two live captures and a spec edge-case file) and the events, comments and `retry:` values a parser must produce, whatever the chunking or line endings. | TS `shared-vectors.test.ts`, `stream.test.ts`, `feeds.test.ts`; Rust `sse_vectors`, `tests/sse.rs`, `tests/decode.rs` |

## Recorded API responses (`api/`)

Real GET responses from `turbo.ordinalswallet.com`, trimmed. The TypeScript msw handlers serve them and Rust `tests/decode.rs` decodes every file into its typed struct (a new file without a decode check fails the test).

| File | Endpoint |
| --- | --- |
| `collection.json`, `collection-stats.json`, `attributes.json` | `/collection/:slug`, `/stats`, `/attributes` |
| `escrows.json`, `sold-escrows.json`, `sold-escrows-rune.json` | `/collection/:slug/escrows`, `/sold-escrows` |
| `wallet.json`, `wallet-balance.json`, `wallet-inscriptions.json` | `/wallet/:address`, `/balance`, `/inscriptions` |
| `rune-balance.json`, `brc20-balance.json`, `alkanes-balance.json`, `alkanes-outpoints.json` | token balances and outpoints |
| `inscription.json`, `inscription-outpoint.json` | `/inscription/:id`, `/outpoint` |
| `ohlcv.json`, `ohlcv_usd.json`, `valuation.json`, `valuations.json` | charts and valuations |
| `sales.json`, `sales_volume.json`, `wallet_sales.json` | global sales tape |
| `feed.json`, `activity.json`, `mempool_sales.json`, `recent_listings.json` | feeds |
| `quotes.json` | `/quotes` |
| `market-listing.json`, `secure-purchase-capabilities.json` | `/market/escrow/:id`, `/market/secure-purchase/capabilities` |
| `search-collections.json`, `search-url.json` | `/v2/search/:query` |
| `health.json`, `fee-estimates.json` | `/`, `/wallet/fee-estimates` |
| `offers-live.json` | `/market/offers/*` reads (several responses in one file) |

Capture new responses with GET requests only; never record from POST endpoints against production.
