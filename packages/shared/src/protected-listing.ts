import {
  signListingTemplates,
  signRecovery,
  toXOnly,
  hexToBytes,
  MIN_ESCROW_VALUE_SATS,
  PASSTHROUGH_POLICY,
  PINNED_COSIGNER_XONLY_HEX,
} from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type {
  SecureListingAuthorizeItem,
  SecureListingBuiltItem,
  SecurePurchaseCapabilities,
} from '@ow-cli/api'
import { ProtectedTradeError, protectedErrorMessage, toProtectedError } from './protected-errors.js'
import type { ProtectedTradeStage } from './protected-errors.js'

/**
 * Snipe-protected (passthrough v4) listing, seller side.
 *
 *   build-bulk   -> both templates per item, verified locally
 *   sign         -> passthrough on the key path, sale on the script path (0x83)
 *   authorize    -> the API stores the signatures and the listing goes live
 *
 * Nothing is broadcast by listing. Repricing a live protected listing is the
 * same flow at the new price. `recoverProtectedListing` spends an escrow that
 * confirmed without its sale back to the seller after 144 blocks.
 */

export interface ListingItemInput {
  inscriptionId: string
  /** What the seller receives, in sats. */
  priceSats: number
}

export interface PlannedListing {
  inscriptionId: string
  priceSats: number
  /** `txid:vout` the inscription sits on. */
  outpoint: string
  postageSat: number
  protected: boolean
  /** Set when an item goes standard although protection was wanted. */
  standardReason?: string
  /** True when a protected listing already exists at this outpoint (this is a reprice). */
  repricing?: boolean
}

export interface ListingPlan {
  items: PlannedListing[]
  protectedItems: PlannedListing[]
  standardItems: PlannedListing[]
}

export interface ProtectedListingFailure {
  inscriptionId?: string
  outpoint: string
  code: string
  message: string
}

const withStage = <T>(stage: ProtectedTradeStage, run: () => Promise<T>): Promise<T> =>
  run().catch((err) => {
    throw toProtectedError(err, stage)
  })

/**
 * Whether protected listing is on for inscriptions right now. Throws, rather
 * than falling back, when the API names a co-signer other than the pinned one.
 */
export async function protectedListingAvailability(): Promise<{ available: boolean; reason?: string; minPostageSat: number }> {
  const caps: SecurePurchaseCapabilities = await withStage('listing capability check', () => api.securePurchase.capabilities())
  const minPostageSat = Math.max(MIN_ESCROW_VALUE_SATS, Number(caps.min_postage_sats) || 0)
  const policy = caps.escrow_policy || caps.policy || caps.mode
  if (policy !== PASSTHROUGH_POLICY) {
    return { available: false, reason: `the marketplace reports protection policy "${policy ?? 'none'}"`, minPostageSat }
  }
  if (String(caps.cosigner_public_key || '').toLowerCase() !== PINNED_COSIGNER_XONLY_HEX) {
    throw new ProtectedTradeError(
      'cosigner_key_unpinned',
      'The marketplace co-signer key does not match the key built into this CLI; refusing to list. Update ow-cli, or list with --unprotected.',
      'listing capability check',
    )
  }
  if (caps.listing_enabled === false) return { available: false, reason: 'protected listing is turned off', minPostageSat }
  const status = caps.protocol_status?.ordinal
  if (status && status !== 'enabled') return { available: false, reason: `protection for inscriptions is ${status}`, minPostageSat }
  return { available: true, minPostageSat }
}

/**
 * Look each inscription up and decide how it will be listed: protected by
 * default when the marketplace allows it and the postage is at least 330
 * sats, standard when `unprotected` is set or protection cannot cover it.
 */
export async function planListing(
  items: ListingItemInput[],
  address: string,
  options: { unprotected?: boolean } = {},
): Promise<ListingPlan> {
  const ids = items.map((i) => i.inscriptionId)
  if (new Set(ids).size !== ids.length) {
    throw new ProtectedTradeError('duplicate_items', 'The same inscription appears more than once')
  }
  const availability = options.unprotected ? null : await protectedListingAvailability()
  const planned = await Promise.all(
    items.map(async (item): Promise<PlannedListing> => {
      // Live location, not the cached /inscription/:id view: a stale outpoint cannot be listed.
      const live = await api.wallet.getInscriptionOutpoint(item.inscriptionId)
      let outpoint: string | null = null
      try {
        outpoint = live?.inscription?.outpoint ? api.outpointToTxidVout(live.inscription.outpoint) : null
      } catch {
        outpoint = null
      }
      const postageSat = Number(live?.inscription?.sats ?? live?.sats)
      if (!outpoint || !Number.isSafeInteger(postageSat)) {
        throw new ProtectedTradeError('listing_malformed', `Could not find where ${item.inscriptionId} sits; try again`)
      }
      const owner = live.owner || live.inscription.address
      if (owner && owner !== address) {
        throw new ProtectedTradeError('not_owner', `${item.inscriptionId} is not in this wallet`)
      }
      const base = { inscriptionId: item.inscriptionId, priceSats: item.priceSats, outpoint, postageSat }
      if (!availability) return { ...base, protected: false }
      if (!availability.available) return { ...base, protected: false, standardReason: availability.reason }
      if (postageSat < availability.minPostageSat) {
        return { ...base, protected: false, standardReason: `postage ${postageSat} sats is below the ${availability.minPostageSat} sat minimum for protection` }
      }
      const existing = await api.secureListing.status(outpoint).catch(() => null)
      return { ...base, protected: true, repricing: existing?.state === 'listed' }
    }),
  )
  return {
    items: planned,
    protectedItems: planned.filter((i) => i.protected),
    standardItems: planned.filter((i) => !i.protected),
  }
}

