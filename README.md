# ow-cli

Command-line interface for [Ordinals Wallet](https://ordinalswallet.com). Buy, sell, list, transfer inscriptions and runes directly from your terminal.

## Install

```bash
pnpm install
pnpm build
```

To use globally:

```bash
npm link packages/cli
```

## Setup

```bash
# Generate a new wallet
ow wallet create

# Or import an existing mnemonic / WIF
ow wallet import
```

Your seed is encrypted with AES-256-GCM and stored in `~/.ow-cli/wallets/`. The public key and address are stored unencrypted for read-only operations.

### Multiple wallets

```bash
# Create a named wallet
ow wallet create --name trading

# List all wallets (* marks active)
ow wallet list

# Switch active wallet
ow wallet select trading

# Interactive wallet picker
ow wallet select
```

Existing single-wallet setups are automatically migrated to `wallets/default.json` on first run.

## Usage

### Wallet

```bash
ow wallet create                  # Generate a new 12-word mnemonic wallet
ow wallet create --name trading   # Create a named wallet
ow wallet import                  # Import from mnemonic or WIF
ow wallet import --name savings   # Import into a named wallet
ow wallet list                    # List all wallets (* marks active)
ow wallet select trading          # Switch active wallet
ow wallet select                  # Interactive wallet picker
ow wallet info                    # Address, balance, UTXOs
ow wallet inscriptions            # Owned inscriptions
ow wallet tokens                  # All token balances (runes, BRC-20, TAP, alkanes)
ow wallet consolidate --fee-rate 10  # Merge all UTXOs into a single output
ow wallet consolidate --fee-rate 10 --outputs <addr:sats>,<addr:sats>  # Custom outputs
ow wallet split --fee-rate 10 --splits 5   # Split balance into 5 equal outputs
ow wallet split --fee-rate 10 --splits 5 --amount 10000  # 5 outputs of 10000 sats each
```

### Marketplace

```bash
# Buy inscriptions (one or more)
ow market buy --ids <id1>,<id2>,<id3> --fee-rate 10

# Snipe-protected listings are detected and bought through the protected
# flow automatically; one command can mix both kinds (see below).

# Buy runes / alkanes
ow market buy-rune <txid:vout> --fee-rate 10
ow market buy-alkane --outpoints <txid:vout>,<txid:vout> --fee-rate 10

# List for sale (one or more). Snipe-protected by default when the
# marketplace offers it and the item has at least 330 sats of postage.
# Running it again at a new price reprices a protected listing.
ow market list --ids <id1>,<id2> --price 50000
ow market list --collection bitmap --above-floor 30
ow market list --collection bitmap --price 50000
ow market list --ids <id> --price 50000 --unprotected   # standard escrow listing

# Recover a protected listing whose escrow confirmed without a sale
# (valid once the escrow has 144 confirmations)
ow market recover <passthrough_txid> --fee-rate 5 [--to <address>] [--no-broadcast]

# Cancel listing
ow market delist <inscription_id>
```

#### Snipe-protected listings (Passthrough v4)

Listings come in two kinds, and `ow market buy` looks each id up and routes it:

| Kind | Build | Submit |
|------|-------|--------|
| Standard escrow | `POST /wallet/purchase-bulk` | `POST /market/purchase` |
| Snipe-protected | `POST /wallet/secure-purchase/build` | `POST /market/secure-purchase/submit` |

A listing is protected when the API marks it `protected: true` (or `secure_purchase_version: 2` with state `listed`). The standard build cannot see protected listings, so older CLI versions fail on them with "no longer listed".

For a protected purchase the CLI never signs what it has not checked. Before asking for your password it rebuilds the listing's escrow from the co-signer key pinned in this release and refuses unless, in every transaction:

- each passthrough spends exactly the outpoint you chose into the escrow rebuilt from the seller key and the pinned co-signer (checked from the passthrough's txid, input and output, so the witness-stripped parent the API now serves verifies the same as a signed one)
- the seller is paid exactly the listing's `escrow_price`, at the output matching the escrow input, and seller payout plus marketplace fee do not exceed the listed price
- the inscription lands at your address, on its own sats
- every other output is the marketplace fee (pinned address), the listed creator's royalty (capped at 10% of the listed price) or your change
- your inputs sit only before and after the escrow input, and in a chain each later sale spends only the previous sale's change outputs
- network fees are within a cap derived from `--fee-rate`
- the verified total is no more than the build's `economics.buyer_total_sats` (plus `--max-over <sats>`, default 0)
- the quote's `expires_at` has not passed, checked again before signing and before submitting
- only your own inputs are left for you to sign, with `SIGHASH_DEFAULT`/`SIGHASH_ALL` (never ANYONECANPAY), and none arrives pre-signed

It then signs only those inputs and submits the PSBTs unfinalized; Ordinals Wallet co-signs the escrow input and broadcasts. The amounts printed before the confirmation prompt are read from the verified transactions, not from the API's summary. Up to 12 protected items per purchase. A protected purchase needs at least two spendable UTXOs (`ow wallet split`).

When one command mixes both kinds, the protected purchase is submitted first and the standard one is built afterwards; if the second fails the error says what was already bought.

#### Listing with snipe protection

`ow market list` lists protected by default. Per item it reads the live outpoint and postage (`/inscription/:id/outpoint`); items with less than 330 sats of postage, or everything when the marketplace has protected listing off, go through the standard escrow instead, and the CLI says so before you confirm. `--unprotected` opts out entirely. If the API reports a co-signer key other than the one pinned in this release, the command refuses rather than falling back.

The flow is `POST /market/secure-listing/build-bulk` → verify → sign → `POST /market/secure-listing/authorize-bulk`. Nothing is broadcast. Before signing, each item's two templates are checked against an escrow rebuilt locally (`tr(NUMS, {multi_a(2, S, C), <144> CSV DROP <S> CHECKSIG})`, C pinned):

- passthrough: one input, exactly your item at your address; one output, your escrow; the postage moved whole or less exactly 12 sats, never below 330; key path only, `SIGHASH_DEFAULT`/`SIGHASH_ALL`
- sale template: one input spending `passthrough:0`, one output paying your address exactly your price; the NUMS internal key and only the sale leaf; `SIGHASH_SINGLE|ANYONECANPAY` (0x83)

The passthrough is signed on the key path; the sale on the sale leaf only (untweaked), and any stray key-path signature is dropped. Repricing a live protected listing is the same build + authorize at the new price. Per-item refusals (`already_listed`, `postage_too_small`, `template_digest_mismatch`, `signed_template_mutated`, ...) are printed with the same copy the wallet shows, and the command exits 1.

If a passthrough ever confirms without its sale, `ow market recover <passthrough_txid>` fetches the recovery template (`POST /market/secure-listing/recover`), checks it spends your escrow through the 144-block leaf to your address at a fee within `--fee-rate`, signs it and broadcasts it.

#### SDK

```ts
import * as api from '@ow-cli/api'
import { assertListingTemplates, assertSignedSaleTemplate, signListingTemplates, verifyPassthroughPurchase } from '@ow-cli/core'
import { planListing, executeProtectedListing, recoverProtectedListing, buildPassthroughPurchase, ProtectedTradeError } from '@ow-cli/shared'

await api.securePurchase.capabilities()
await api.secureListing.buildBulk({ protocol: 'ordinal', seller_address, seller_public_key, items: [{ outpoint, escrow_price_sats }] })
await api.secureListing.authorizeBulk(items)
await api.secureListing.status(outpoint)
await api.secureListing.recover({ passthrough_txid, fee_rate, destination })
```

Every protected-trading failure is a `ProtectedTradeError` (a `PassthroughError`) with a stable `code`, the `stage` it failed in, the HTTP `status` when it came from the API, and `retryable` for block/index races. None of these POSTs are retried automatically.

### Tokens

#### TAP

```bash
ow wallet tap balance             # TAP token balances
ow wallet tap inscribe-transfer \
  --ticker <ticker> --amount 10 --fee-rate 10
ow wallet tap send [inscription_id] \
  --to <address> --fee-rate 10
```

#### BRC-20

```bash
ow wallet brc20 balance           # BRC-20 balances
ow wallet brc20 inscribe-transfer \
  --ticker ordi --amount 10 --fee-rate 10
ow wallet brc20 inscribe-transfer \
  --ticker ordi --amount 100 --splits 5 --fee-rate 10  # Split into 5 inscriptions
ow wallet brc20 send [inscription_id] \
  --to <address> --fee-rate 10    # Send transfer inscription (interactive picker if no ID)
```

#### Runes

```bash
ow wallet rune balance            # Rune balances
ow wallet rune send \
  --rune-id 840000:1 --amount 100 --divisibility 0 \
  --to <address> --fee-rate 10 \
  --outpoints "<txid>:<vout>,<sats>"
ow wallet rune split \
  --rune-id 840000:1 --amount 100 --splits 5 --divisibility 0 \
  --fee-rate 10 --outpoints "<txid>:<vout>,<sats>"
```

#### Alkanes

```bash
ow wallet alkane balance          # Alkane balances
ow wallet alkane send \
  --rune-id <id> --amount 100 --divisibility 0 \
  --to <address> --fee-rate 10 \
  --outpoints "<txid>:<vout>,<sats>"
ow wallet alkane split \
  --rune-id <id> --amount 100 --splits 5 --divisibility 0 \
  --fee-rate 10 --outpoints "<txid>:<vout>,<sats>"
```

### Inscriptions

```bash
ow inscription info <id>
ow inscription inscribe <file> --fee-rate 10
ow inscription send <id> --to <address> --fee-rate 10
```

### Collections

```bash
ow collection info <slug>
ow collection listings <slug>
ow collection history <slug> --limit 10
ow collection search "ordinal foxes"
ow collection chart <slug> --interval 4h   # candles + fair line (--denom usd|mcap)
ow collection value <slug>                 # fair value, range, confidence
ow collection sales <slug> --limit 20      # sales across marketplaces
```

### Send & Fees

```bash
ow send 10000 --to <address> --fee-rate 10
ow fee-estimate
```

### Sign-in & Offers

```bash
ow auth login                      # BIP-322 sign-in; prints the session expiry (--show-token to print it)
ow offers list <slug>              # item, collection and trait offers on a collection
ow offers list <inscription-id>    # offers on one item, plus collection offers it could fill
ow offers list <address> --json    # offers a wallet received and sent
```

### Flags

All commands support `--json` for machine-readable output. Use `--debug` for full API error details.

## Architecture

Turborepo monorepo with three packages:

| Package | Description |
|---------|-------------|
| `@ow-cli/core` | Key management (BIP39/BIP32/WIF), P2TR address derivation, PSBT signing, passthrough v4 purchase verification |
| `@ow-cli/api` | Typed HTTP client for all Ordinals Wallet API endpoints |
| `@ow-cli/cli` | Commander.js CLI wiring commands to core + api |

### Client identification

Every request from `@ow-cli/api` carries an `x-ow-client` header made of one or
more space-separated `<name>/<version>` product tokens, most specific first. In
Node the SDK also sets `User-Agent: ow-cli/<version>` (browsers do not allow it).

| Caller | `x-ow-client` |
|--------|---------------|
| SDK, no app name | `ow-cli/0.1.0` |
| `ow` CLI / TUI | `ow-cli-cli/0.1.0 ow-cli/0.1.0` |
| Your app | `my-bot/1.2 ow-cli/0.1.0` |

Identify your own integration with `appName`:

```ts
import { setClient, createClient } from '@ow-cli/api'

setClient({ appName: 'my-bot/1.2' })          // default client used by the api helpers
const client = createClient({ appName: 'my-bot/1.2' }) // standalone axios instance
```

### Errors and retries

Every failed request throws an `OwApiError` with `status` (HTTP status, or `0`
for network errors), `code?`, `message` (read from the API's `{error, message}`,
`{error: "..."}` or plain-text bodies) and the raw `body`. Branch on `status`.

Idempotent requests (GET/HEAD/OPTIONS) are retried on network errors, `429`
and `5xx` with exponential backoff and jitter, honouring `Retry-After`. POSTs
are never retried unless a request passes `{ owRetry: true }`.

```ts
import { setClient, isOwApiError, wallet } from '@ow-cli/api'

setClient({ retries: 2, retryDelay: 300, maxDelay: 10_000 }) // defaults; retries: 0 disables

try {
  await wallet.getWallet(address)
} catch (err) {
  if (isOwApiError(err) && err.status === 400) console.error(err.message) // "Invalid Address"
}
```

### Outpoints

Wallet endpoints and `/inscription/:id/outpoint` return **serialized**
outpoints (72 hex: txid little-endian + vout u32 LE), not `txid:vout`:

```ts
import { outpointToTxidVout, wallet } from '@ow-cli/api'

const { inscriptions } = await wallet.getWallet(address)
outpointToTxidVout(inscriptions[0].outpoint!.outpoint) // 'a29e0b…1470:0'

const loc = await wallet.getInscriptionOutpoint(id) // live owner + location
outpointToTxidVout(loc.inscription.outpoint)
```

Other read helpers: `wallet.getBalance`, `wallet.getWalletInscriptions`,
`wallet.getAlkanesOutpoints`, `wallet.getRuneOutpoints`, and
`collection.getSoldEscrows(slug, { limit, offset })`.

### Wallet sign-in

Endpoints that need proof of ownership take a 24-hour session token. Sign the
sign-in message with BIP-322 (taproot key path or native segwit) and exchange
it at `POST /auth/session`:

```ts
import { auth, SessionManager } from '@ow-cli/api'
import { signBip322Simple } from '@ow-cli/core'
import { signInWithKey, sessionManagerForKey } from '@ow-cli/shared'

// With a key the SDK manages (keypair, { mnemonic } or { wif }); defaults to its bc1p address
const session = await signInWithKey({ mnemonic })   // { token, address, expires_at }

// With any wallet that can BIP-322 sign
const s = await auth.signIn({ address, sign: (message) => wallet.signMessage(message) })

// Cache one token per address; signs in again within 5 minutes of expiry
const sessions = sessionManagerForKey({ mnemonic })  // or new SessionManager({ sign: (address, m) => ... })
const token = await sessions.getToken(address)       // use in `signature` / `creator_signature` fields
```

`auth.signInMessage(address, nonce, issuedAtMs)` returns the exact message the
API rebuilds. Nonces are single use, signatures expire after 5 minutes, and the
sign-in POST is never retried. Keep tokens in memory and out of logs.

### Offers

Funded bids on an item, a collection or a trait (`/market/offers`). The server
builds every PSBT; the `@ow-cli/core` helpers check each one against values you
already trust (your keys and addresses, the agreed price, the pinned co-signer
`1d08b7c7…7dee`) and throw `OfferVerificationError` instead of signing anything
else.

```ts
import { offers } from '@ow-cli/api'
import { signOfferFunding, signOfferPresign, signAcceptPsbt, signOfferCancel } from '@ow-cli/core'

await offers.forCollection('bitmap')        // { summary, offers, collection_offers, trait_offers }
await offers.forInscription(id)             // { offers, collection_offers }
await offers.forWallet(address)             // { received, sent }

// Place (buyer): build → sign funding → prepare → pre-sign escrow leaf → activate
const b = await offers.build({ inscription_id: id, buyer_address, buyer_public_key,
  buyer_payment_address, buyer_payment_public_key, price_sats: 250_000, fee_rate: 10 })
const funding = signOfferFunding(b.funding_psbt, kp.privateKey, { buyerPublicKey: kp.publicKey,
  paymentAddress: buyer_payment_address, escrowValue: b.escrow_value, recoveryDelayBlocks: b.recovery_delay_blocks })
const p = await offers.prepare(b.offer_id, funding)
const accept = signOfferPresign(p.accept_psbt, { privateKey: kp.privateKey, scope: p.scope,
  signInputIndex: p.sign_input_index, sighash: p.sighash, recoveryDelayBlocks: b.recovery_delay_blocks,
  escrowValue: b.escrow_value, buyerAddress: buyer_address, priceSats: b.price_sats, marketFeeSats: b.market_fee_sats })
await offers.activate(b.offer_id, { funding_psbt: funding, accept_psbt: accept })

// Accept (seller). For collection/trait offers use buildFill/fill with the same verifier.
const a = await offers.buildAccept(offerId, { seller_address: me, seller_public_key })
const signed = signAcceptPsbt(a.accept_psbt, kp.privateKey,
  { myAddress: me, inscriptionOutpoint: 'txid:vout', priceSats: a.offer.price_sats, buyerAddress: a.offer.buyer_address })
await offers.accept(offerId, { seller_address: me, signed_psbt: signed })

// Reject (seller, off-chain) with a session token; cancel (buyer) refunds the escrow
await offers.reject(offerId, { address: me, token: await sessions.getToken(me) })
const c = await offers.buildCancel(offerId, { buyer_address, fee_rate: 3 })
await offers.cancel(offerId, { buyer_address, signed_psbt: signOfferCancel(c.cancel_psbt, { privateKey: kp.privateKey,
  buyerPaymentAddress: offer.buyer_payment_address, escrowValue: offer.escrow_value, recoveryDelayBlocks: offer.recovery_delay_blocks }) })
await offers.reconcile(offerId, refundTxid?)  // record a timelock refund / settle an in-flight broadcast
```

The seller check (`verifyAcceptPsbt`) requires: input 0 is your item and no
other input is yours; output 0 carries the whole item to the buyer; an output
pays you at least `price_sats`; exactly one output pays the marketplace fee;
at most one other output (buyer change); input 0 signs `SIGHASH_ALL`. Buyer
pre-signatures must be `0x01` for item offers and `0x82` for collection and
trait offers.

Error codes map to typed errors, all `OfferError` (an `OwApiError`):
`OfferExpiredError` (`offer_expired`), `OfferNotActiveError`
(`offer_not_active`), `OfferItemMovedError` (`item_moved`, `stale`),
`OfferNotOwnerError` (`not_the_owner`), `OfferItemNotEligibleError`
(`item_not_eligible`), `OfferAttemptPendingError` (`offer_attempt_pending`, call
`reconcile`), `OfferUnauthorizedError` (`unauthorized`). Offer POSTs are never
retried.

## Testing

```bash
pnpm test
```

## License

MIT
