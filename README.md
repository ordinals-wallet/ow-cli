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

Your seed is encrypted with AES-256-GCM and stored at `~/.ow-cli/keystore.json`. The public key and address are stored unencrypted for read-only operations.

## Usage

### Wallet

```bash
ow wallet info                    # Address, balance, UTXOs
ow wallet inscriptions            # Owned inscriptions
ow wallet runes                   # Rune balances
ow wallet brc20                   # BRC-20 balances
ow wallet alkanes                 # Alkanes balances
ow wallet tokens                  # All token balances
```

### Marketplace

```bash
# Buy
ow market buy <inscription_id> --fee-rate 10
ow market buy-rune <txid:vout> --fee-rate 10

# List for sale
ow market list <inscription_id> --price 50000
ow market list-bulk --collection bitmap --above-floor 30
ow market list-bulk --ids <id1>,<id2>,<id3> --price 50000

# Cancel listing
ow market delist <inscription_id>
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

## Testing

```bash
pnpm test
```

## License

MIT
