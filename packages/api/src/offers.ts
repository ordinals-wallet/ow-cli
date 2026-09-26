/**
 * Offers v1: funded bids on an item, a collection or a trait.
 * All routes are under `/market/offers`. See the Offers API docs.
 *
 * Every PSBT this module returns is built by the server. Verify it with the
 * `@ow-cli/core` offer helpers (`signOfferFunding`, `signOfferPresign`,
 * `verifyAcceptPsbt`, …) before signing.
 */
import { getClient } from './client.js'
import { OwApiError, toOwApiError } from './errors.js'
import type {
  AcceptOfferRequest,
  ActivateOfferRequest,
  ActivateOfferResponse,
  BuildAcceptRequest,
  BuildAcceptResponse,
  BuildCancelRequest,
  BuildCancelResponse,
  BuildFillRequest,
  BuildFillResponse,
  BuildOfferRequest,
  BuildOfferResponse,
  CancelOfferRequest,
  CollectionOffersResponse,
  FillOfferRequest,
  InscriptionOffersResponse,
  PrepareOfferResponse,
  ReconcileOfferResponse,
  RejectOfferRequest,
  RejectOfferResponse,
  SettleOfferResponse,
  WalletOffersResponse,
} from './types-offers.js'

// ─── Errors ─────────────────────────────────────────────────────────

/**
 * An offers route failed with an API error code, e.g. `offer_expired`.
 * Extends `OwApiError`, so `status`, `body` and `response` are available and
 * `isOwApiError(err)` is true. Transport failures (no response, no code) are
 * thrown as plain `OwApiError`.
 */
export class OfferError extends OwApiError {
  declare readonly code: string

  constructor(code: string, status = 0, message?: string, from?: OwApiError) {
    super({
      status,
      code,
      message: message ?? from?.message ?? `Offer request failed: ${code}`,
      body: from?.body,
      method: from?.method,
      url: from?.url,
      retries: from?.retries,
      response: from?.response,
      config: from?.config,
      cause: from,
    })
    Object.defineProperty(this, 'name', { value: new.target.name, configurable: true })
  }
}

/** `offer_expired`: past `expires_at`. */
export class OfferExpiredError extends OfferError {
  constructor(code = 'offer_expired', status?: number, from?: OwApiError) {
    super(code, status, 'Offer has expired', from)
  }
}

/** `offer_not_active` (and `offer_not_building` / `offer_not_cancellable`): wrong state. */
export class OfferNotActiveError extends OfferError {
  constructor(code = 'offer_not_active', status?: number, from?: OwApiError) {
    super(code, status, 'Offer is not in a state that allows this action', from)
  }
}

/** `item_moved` / `stale` / `item_changed`: the item moved since the offer was made. */
export class OfferItemMovedError extends OfferError {
  constructor(code = 'item_moved', status?: number, from?: OwApiError) {
    super(code, status, 'The item moved since the offer was made', from)
  }
}

/** `not_the_owner` / `not_the_buyer`: the address is not a party to this action. */
export class OfferNotOwnerError extends OfferError {
  constructor(code = 'not_the_owner', status?: number, from?: OwApiError) {
    super(code, status, code === 'not_the_buyer' ? 'You are not the buyer of this offer' : "You don't own the item", from)
  }
}

/** `item_not_eligible`: the item doesn't match the collection or trait. */
export class OfferItemNotEligibleError extends OfferError {
  constructor(code = 'item_not_eligible', status?: number, from?: OwApiError) {
    super(code, status, "The item doesn't match the offer's collection or trait", from)
  }
}

/** `offer_attempt_pending`: a broadcast is in flight; call `reconcile`. */
export class OfferAttemptPendingError extends OfferError {
  constructor(code = 'offer_attempt_pending', status?: number, from?: OwApiError) {
    super(code, status, 'A broadcast for this offer is already in flight; call reconcile', from)
  }
}

/** `unauthorized`: missing, expired or wrong-address session token. */
export class OfferUnauthorizedError extends OfferError {
  constructor(code = 'unauthorized', status?: number, from?: OwApiError) {
    super(code, status, 'Session token missing, expired or for a different address; sign in again', from)
  }
}

type OfferErrorCtor = new (code: string, status?: number, from?: OwApiError) => OfferError

const ERROR_CLASSES: Record<string, OfferErrorCtor> = {
  offer_expired: OfferExpiredError,
  offer_not_active: OfferNotActiveError,
  offer_not_building: OfferNotActiveError,
  offer_not_cancellable: OfferNotActiveError,
  item_moved: OfferItemMovedError,
  stale: OfferItemMovedError,
  item_changed: OfferItemMovedError,
  not_the_owner: OfferNotOwnerError,
  not_the_buyer: OfferNotOwnerError,
  item_not_eligible: OfferItemNotEligibleError,
  offer_attempt_pending: OfferAttemptPendingError,
  unauthorized: OfferUnauthorizedError,
}

