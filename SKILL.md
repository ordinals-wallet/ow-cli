---
name: ordinals-wallet
description: Build, debug, and extend the Ordinals Wallet CLI (ow-cli) — a Bitcoin Ordinals marketplace tool for buying, selling, listing, and transferring inscriptions, runes, BRC-20, and Alkanes tokens. Use when working on ow-cli code, its API client, PSBT signing, escrow flows, or any Bitcoin Ordinals / inscription / rune marketplace feature.
---

# Ordinals Wallet CLI Skill

## Project overview

`ow-cli` is a CLI for [Ordinals Wallet](https://ordinalswallet.com). It lets users buy, sell, list, transfer inscriptions and runes from the terminal. Turborepo monorepo at `~/proj/ow/ow-cli` with three packages:

| Package | Path | Purpose |
|---------|------|---------|
| `@ow-cli/core` | `packages/core` | BIP39/BIP32 key derivation, WIF decode, P2TR address, PSBT signing |
| `@ow-cli/api` | `packages/api` | Typed HTTP client for all OW API endpoints (axios) + TAP socket |
| `@ow-cli/cli` | `packages/cli` | Commander.js CLI commands wiring core + api |

## Key commands

```
ow wallet create|import|info|inscriptions|tokens
ow wallet consolidate --fee-rate N [--utxos txid:vout:value,...]
ow market buy <inscription_id> --fee-rate N
ow market buy-rune <txid:vout> --fee-rate N
ow market buy-bulk --ids <id1,id2,...> --fee-rate N
ow market buy-alkane --outpoints <op1,op2,...> --fee-rate N
ow market list <inscription_id> --price N
ow market list-bulk --collection <slug> --above-floor <pct>
ow market delist <inscription_id>
ow inscription info <id>
ow inscription inscribe <file> --fee-rate N
ow inscription send <id> --to <addr> --fee-rate N
ow collection info|listings|history|search
ow send <sats> --to <addr> --fee-rate N
ow fee-estimate
ow wallet rune balance
ow wallet rune send --rune-id <block:tx> --amount N --divisibility N --to <addr> --fee-rate N --outpoints <list>
ow wallet rune split --rune-id <block:tx> --amount N --splits N --divisibility N --fee-rate N --outpoints <list>
ow wallet alkane balance
ow wallet alkane send --rune-id <block:tx> --amount N --divisibility N --to <addr> --fee-rate N --outpoints <list>
ow wallet alkane split --rune-id <block:tx> --amount N --splits N --divisibility N --fee-rate N --outpoints <list>
ow wallet brc20 balance
ow wallet brc20 inscribe-transfer --ticker <name> --amount N --fee-rate N [--splits N]
ow wallet brc20 send [inscription_id] --to <addr> --fee-rate N
ow wallet tap balance
ow wallet tap inscribe-transfer --ticker <name> --amount N --fee-rate N [--splits N]
ow wallet tap send [inscription_id] --to <addr> --fee-rate N
```

All commands accept `--json` for machine output and `--debug` for full API errors.

## API base

All HTTP goes through `https://turbo.ordinalswallet.com`. The client is configured in `packages/api/src/client.ts`.

Key endpoints:
- `GET /wallet/:address` — wallet info, inscriptions, balances
- `GET /wallet/:address/utxos|rune-balance|brc20-balance|alkanes-balance`
- `GET /inscription/:id` — inscription detail
- `GET /wallet/fee-estimates` — fee rates
- `POST /wallet/broadcast` — broadcast raw tx
- `POST /wallet/purchase|purchase-bulk|purchase-bulk-runes` — build purchase PSBTs
- `POST /wallet/escrow|escrow-bulk` — build escrow PSBTs
- `POST /wallet/send|inscription/send` — build send PSBTs
- `POST /rune/transfer` — build rune transfer PSBT (simple or edict-based)
- `POST /alkane/transfer` — build alkane transfer PSBT
- `POST /wallet/build` — build consolidation PSBT
- `POST /wallet/broadcast-bulk` — broadcast multiple raw txs
- `POST /wallet/purchase-bulk-alkanes` — build alkane purchase PSBT
- `POST /market/purchase|purchase-rune` — submit signed purchase
- `POST /market/escrow-bulk` — submit signed escrow listing
- `POST /market/cancel-escrow` — cancel listing
- `POST /inscribe/estimate|upload` — inscription cost estimate and upload
- `GET /collection/:slug|:slug/escrows|:slug/sold-escrows|:slug/stats`
- `GET /v2/search/:input` — search collections/inscriptions

## PSBT signing flow

All signing happens in `packages/core/src/signer.ts`. Two functions:

### `signPsbt(opts)`
1. Parse PSBT with `allowLegacyWitnessUtxo`
2. For each input matching the wallet's P2TR script: set `tapInternalKey`
3. Sign with `signIdx` using sighash types `[DEFAULT, ALL, SINGLE|ANYONECANPAY]`
4. Finalize by setting `finalScriptWitness = [tapKeySig]`
5. If `disableExtract`: return PSBT hex (for escrow listings). Otherwise: return raw tx hex.

### `signPurchaseFlow(privateKey, publicKey, setupHex, purchaseHex)`
1. Sign and extract the setup PSBT → raw tx
2. Get the setup txid from the signed transaction
3. In the purchase PSBT, replace zero-txid placeholder inputs with the real setup txid
4. Sign and extract the purchase PSBT → raw tx
5. Return `{ signedSetup, signedPurchase }`

## Type system

All API types live in `packages/api/src/types.ts`. No `any` types — everything is fully typed. Key interfaces:

- `WalletInfo`, `WalletInscription`, `InscriptionDetail`
- `RuneBalance`, `Brc20Balance`, `AlkanesBalance`
- `Escrow`, `CollectionMetadata`, `CollectionStats`
- `FeeEstimates` (fields: `fastestFee`, `halfHourFee`, `hourFee`, `economyFee`, `minimumFee`)
- `BuildPurchaseRequest/Response`, `SubmitPurchaseRequest/Response`
- `BuildEscrowRequest/Response`, `SubmitEscrowRequest/Response`
- `SearchResult`, `SearchCollection`
- `InscribeEstimateRequest/Response`, `InscribeUploadResponse`
- `RuneEdict`, `RuneOutpoint`, `BuildRuneEdictTransferRequest`, `BuildAlkaneTransferRequest`
- `BuildConsolidateRequest/Response`, `BuildPurchaseAlkanesRequest`, `BroadcastBulkResult`

TAP protocol types are in `packages/api/src/tap.ts` (`TapToken`).

## Testing

```bash
pnpm test        # all packages
pnpm build       # build all
```

- **Core tests**: `packages/core/__tests__/` — keys, signer, address
- **API tests**: `packages/api/__tests__/` — MSW mock server, all endpoints
- **CLI tests**: `packages/cli/__tests__/` — validators, errors, output formatting

MSW handlers are in `packages/api/__tests__/handlers.ts`. Vitest config per-package.

## Conventions

- ESM-only (`"type": "module"`, `.js` extensions in imports)
- `tsup` for builds, `vitest` for tests
- No `any` types anywhere — use `unknown` + type guards or specific interfaces
- `noImplicitAny` enabled in `tsconfig.base.json`
- Keystore encrypted with AES-256-GCM at `~/.ow-cli/keystore.json`
- CLI validators in `packages/cli/src/utils/validate.ts` throw `CliError`
- `handleError()` in `packages/cli/src/utils/errors.ts` maps errors → user messages
- `formatJson(data: unknown)`, `formatSats()`, `formatTable()` in `packages/cli/src/output.ts`
