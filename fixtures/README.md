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

## Signing vectors

Generated from `@ow-cli/core` by `packages/core/__tests__/shared-vectors/generate.ts`. `packages/core/__tests__/shared-vectors.test.ts` regenerates every file and fails on any difference, then replays each case through the TypeScript functions; `rust/ordinalswallet/tests/signing_vectors.rs` (feature `signing`) replays the same cases. Schnorr signatures use all-zero BIP-340 aux randomness (`aux_rand`), so every signed PSBT, signature and raw transaction must match byte for byte in both languages. Refusals are `{ "ok": false, "code": … }` with the TypeScript `PassthroughError` code; offer checks record the exact problem strings. Keys are public test keys (the BIP-39 "abandon … about" mnemonic, the BIP-322 test WIFs, constant byte patterns); none holds funds. Regenerate with `OW_WRITE_VECTORS=1 pnpm --filter @ow-cli/core exec vitest run __tests__/shared-vectors.test.ts`.

| File | What it pins | Consumed by |
| --- | --- | --- |
| `bip39.json` | Official Trezor English vectors (entropy, mnemonic, `TREZOR` seed, BIP-32 root xprv), empty-passphrase seeds, invalid mnemonics, the wordlist SHA-256. | TS `shared-vectors.test.ts`; Rust `bip39_vectors` (+ unit test on the embedded wordlist) |
| `derivation.json` | Mnemonic → `m/86'/0'/0'/0/0` key, compressed and x-only public keys, BIP-86 `bc1p` and same-key `bc1q` addresses (incl. the BIP-86 test vector); WIF → the same. | TS; Rust `derivation_vectors` |
| `bip322.json` | Official BIP-322 hashes and signatures (P2WPKH, P2TR), sign-in and other messages signed with the test keys for `bc1p` and `bc1q`, verify cases (tampering, wrong sighash byte, `smp` prefix, trailing bytes, legacy), sign refusals. | TS; Rust `bip322_vectors`, `signing_key_is_a_message_signer_for_sign_in` |
| `escrow.json` | Offer escrows for several buyer keys and recovery delays (1-16 as `OP_N`); protected escrows for several seller keys with control blocks and sale-leaf hash; escrow refusals; leaf parsing. | TS; Rust `escrow_vectors` |
| `offer-funding.json`, `offer-presign.json`, `offer-accept.json`, `offer-cancel.json` | Offer PSBTs (server-built from `ow-api` offers.rs templates, plus mutations): the exact problem list, and the signed PSBT when there are none (or the signing refusal). | TS; Rust `offer_*_vectors` |
| `listing-templates.json` | Protected listing templates, honest and tampered one rule per case: `assertListingTemplates` result or code, `signListingTemplates` output; `assertSignedSaleTemplate` cases. | TS; Rust `listing_template_vectors`, `tests/signing_flows.rs` |
| `recovery.json` | Recovery templates through the `<144> CSV` leaf: result or code, and the finalized raw transaction. | TS; Rust `recovery_vectors`, `signing_flows.rs` |
| `purchase-verify.json` | Protected purchases: `verifySale` / `verifySetup` / `verifyPassthroughPurchase` results or codes (payout, asset, parents, chain links, fees, royalties, budget, expiry), `signOwnInputs` output, `assertQuoteFresh`. | TS; Rust `purchase_vectors`, `signing_flows.rs` |
| `cancel-proof.json` | Legacy (deprecated) cancel proofs: the signed PSBT and its shape, or the refusal code; a seal-shaped (0x81) proof. Delisting now sends a sign-in session token. | TS; Rust `cancel_proof_vectors`, `signing_flows.rs` |
| `chain/protected-sales.json` | Two confirmed mainnet protected sales with prevouts and parents (captured by GET): the escrow, control block and both real signatures must check against locally rebuilt scripts and sighashes. | TS; Rust `mainnet_protected_sales_match_local_escrow_and_sighash` |

Quote expiry text without a time zone is deliberately absent from the vectors: JavaScript reads it as local time, Rust refuses it as unreadable (so as expired).

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
| `search-collections.json`, `search-url.json` | `/search/:query` |
| `health.json`, `fee-estimates.json` | `/`, `/wallet/fee-estimates` |
| `offers-live.json` | `/market/offers/*` reads (several responses in one file) |

Capture new responses with GET requests only; never record from POST endpoints against production.
