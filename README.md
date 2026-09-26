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
```

### Send & Fees

```bash
ow send 10000 --to <address> --fee-rate 10
ow fee-estimate
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

## Testing

```bash
pnpm test
```

## License

MIT
