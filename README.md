# ow-cli

Tools for [Ordinals Wallet](https://ordinalswallet.com): a command line, a TypeScript SDK and a Rust crate for Bitcoin ordinals market data and trading.

```console
$ ow collection value bitcoin-puppets

bitcoin-puppets
Fair:       1,601,468 sats ($1346.00)
Range:      1,300,232 sats to 2,045,220 sats
Confidence: 54%
Method:     discounted-floor (tape: global)
Floor:      2,045,220 sats
Trades:     134 (7d), 267 (30d)
```

That value comes from sales on every marketplace, not one order book. The same data powers charts, sales feeds and live quotes, and the same tools can list and buy with snipe protection.

Full documentation: **[blog.ordinalswallet.com/docs](https://blog.ordinalswallet.com/docs)**

## Small on purpose

This code signs Bitcoin transactions, so every dependency is something that could steal from you. We keep the list short enough to read.

| Package | Runtime dependencies | Why |
| --- | --- | --- |
| `@ow-cli/api` | **none** | HTTP is the built-in `fetch`. |
| `@ow-cli/core` | `@noble/hashes`, `@noble/secp256k1`, `@scure/bip32`, `@scure/bip39`, `@scure/btc-signer` | Key derivation and signing. Audited libraries from one author that depend only on each other. |
| `@ow-cli/cli` | `commander`, `@scure/btc-signer` | Argument parsing. Prompts are built in. |
| `ordinalswallet` (Rust) | `ureq`, `serde`, `serde_json`, `getrandom`; `bitcoin` with the `signing` feature | Blocking HTTP with rustls, JSON, nonces. No async runtime. `bitcoin` (rust-bitcoin 0.32, `std` only) for keys, PSBTs and libsecp256k1. |

The whole TypeScript tree installs nine production packages: the five above, `@noble/curves`, `@scure/base`, `micro-packed` (all the same author) and `commander`. Every version is pinned exactly, the lockfile is authoritative, and install scripts are off (`ignore-scripts=true`). Rust adds `cargo-deny` rules that allow only crates.io.

Check it yourself:

```bash
pnpm ls -r --prod --depth Infinity
pnpm audit
cd rust && cargo tree -e normal && cargo deny check
```

## What it will sign

The API builds transactions; this code decides whether to sign them.

* **Every server-built transaction is checked first.** Outputs are rebuilt locally and compared: who gets paid, how much, and where the item goes.
* **The co-signer key is pinned.** Snipe-protected escrows are rebuilt from the seller's key and Ordinals Wallet's published key. Any other key and it stops.
* **Quotes expire.** It refuses to sign after `expires_at`, or when the total is above the quote.
* **Buyers sign `SIGHASH_ALL`.** The only `ANYONECANPAY` signature is the escrow pre-signature on a collection or trait offer, which that offer type requires.
* **Keys stay local.** Seeds are encrypted with AES-256-GCM in `~/.ow-cli/wallets/`.

## Install

Not on npm or crates.io yet. From source:

```bash
git clone https://github.com/ordinals-wallet/ow-cli
cd ow-cli
pnpm install --frozen-lockfile
pnpm build
npm link packages/cli
```

Requires Node 22 for the CLI, Node 18 for the SDK.

## CLI

```bash
ow wallet create                          # new wallet, encrypted locally
ow wallet info                            # balance and coins
ow wallet tokens                          # runes, BRC-20, TAP, alkanes

ow collection value bitcoin-puppets       # fair value, range, confidence
ow collection chart bitcoin-puppets       # candles and the fair band
ow collection sales bitcoin-puppets       # sales on every marketplace

ow market buy --ids <id> --fee-rate 5     # protected listings bought safely
ow market list --ids <id> --price 50000   # snipe-protected by default
ow market delist <id>
ow market recover <passthrough_txid>      # take back an escrow after 144 blocks

ow offers list bitcoin-puppets
ow auth login                             # BIP-322 sign-in
```

Add `--json` to any command for scripting. Full reference: [docs/developers/tools/cli](https://blog.ordinalswallet.com/docs/developers/tools/cli).

## TypeScript SDK

```typescript
import { charts, feeds, setClient } from "@ow-cli/api";

setClient({ appName: "my-bot/1.0.0" });

const value = await charts.getValuation("bitcoin-puppets");
console.log(value.fair_sats, value.confidence);

feeds.streamCollectionFeed("bitcoin-puppets", {
  onRows: (rows) => console.log(rows[0]),
});
```

| Module | For |
| --- | --- |
| `charts` | Candles, fair value, batch valuation |
| `sales`, `feeds`, `quotes` | Sales on every marketplace, live streams, prices |
| `collection`, `wallet`, `search` | Collections, balances, holdings |
| `market`, `secureListing`, `securePurchase`, `offers` | Listing, buying and bidding |
| `auth` | Wallet sign-in and session tokens |

Reads retry on `5xx` and `429` with backoff and honour `Retry-After`. Writes never retry. Errors are `OwApiError` with a `status`. Full reference: [docs/developers/tools/sdk](https://blog.ordinalswallet.com/docs/developers/tools/sdk).

## Rust

```rust
let client = ordinalswallet::Client::builder()
    .app_name("my-bot/1.0.0")
    .build()?;
let value = client.charts().valuation("bitcoin-puppets")?;
println!("{} sats", value.fair_sats.unwrap_or_default());
```

Reads, streams, sign-in sessions and the offer and protected-trading write routes. Signing (keys, BIP-322, offers, protected trading), verified against the same vectors as the TypeScript SDK, is behind the `signing` feature and adds only the `bitcoin` crate. See [rust/ordinalswallet](rust/ordinalswallet/README.md).

## One behaviour, two languages

`fixtures/` holds test vectors that both SDKs must pass: the exact sign-in message, outpoint decoding, escrow scripts, valid and tampered transaction templates, and real API responses. If the TypeScript and Rust code ever disagree, a test fails. See [fixtures/README.md](fixtures/README.md).

## Layout

```
packages/api      @ow-cli/api     typed client, zero dependencies
packages/core     @ow-cli/core    keys, signing, transaction checks
packages/shared   @ow-cli/shared  flows that combine the two
packages/cli      @ow-cli/cli     the `ow` command
rust/             ordinalswallet  Rust crate
fixtures/                          shared test vectors
```

## Developing

```bash
pnpm install --frozen-lockfile
pnpm build && pnpm test
pnpm audit
cd rust && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test --all-features
```

Tests never send writes to the live API. Changes that touch signing need a test vector in `fixtures/` that both languages pass.

## Security

Found a problem? Email support@ordinalswallet.com rather than opening a public issue.

## License

MIT. See [LICENSE](LICENSE).
