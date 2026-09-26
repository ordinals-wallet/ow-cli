import { buildCancelProof, hexToBytes, publicKeyToP2TR } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { CancelEscrowResponse, MarketListing, SecureListingStatus } from '@ow-cli/api'
import { ProtectedTradeError } from './protected-errors.js'

/**
 * Delist one item, standard or snipe-protected (passthrough v4).
 *
 *   look up     GET /market/escrow/:id (and /market/secure-listing/:outpoint)
 *   prove       a one-input proof PSBT spending the listed outpoint, signed
 *               SIGHASH_DEFAULT on the key path (never ANYONECANPAY), built
 *               locally: no builder round trip, nothing broadcastable
 *   cancel      POST /market/cancel-escrow
 *                 protected -> { outpoint }        (rows are keyed by outpoint)
 *                 standard  -> { inscription_id }
 *   confirm     GET both lookups again and report what they show
 *
 * Cancelling a protected listing needs nothing on chain. The seller's signed
 * passthrough and sale templates stay on the marketplace server (buyers only
 * ever see the unsigned parent), and the marketplace co-signs a sale only
 * while the listing authorization is `listed`; cancel moves it to
 * `cancelled`. To make even the stored templates unusable, spend the item
 * (send it to yourself).
 */

export type DelistKind = 'protected' | 'standard'

export interface DelistParams {
  /** Inscription to delist. Give this or `outpoint`. */
  inscriptionId?: string
  /** `txid:vout` (or 72-hex serialized) of an outpoint-keyed listing. */
  outpoint?: string
  /** Outpoint value in sats; only needed with `outpoint` when the wallet UTXO list does not show it. */
  valueSats?: number
  address: string
  /** Hex public key (33-byte compressed or 32-byte x-only). */
  publicKey: string
  privateKey: Uint8Array
}

export interface DelistVerification {
  /** `GET /market/escrow/:id` no longer returns the listing. Null when not checked (outpoint-only delist) or the check failed. */
  listingGone: boolean | null
  /** `GET /market/secure-listing/:outpoint` shows no active protected listing. Null for standard listings or when the check failed. */
  protectionRetired: boolean | null
  /** Why a check could not run, if one failed. */
  error?: string
}

export interface DelistResult {
  kind: DelistKind
  inscriptionId?: string
  /** Listing outpoint (`txid:vout`) the proof spent. */
  outpoint: string
  /** How the cancel was routed. */
  routedBy: 'outpoint' | 'inscription_id'
  /** `already_cancelled` when a protected listing was cancelled before this call. */
  transition: 'cancelled' | 'already_cancelled'
  /** Listing state the API reports after the cancel. */
  state: string
  escrowId?: string
  response: CancelEscrowResponse
  verification: DelistVerification
}

const NOT_OWNER_PROTECTED = 'This item is already listed with protection by another key; delist it from the wallet that listed it.'

/** User-facing copy for cancel refusals, keyed by server code (or our own code for code-less refusals). */
const DELIST_COPY: Record<string, string> = {
  not_listed: 'This item is not listed.',
  not_owner: 'This wallet does not own this item.',
  not_owner_protected: NOT_OWNER_PROTECTED,
  listing_not_found: 'This item is no longer listed.',
  secure_purchase_in_flight: 'This protected sale is already processing and cannot be cancelled safely.',
  listing_cancellation_not_applied: 'This listing changed and cannot be cancelled right now. Refresh and try again.',
  listing_cancellation_unavailable: 'Listing cancellation is temporarily unavailable.',
  seal_not_a_cancel_proof: 'The marketplace refused the proof: a listing seal cannot cancel a listing.',
  invalid_cancel_proof: 'The wallet signature did not match the listed item. Is this the wallet that listed it?',
  listing_identifier_required: 'Give an inscription id or an outpoint to delist.',
  outpoint_value_unknown: 'Could not find the value of this outpoint in the wallet; pass it explicitly.',
}

function delistError(code: string, detail?: string, status?: number): ProtectedTradeError {
  const text = detail || DELIST_COPY[code] || 'The listing could not be cancelled.'
  return new ProtectedTradeError(code, text, 'delist', status)
}