export interface BuiltProtectedListing {
  inscriptionId?: string
  outpoint: string
  priceSats: number
  row: SecureListingBuiltItem
}

function failure(outpoint: string, code: string, stage: ProtectedTradeStage, detail?: string, inscriptionId?: string): ProtectedListingFailure {
  const copy = protectedErrorMessage(code, stage)
  return { outpoint, inscriptionId, code, message: detail ? (copy ? `${detail}. ${copy}` : detail) : copy || 'Listing was rejected. Try again.' }
}

/** Build templates for protected items. Per-item refusals come back as failures; the rest are ready to sign. */
export async function buildProtectedListings(params: {
  items: Array<{ outpoint: string; priceSats: number; inscriptionId?: string }>
  address: string
  publicKey: string
}): Promise<{ built: BuiltProtectedListing[]; failures: ProtectedListingFailure[] }> {
  if (params.items.length === 0) return { built: [], failures: [] }
  const res = await withStage('listing build', () =>
    api.secureListing.buildBulk({
      protocol: 'ordinal',
      seller_address: params.address,
      seller_public_key: params.publicKey,
      items: params.items.map((i) => ({ outpoint: i.outpoint, escrow_price_sats: i.priceSats })),
    }),
  )
  const rows = Array.isArray(res?.items) ? res.items : []
  const built: BuiltProtectedListing[] = []
  const failures: ProtectedListingFailure[] = []
  for (const item of params.items) {
    // Rows are matched by outpoint, never by position: the API builds items concurrently.
    const row = rows.find((r) => String(r?.outpoint || '').toLowerCase() === item.outpoint.toLowerCase())
    if (!row) {
      failures.push(failure(item.outpoint, 'invalid_listing_build', 'listing build', 'The build returned no templates for this item', item.inscriptionId))
    } else if (row.error) {
      failures.push(failure(item.outpoint, String(row.code || 'secure_listing_rejected'), 'listing build', undefined, item.inscriptionId))
    } else if (row.state !== 'authorization_required' || typeof row.psbt !== 'string' || typeof row.sale_psbt !== 'string') {
      failures.push(failure(item.outpoint, 'invalid_listing_build', 'listing build', 'The build did not return both templates', item.inscriptionId))
    } else if (row.policy !== PASSTHROUGH_POLICY) {
      failures.push(failure(item.outpoint, 'unsafe_listing_policy', 'listing build', `Listing policy "${row.policy}" is not supported`, item.inscriptionId))
    } else if (String(row.cosigner_public_key || '').toLowerCase() !== PINNED_COSIGNER_XONLY_HEX) {
      failures.push(failure(item.outpoint, 'cosigner_key_unpinned', 'listing build', 'The template names a co-signer other than the pinned one', item.inscriptionId))
    } else if (Number(row.escrow_price_sats) !== item.priceSats) {
      failures.push(failure(item.outpoint, 'listing_price_mismatch', 'listing build', `The template is for ${row.escrow_price_sats} sats, not ${item.priceSats}`, item.inscriptionId))
    } else {
      built.push({ inscriptionId: item.inscriptionId, outpoint: item.outpoint, priceSats: item.priceSats, row })
    }
  }
  return { built, failures }
}

/**
 * Verify every template against an escrow rebuilt from our key and the pinned
 * co-signer, then sign. A template that fails verification is reported, never
 * signed. Sends nothing.
 */
export function signProtectedListings(
  built: BuiltProtectedListing[],
  keys: { privateKey: Uint8Array; address: string; publicKey: string },
): { payloads: SecureListingAuthorizeItem[]; failures: ProtectedListingFailure[] } {
  const payloads: SecureListingAuthorizeItem[] = []
  const failures: ProtectedListingFailure[] = []
  for (const b of built) {
    try {
      const signed = signListingTemplates({
        passthroughPsbtHex: b.row.psbt,
        salePsbtHex: b.row.sale_psbt,
        expectedOutpoint: b.outpoint,
        sellerAddress: keys.address,
        assetAddress: keys.address,
        expectedSellerSats: b.priceSats,
        privateKey: keys.privateKey,
      })
      if (b.row.passthrough_txid && b.row.passthrough_txid.toLowerCase() !== signed.passthroughTxid) {
        throw new ProtectedTradeError('stale_listing', 'Passthrough txid does not match its template', 'listing sign')
      }
      payloads.push({
        outpoint: b.outpoint,
        protocol: 'ordinal',
        seller_public_key: keys.publicKey,
        template_digest: b.row.template_digest,
        psbt: signed.psbt,
        sale_psbt: signed.salePsbt,
        escrow_price_sats: b.priceSats,
      })
    } catch (err) {
      const e = toProtectedError(err, 'listing sign') as ProtectedTradeError
      failures.push({ outpoint: b.outpoint, inscriptionId: b.inscriptionId, code: e.code ?? 'sign_failed', message: e.message })
    }
  }
  return { payloads, failures }
}