/** Map an API error code to its typed error. */
export function offerErrorFromCode(code: string, status?: number, from?: OwApiError): OfferError {
  const Ctor = ERROR_CLASSES[code]
  return Ctor ? new Ctor(code, status, from) : new OfferError(code, status, undefined, from)
}

function toOfferError(err: unknown): unknown {
  const api = toOwApiError(err)
  const body = api.body as { code?: unknown } | undefined
  if (api.status > 0 && body && typeof body.code === 'string') {
    return offerErrorFromCode(body.code, api.status, api)
  }
  return api
}

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  try {
    const { data } = await getClient().get(path, { params })
    return data
  } catch (err) {
    throw toOfferError(err)
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  try {
    const { data } = await getClient().post(path, body)
    return data
  } catch (err) {
    throw toOfferError(err)
  }
}

const BASE = '/market/offers'
const seg = encodeURIComponent

// ─── Reads ──────────────────────────────────────────────────────────

/** Item offers on an inscription, plus collection/trait offers it could fill. */
export function forInscription(inscriptionId: string): Promise<InscriptionOffersResponse> {
  return get(`${BASE}/inscription/${seg(inscriptionId)}`)
}

/** Up to 200 of each kind for a collection, best price first, plus a summary. */
export function forCollection(slug: string): Promise<CollectionOffersResponse> {
  return get(`${BASE}/collection/${seg(slug)}`)
}

/** Offers `received` and `sent` by a wallet over the last 90 days. */
export function forWallet(address: string): Promise<WalletOffersResponse> {
  return get(`${BASE}/wallet/${seg(address)}`)
}

// ─── Place ──────────────────────────────────────────────────────────

/** Step 1: build the funding PSBT and escrow for a new offer. */
export function build(params: BuildOfferRequest): Promise<BuildOfferResponse> {
  return post(`${BASE}/build`, params)
}

/** Step 2: exchange the signed funding PSBT for the acceptance template to pre-sign. */
export function prepare(offerId: string, signedFundingPsbt: string): Promise<PrepareOfferResponse> {
  return post(`${BASE}/${seg(offerId)}/prepare`, { funding_psbt: signedFundingPsbt })
}

/** Step 3: submit both signed PSBTs; the funding is broadcast and the offer goes live. */
export function activate(offerId: string, params: ActivateOfferRequest): Promise<ActivateOfferResponse> {
  return post(`${BASE}/${seg(offerId)}/activate`, params)
}

// ─── Accept (item) / fill (collection, trait) ───────────────────────

export function buildAccept(offerId: string, params: BuildAcceptRequest): Promise<BuildAcceptResponse> {
  return post(`${BASE}/${seg(offerId)}/build-accept`, params)
}

export function accept(offerId: string, params: AcceptOfferRequest): Promise<SettleOfferResponse> {
  return post(`${BASE}/${seg(offerId)}/accept`, params)
}

export function buildFill(offerId: string, params: BuildFillRequest): Promise<BuildFillResponse> {
  return post(`${BASE}/${seg(offerId)}/build-fill`, params)
}

export function fill(offerId: string, params: FillOfferRequest): Promise<SettleOfferResponse> {
  return post(`${BASE}/${seg(offerId)}/fill`, params)
}

// ─── Reject / cancel ────────────────────────────────────────────────

/** Seller declines, off-chain. `token` is a wallet session token for `address`. */
export function reject(offerId: string, params: RejectOfferRequest): Promise<RejectOfferResponse> {
  return post(`${BASE}/${seg(offerId)}/reject`, { address: params.address, signature: params.token })
}

export function buildCancel(offerId: string, params: BuildCancelRequest): Promise<BuildCancelResponse> {
  return post(`${BASE}/${seg(offerId)}/build-cancel`, params)
}

export function cancel(offerId: string, params: CancelOfferRequest): Promise<SettleOfferResponse> {
  return post(`${BASE}/${seg(offerId)}/cancel`, params)
}

/**
 * Re-check in-flight broadcasts for an offer. Pass `txid` to record a refund
 * the buyer broadcast alone via the timelock leaf.
 */
export function reconcile(offerId: string, txid?: string): Promise<ReconcileOfferResponse> {
  return get(`${BASE}/${seg(offerId)}/reconcile`, txid ? { txid } : undefined)
}