interface ApiErrorLike {
  status?: number
  body?: unknown
  response?: { status?: number; data?: unknown }
}

/** Map a failed `POST /market/cancel-escrow` to a typed error with user-facing copy. */
export function toDelistError(err: unknown): Error {
  if (err instanceof ProtectedTradeError) return err
  const e = err as ApiErrorLike
  const status = e?.status ?? e?.response?.status
  if (typeof status !== 'number' || status === 0) return err as Error
  const raw = e.body ?? e.response?.data
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const serverCode = typeof body.code === 'string' ? body.code : undefined
  const serverMessage = typeof body.message === 'string' ? body.message : typeof raw === 'string' ? raw : undefined

  if (serverCode === 'secure_purchase_in_flight') {
    // The API words this per case (in flight vs recovery required); show its text.
    const protection = (body.protection ?? {}) as Record<string, unknown>
    const sale = typeof protection.sale_txid === 'string' ? ` Sale ${protection.sale_txid}.` : ''
    return delistError(serverCode, `${serverMessage || DELIST_COPY[serverCode]}${sale}`, status)
  }
  if (serverCode) return delistError(serverCode, DELIST_COPY[serverCode] || serverMessage, status)
  if (status === 400 && /invalid signature/i.test(serverMessage ?? '')) return delistError('invalid_cancel_proof', undefined, status)
  if (status === 404) return delistError('listing_not_found', undefined, status)
  return delistError(`http_${status}`, serverMessage ? `Cancel failed: ${serverMessage}` : undefined, status)
}

function normalizeOutpoint(value: string): string {
  try {
    return api.outpointToTxidVout(value)
  } catch {
    throw delistError('invalid_outpoint', `Invalid outpoint: ${value}`)
  }
}

/** A listing is snipe-protected when the API marks it v2, or a protected lifecycle is active at its outpoint. */
export function isProtectedDelist(listing: Pick<MarketListing, 'protected' | 'secure_purchase_version'> | null, status: SecureListingStatus | null): boolean {
  return listing?.protected === true || listing?.secure_purchase_version === 2 || status !== null
}

interface Target {
  kind: DelistKind
  inscriptionId?: string
  /** Outpoint the proof spends. */
  outpoint: string
  valueSats: number
  routedBy: 'outpoint' | 'inscription_id'
}

async function resolveByInscription(inscriptionId: string, address: string): Promise<Target> {
  const listing = await api.market.getListing(inscriptionId)
  if (!listing) throw delistError('not_listed', `${inscriptionId} is not listed.`)
  const listingOutpoint = normalizeOutpoint(listing.outpoint)
  const status = await api.secureListing.status(listingOutpoint).catch(() => null)
  const isProtected = isProtectedDelist(listing, status)
  const seller = listing.seller_address || listing.outpoint_address
  if (seller && seller !== address) {
    throw delistError(isProtected ? 'not_owner_protected' : 'not_owner')
  }

  if (isProtected) {
    // Protected rows are keyed by the outpoint the seller listed from; the API
    // checks the proof against that output's script, proof input 0.
    let valueSats = Number(listing.outpoint_sats)
    if (!Number.isSafeInteger(valueSats) || valueSats <= 0) {
      const live = await api.wallet.getInscriptionOutpoint(inscriptionId)
      const liveOutpoint = live?.inscription?.outpoint ? normalizeOutpoint(live.inscription.outpoint) : null
      valueSats = liveOutpoint === listingOutpoint ? Number(live.inscription.sats ?? live.sats) : NaN
    }
    if (!Number.isSafeInteger(valueSats) || valueSats <= 0) throw delistError('outpoint_value_unknown')
    return { kind: 'protected', inscriptionId, outpoint: listingOutpoint, valueSats, routedBy: 'outpoint' }
  }

  // Standard: the API checks the proof (last input) against the inscription's
  // CURRENT outpoint, so prove from the live location.
  const live = await api.wallet.getInscriptionOutpoint(inscriptionId)
  const outpoint = live?.inscription?.outpoint ? normalizeOutpoint(live.inscription.outpoint) : null
  const valueSats = Number(live?.inscription?.sats ?? live?.sats)
  if (!outpoint || !Number.isSafeInteger(valueSats) || valueSats <= 0) {
    throw delistError('listing_malformed', `Could not find where ${inscriptionId} sits; try again.`)
  }
  const owner = live.owner || live.inscription.address
  if (owner && owner !== address) throw delistError('not_owner')
  return { kind: 'standard', inscriptionId, outpoint, valueSats, routedBy: 'inscription_id' }
}