/** Publish signed templates. Returns the outpoints now listed and the per-item refusals. */
export async function authorizeProtectedListings(
  payloads: SecureListingAuthorizeItem[],
): Promise<{ listed: Array<{ outpoint: string; passthroughTxid?: string }>; failures: ProtectedListingFailure[] }> {
  if (payloads.length === 0) return { listed: [], failures: [] }
  const res = await withStage('listing authorize', () => api.secureListing.authorizeBulk(payloads))
  const rows = Array.isArray(res?.items) ? res.items : []
  const listed: Array<{ outpoint: string; passthroughTxid?: string }> = []
  const failures: ProtectedListingFailure[] = []
  for (const p of payloads) {
    const row = rows.find((r) => String(r?.outpoint || '').toLowerCase() === p.outpoint.toLowerCase())
    if (!row) failures.push(failure(p.outpoint, 'secure_listing_rejected', 'listing authorize', 'No answer for this item'))
    else if (row.error) failures.push(failure(p.outpoint, String(row.code || 'secure_listing_rejected'), 'listing authorize'))
    else if (row.state && row.state !== 'listed') failures.push(failure(p.outpoint, 'listing_not_public', 'listing authorize', 'The listing did not become public'))
    else listed.push({ outpoint: p.outpoint, passthroughTxid: row.passthrough_txid })
  }
  return { listed, failures }
}

export interface ProtectedListingOutcome {
  listed: Array<{ inscriptionId?: string; outpoint: string; priceSats: number; passthroughTxid?: string }>
  failures: ProtectedListingFailure[]
}

/** Build, verify, sign and authorize protected listings (new or repriced). */
export async function executeProtectedListing(params: {
  items: Array<{ outpoint: string; priceSats: number; inscriptionId?: string }>
  address: string
  publicKey: string
  privateKey: Uint8Array
}): Promise<ProtectedListingOutcome> {
  const { built, failures } = await buildProtectedListings(params)
  const signed = signProtectedListings(built, params)
  const authorized = await authorizeProtectedListings(signed.payloads)
  const byOutpoint = new Map(params.items.map((i) => [i.outpoint.toLowerCase(), i]))
  const name = (f: ProtectedListingFailure) => ({ ...f, inscriptionId: f.inscriptionId ?? byOutpoint.get(f.outpoint.toLowerCase())?.inscriptionId })
  return {
    listed: authorized.listed.map((l) => {
      const item = byOutpoint.get(l.outpoint.toLowerCase())!
      return { inscriptionId: item.inscriptionId, outpoint: l.outpoint, priceSats: item.priceSats, passthroughTxid: l.passthroughTxid }
    }),
    failures: [...failures, ...signed.failures, ...authorized.failures].map(name),
  }
}

export interface RecoveryResult {
  txid: string
  rawtx: string
  valueSat: number
  feeSat: number
  destination: string
  /** Set when the transaction was handed to the network. */
  broadcast?: unknown
}

/**
 * Recover an escrow that confirmed without its sale: ask the API for the
 * recovery template, verify it against our escrow (pinned co-signer), sign the
 * `<144> CSV` leaf and, unless `broadcast` is false, broadcast it. The network
 * rejects it until the escrow has 144 confirmations.
 */
export async function recoverProtectedListing(params: {
  passthroughTxid: string
  feeRate: number
  address: string
  privateKey: Uint8Array
  publicKey: string
  destination?: string
  broadcast?: boolean
}): Promise<RecoveryResult> {
  if (!/^[0-9a-f]{64}$/i.test(params.passthroughTxid)) {
    throw new ProtectedTradeError('invalid_passthrough_txid', 'That is not a valid passthrough txid', 'recovery')
  }
  // Only this wallet's key can sign the recovery leaf; fail early if the key is not ours.
  toXOnly(hexToBytes(params.publicKey))
  const destination = params.destination || params.address
  const template = await withStage('recovery', () =>
    api.secureListing.recover({ passthrough_txid: params.passthroughTxid.toLowerCase(), fee_rate: params.feeRate, destination }),
  )
  let signed
  try {
    signed = signRecovery({
      psbtHex: template.psbt,
      passthroughTxid: params.passthroughTxid,
      destinationAddress: destination,
      feeRateSatVb: params.feeRate,
      privateKey: params.privateKey,
    })
  } catch (err) {
    throw toProtectedError(err, 'recovery')
  }
  const result: RecoveryResult = { ...signed, destination }
  if (params.broadcast !== false) {
    result.broadcast = await api.wallet.broadcast(signed.rawtx)
  }
  return result
}
