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

# Buy runes / alkanes
ow market buy-rune <txid:vout> --fee-rate 10
ow market buy-alkane --outpoints <txid:vout>,<txid:vout> --fee-rate 10

# List for sale (one or more)
ow market list --ids <id1>,<id2> --price 50000
ow market list --collection bitmap --above-floor 30
ow market list --collection bitmap --price 50000

# Cancel listing
ow market delist <inscription_id>
```

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
| `@ow-cli/core` | Key management (BIP39/BIP32/WIF), P2TR address derivation, PSBT signing |
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