async function resolveByOutpoint(rawOutpoint: string, address: string, valueSats?: number): Promise<Target> {
  const outpoint = normalizeOutpoint(rawOutpoint)
  const status = await api.secureListing.status(outpoint)
  let value = Number(valueSats)
  if (!Number.isSafeInteger(value) || value <= 0) {
    const [txid, vout] = outpoint.split(':')
    const utxos = await api.wallet.getUtxos(address).catch(() => [])
    const hit = (Array.isArray(utxos) ? utxos : []).find((u) => u.txid === txid && Number(u.vout) === Number(vout))
    value = Number(hit?.value)
  }
  if (!Number.isSafeInteger(value) || value <= 0) throw delistError('outpoint_value_unknown')
  return { kind: status ? 'protected' : 'standard', outpoint, valueSats: value, routedBy: 'outpoint' }
}

async function verifyCancelled(target: Target): Promise<DelistVerification> {
  const verification: DelistVerification = { listingGone: null, protectionRetired: null }
  const errors: string[] = []
  if (target.inscriptionId) {
    try {
      verification.listingGone = (await api.market.getListing(target.inscriptionId)) === null
    } catch (err) {
      errors.push(`listing lookup: ${(err as Error).message}`)
    }
  }
  if (target.kind === 'protected') {
    try {
      verification.protectionRetired = (await api.secureListing.status(target.outpoint)) === null
    } catch (err) {
      errors.push(`protection lookup: ${(err as Error).message}`)
    }
  }
  if (errors.length) verification.error = errors.join('; ')
  return verification
}

/**
 * Cancel a listing, standard or protected, and read back the result. Throws
 * `ProtectedTradeError` (stage `delist`) with user-facing copy on refusal.
 */
export async function delistListing(params: DelistParams): Promise<DelistResult> {
  if (Boolean(params.inscriptionId) === Boolean(params.outpoint)) {
    throw delistError('listing_identifier_required')
  }
  const publicKey = hexToBytes(params.publicKey)
  if (publicKeyToP2TR(publicKey).address !== params.address) {
    throw delistError('key_mismatch', 'The public key does not match the wallet address.')
  }

  const target = params.inscriptionId
    ? await resolveByInscription(params.inscriptionId, params.address)
    : await resolveByOutpoint(params.outpoint!, params.address, params.valueSats)

  const signature = buildCancelProof({
    outpoint: target.outpoint,
    valueSats: target.valueSats,
    privateKey: params.privateKey,
    publicKey,
  })

  let response: CancelEscrowResponse
  try {
    response = target.routedBy === 'outpoint'
      ? await api.market.cancelEscrow({ outpoint: target.outpoint, signature })
      : await api.market.cancelEscrow({ inscription_id: target.inscriptionId!, signature })
  } catch (err) {
    throw toDelistError(err)
  }
  if (!response || response.success !== true) {
    throw delistError('listing_cancellation_not_applied')
  }

  // The API is authoritative on what it cancelled: `secure_v2` rows come back
  // with a transition; a legacy row answers `{ success: true }`.
  const kind: DelistKind = response.listing?.secure_v2 ? 'protected' : 'standard'
  const verification = await verifyCancelled({ ...target, kind })
  return {
    kind,
    inscriptionId: target.inscriptionId,
    outpoint: target.outpoint,
    routedBy: target.routedBy,
    transition: response.transition ?? 'cancelled',
    state: response.listing?.state ?? 'cancelled',
    escrowId: response.listing?.escrow_id,
    response,
    verification,
  }
}
