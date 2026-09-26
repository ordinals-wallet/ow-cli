import {
  signPurchaseFlow,
  signOwnInputs,
  verifyPassthroughPurchase,
  assertQuoteFresh,
  PASSTHROUGH_POLICY,
  PINNED_COSIGNER_XONLY_HEX,
  MAX_PROTECTED_ITEMS_PER_PURCHASE,
} from '@ow-cli/core'
import { ProtectedTradeError, protectedErrorMessage, toProtectedError } from './protected-errors.js'
import type { ProtectedTradeStage } from './protected-errors.js'
import type { SaleChainLink, SaleChainVerification } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { MarketListing, BuildSecurePurchaseResponse, SubmitSecurePurchaseResponse } from '@ow-cli/api'

/**
 * Inscription purchases. Listings come in two kinds and each has its own
 * build and submit endpoints:
 *
 *   legacy escrow   /wallet/purchase-bulk          -> /market/purchase
 *   passthrough v4  /wallet/secure-purchase/build  -> /market/secure-purchase/submit
 *
 * The legacy build cannot see protected listings (it answers "no longer
 * listed"), so every purchase starts by looking the listings up and routing
 * each one by kind.
 */

export type ListingKind = 'legacy' | 'protected'

const SECURE_LISTING_MARKER_VERSION = 2
const SECURE_LISTING_MARKER_STATE = 'listed'

/** Same test the wallet frontend uses to pick the purchase path. */
export function isProtectedListing(listing: unknown): boolean {
  if (!listing || typeof listing !== 'object') return false
  const row = listing as Record<string, unknown>
  if (row.protected === true) return true
  const state = row.secure_purchase_state ?? row.state
  return Number(row.secure_purchase_version) === SECURE_LISTING_MARKER_VERSION && state === SECURE_LISTING_MARKER_STATE
}

/** `txid:vout`, from either that form or the 36-byte wire form (little-endian txid + vout) in hex. */
export function canonicalOutpoint(value: string): string | null {
  const v = String(value || '').trim().toLowerCase()
  if (/^[0-9a-f]{64}:\d+$/.test(v)) return v
  if (/^[0-9a-f]{72}$/.test(v)) {
    const txid = v.slice(0, 64).match(/../g)!.reverse().join('')
    const vout = parseInt(v.slice(64).match(/../g)!.reverse().join(''), 16)
    return `${txid}:${vout}`
  }
  return null
}

export interface PlannedItem {
  inscriptionId: string
  kind: ListingKind
  /** What the buyer pays for the item, marketplace fee included. */
  priceSat: number
  /** What the seller listed it for (`escrow_price`); the sale must pay them exactly this. */
  escrowPriceSat: number | null
  sellerAddress: string
  creatorAddress: string | null
  /** `txid:vout` of the listed UTXO. */
  outpoint: string
}

export interface PurchasePlan {
  items: PlannedItem[]
  legacy: PlannedItem[]
  protectedItems: PlannedItem[]
  listedTotalSat: number
}

function planItem(inscriptionId: string, listing: MarketListing | null): PlannedItem {
  if (!listing || listing.buyer_address || !(Number(listing.satoshi_price) > 0)) {
    throw new ProtectedTradeError('listing_not_found', `${inscriptionId} is not listed for sale`)
  }
  const outpoint = canonicalOutpoint(listing.outpoint)
  if (!outpoint || !listing.seller_address) {
    throw new ProtectedTradeError('listing_malformed', `Could not read the listing for ${inscriptionId}; try again`)
  }
  return {
    inscriptionId,
    kind: isProtectedListing(listing) ? 'protected' : 'legacy',
    priceSat: Number(listing.satoshi_price),
    escrowPriceSat: Number(listing.escrow_price) > 0 ? Number(listing.escrow_price) : null,
    sellerAddress: listing.seller_address,
    creatorAddress: listing.creator_address || null,
    outpoint,
  }
}

/** Look every listing up and sort the purchase into its two kinds. Needs no keys. */
export async function planPurchase(ids: string[], buyerAddress?: string): Promise<PurchasePlan> {
  const unique = Array.from(new Set(ids))
  if (unique.length !== ids.length) {
    throw new ProtectedTradeError('duplicate_items', 'The same inscription appears more than once')
  }
  const listings = await Promise.all(unique.map((id) => api.market.getListing(id)))
  const items = unique.map((id, i) => planItem(id, listings[i]))
  const own = items.find((item) => buyerAddress && item.sellerAddress === buyerAddress)
  if (own) {
    throw new ProtectedTradeError('own_listing', `${own.inscriptionId} is your own listing; use "ow market delist" instead`)
  }
  const protectedItems = items.filter((item) => item.kind === 'protected')
  if (protectedItems.length > MAX_PROTECTED_ITEMS_PER_PURCHASE) {
    throw new ProtectedTradeError(
      'too_many_items',
      `Up to ${MAX_PROTECTED_ITEMS_PER_PURCHASE} protected items can be bought together; this purchase has ${protectedItems.length}`,
    )
  }
  return {
    items,
    legacy: items.filter((item) => item.kind === 'legacy'),
    protectedItems,
    listedTotalSat: items.reduce((a, item) => a + item.priceSat, 0),
  }
}

/** Buyer-facing text for the codes the build and submit endpoints return. */
export function securePurchaseFailureMessage(code: string): string {
  return protectedErrorMessage(code, 'purchase build')
}

/** Turn an HTTP failure from a passthrough endpoint into a typed error with readable text. */
function apiFailure(err: unknown, stage: ProtectedTradeStage): never {
  throw toProtectedError(err, stage)
}

/** Refuse to go further unless the API speaks passthrough v4 with the co-signer pinned in this build. */
export async function requirePassthroughSupport(): Promise<void> {
  let caps
  try {
    caps = await api.market.getSecurePurchaseCapabilities()
  } catch (err) {
    apiFailure(err, 'purchase capability check')
  }
  const policy = caps.escrow_policy || caps.policy || caps.mode
  if (policy !== PASSTHROUGH_POLICY) {
    throw new ProtectedTradeError(
      'policy_unsupported',
      `The marketplace reports protection policy "${policy ?? 'none'}"; this CLI only speaks ${PASSTHROUGH_POLICY}. Update ow-cli.`,
    )
  }
  if (caps.build_enabled === false || caps.submit_enabled === false || caps.customer_enabled === false) {
    throw new ProtectedTradeError('secure_purchase_disabled', 'Protected purchases are temporarily unavailable.')
  }
  const status = caps.protocol_status?.ordinal
  if (status && status !== 'enabled') {
    throw new ProtectedTradeError('secure_purchase_disabled', `Protected inscription purchases are unavailable (${status}).`)
  }
  if (String(caps.cosigner_public_key || '').toLowerCase() !== PINNED_COSIGNER_XONLY_HEX) {
    throw new ProtectedTradeError(
      'cosigner_key_unpinned',
      'The marketplace co-signer key does not match the key built into this CLI; refusing to buy. Update ow-cli, and do not proceed if it is already current.',
    )
  }
}

export interface PassthroughQuote {
  items: PlannedItem[]
  feeRate: number
  buyerAddress: string
  links: SaleChainLink[]
  setup?: { txid: string; psbt: string }
  /** Amounts re-derived from the transactions themselves, not the API's own figures. */
  verified: SaleChainVerification
  /** The build's `expires_at`. Nothing is signed or submitted at or past it. */
  expiresAt: string
  /** The build's own total (`economics.buyer_total_sats`). */
  quotedTotalSat: number
  /** The most this purchase may spend: the quoted total plus the caller's tolerance. */
  maxTotalSat: number
}

const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)

function quoteFromBuild(
  built: BuildSecurePurchaseResponse,
  items: PlannedItem[],
  buyerAddress: string,
  feeRate: number,
  toleranceSat: number,
): PassthroughQuote {
  const invalid = (message: string): never => {
    throw new ProtectedTradeError('invalid_sale', `${message}; refusing to sign`, 'purchase build')
  }
  if (!built || built.policy !== PASSTHROUGH_POLICY || !Array.isArray(built.sales)) {
    invalid('The build did not return a passthrough v4 sale')
  }
  if (built.cosigner_public_key && built.cosigner_public_key.toLowerCase() !== PINNED_COSIGNER_XONLY_HEX) {
    throw new ProtectedTradeError('cosigner_key_unpinned', 'The build names a co-signer other than the one built into this CLI; refusing to sign')
  }
  if (built.sales.length !== items.length) invalid('The build returned the wrong number of sales')
  if (built.recipient_address && built.recipient_address !== buyerAddress) {
    invalid('The build would deliver to an address other than this wallet')
  }
  const links = built.sales.map((row, i): SaleChainLink => {
    const parent = row?.parent
    if (!isHex64(row?.sale_txid) || typeof row?.psbt !== 'string' || !isHex64(parent?.txid) || typeof parent?.raw !== 'string') {
      invalid('The build returned a malformed sale')
    }
    return {
      saleTxid: row.sale_txid.toLowerCase(),
      salePsbtHex: row.psbt,
      parent: { txid: parent.txid.toLowerCase(), raw: parent.raw, source_outpoint: parent.source_outpoint },
      listing: {
        outpoint: items[i].outpoint,
        sellerAddress: items[i].sellerAddress,
        creatorAddress: items[i].creatorAddress,
        satoshiPrice: items[i].priceSat,
        escrowPriceSat: items[i].escrowPriceSat,
      },
    }
  })
  let setup: PassthroughQuote['setup']
  if (built.setup) {
    if (!isHex64(built.setup.txid) || typeof built.setup.psbt !== 'string') invalid('The build returned a malformed setup transaction')
    setup = { txid: built.setup.txid.toLowerCase(), psbt: built.setup.psbt }
  }
  if (typeof built.expires_at !== 'string' || !Number.isFinite(Date.parse(built.expires_at))) {
    invalid('The build did not say when its quote expires')
  }
  const quotedTotalSat = Number(built.economics?.buyer_total_sats)
  if (!Number.isSafeInteger(quotedTotalSat) || quotedTotalSat <= 0) {
    invalid('The build did not state what the purchase costs')
  }
  const maxTotalSat = quotedTotalSat + toleranceSat
  const expiresAt = built.expires_at as string
  const verified = verifyChecked(() =>
    verifyPassthroughPurchase({ links, setup, buyerAddress, feeRateSatVb: feeRate, expiresAt, maxTotalSat }),
  'purchase build')
  return { items, feeRate, buyerAddress, links, setup, verified, expiresAt, quotedTotalSat, maxTotalSat }
}

interface ApiErrorLike {
  response?: { status?: number; data?: { code?: string; message?: string } | string }
}

function verifyChecked<T>(run: () => T, stage: ProtectedTradeStage): T {
  try {
    return run()
  } catch (err) {
    throw toProtectedError(err, stage)
  }
}

function checkTolerance(value: number | undefined): number {
  const tolerance = value ?? 0
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new ProtectedTradeError('invalid_budget', 'Spend tolerance must be a whole number of sats, 0 or more')
  }
  return tolerance
}

/**
 * Build a protected purchase and verify every transaction in it. Needs no
 * keys, so callers can show the verified amounts before unlocking the wallet.
 */
export async function buildPassthroughPurchase(params: {
  items: PlannedItem[]
  feeRate: number
  address: string
  publicKey: string
  /**
   * Sats the verified total may exceed the build's `economics.buyer_total_sats`
   * by. Default 0: any sale costing more than it was quoted at is refused.
   */
  budgetToleranceSat?: number
}): Promise<PassthroughQuote> {
  const tolerance = checkTolerance(params.budgetToleranceSat)
  if (params.items.length === 0) throw new ProtectedTradeError('no_outpoints', 'Select at least one item')
  await requirePassthroughSupport()
  let built: BuildSecurePurchaseResponse
  try {
    built = await api.market.buildSecurePurchase({
      outpoints: params.items.map((item) => item.outpoint),
      protocol: 'ordinal',
      from: params.address,
      public_key: params.publicKey,
      fee_rate: params.feeRate,
      wallet_type: 'ow-cli',
    })
  } catch (err) {
    apiFailure(err, 'purchase build')
  }
  return quoteFromBuild(built, params.items, params.address, params.feeRate, tolerance)
}

export interface SignedPassthroughPurchase {
  /** Carried from the quote: submit refuses at or past it. */
  expiresAt: string
  sales: Array<{ sale_txid: string; psbt: string; setup_psbt?: string }>
}

/**
 * Sign a verified quote: the setup (if any) and, in every sale, only the
 * inputs verification identified as ours. The quote is verified again first,
 * so nothing mutated between build and sign gets a signature. Sends nothing.
 */
export function signPassthroughPurchase(
  quote: PassthroughQuote,
  keys: { privateKey: Uint8Array; publicKeyBytes: Uint8Array },
): SignedPassthroughPurchase {
  const verified = verifyChecked(() => verifyPassthroughPurchase({
    links: quote.links,
    setup: quote.setup,
    buyerAddress: quote.buyerAddress,
    feeRateSatVb: quote.feeRate,
    expiresAt: quote.expiresAt,
    maxTotalSat: quote.maxTotalSat,
  }), 'purchase sign')
  const sign = (psbt: string, indexes: number[]) =>
    signOwnInputs({ psbt, indexes, privateKey: keys.privateKey, publicKey: keys.publicKeyBytes })
  const signedSetup = quote.setup && verified.setup ? sign(quote.setup.psbt, verified.setup.buyerInputs) : undefined
  return {
    expiresAt: quote.expiresAt,
    sales: quote.links.map((link, i) => ({
      sale_txid: link.saleTxid,
      psbt: sign(link.salePsbtHex, verified.links[i].buyerInputs),
      ...(i === 0 && signedSetup ? { setup_psbt: signedSetup } : {}),
    })),
  }
}

/** Hand the signed sales to the marketplace, which co-signs the escrow inputs and broadcasts. */
export async function submitPassthroughPurchase(signed: SignedPassthroughPurchase): Promise<SubmitSecurePurchaseResponse> {
  verifyChecked(() => assertQuoteFresh(signed.expiresAt), 'purchase submit')
  let result: SubmitSecurePurchaseResponse
  try {
    result = await api.market.submitSecurePurchase({ sales: signed.sales })
  } catch (err) {
    apiFailure(err, 'purchase submit')
  }
  if (!result?.accepted) {
    throw new ProtectedTradeError('submit_rejected', 'The marketplace did not accept the protected purchase')
  }
  return result
}

export interface PurchaseParams {
  ids: string[]
  feeRate: number
  address: string
  publicKey: string
  privateKey: Uint8Array
  publicKeyBytes: Uint8Array
  /** From `planPurchase`, when the caller already has one. */
  plan?: PurchasePlan
  /** From `buildPassthroughPurchase`, when the caller already showed it to the user. */
  quote?: PassthroughQuote
  /** See `buildPassthroughPurchase`. Default 0. */
  budgetToleranceSat?: number
}

export interface PurchaseOutcome {
  /** Set when legacy listings were bought. */
  legacy?: { ids: string[]; result: unknown }
  /** Set when protected listings were bought. */
  protected?: { ids: string[]; txid: string; result: SubmitSecurePurchaseResponse; partial: boolean }
}

async function purchaseLegacy(items: PlannedItem[], params: PurchaseParams): Promise<unknown> {
  const { setup, purchase } = await api.market.buildPurchaseBulk({
    inscriptions: items.map((item) => item.inscriptionId),
    pay_address: params.address,
    receive_address: params.address,
    public_key: params.publicKey,
    fee_rate: params.feeRate,
    wallet_type: 'ow-cli',
  })
  const { signedSetup, signedPurchase } = signPurchaseFlow(params.privateKey, params.publicKeyBytes, setup, purchase)
  return api.market.submitPurchase({
    setup_rawtx: signedSetup,
    purchase_rawtx: signedPurchase,
    wallet_type: 'ow-cli',
  })
}

/**
 * Buy one or more inscriptions, of either kind or both.
 *
 * The two kinds cannot share a transaction, and both spend the same wallet,
 * so they run one after the other: the protected purchase first (its verified
 * quote may already have been shown to the user), then the legacy one, built
 * only once the first has been submitted. If the second fails, the error says
 * what was already bought.
 */
export async function executePurchase(params: PurchaseParams): Promise<{ result: PurchaseOutcome }> {
  const plan = params.plan ?? (await planPurchase(params.ids, params.address))
  const outcome: PurchaseOutcome = {}

  if (plan.protectedItems.length > 0) {
    const quote =
      params.quote ??
      (await buildPassthroughPurchase({
        items: plan.protectedItems,
        feeRate: params.feeRate,
        address: params.address,
        publicKey: params.publicKey,
        budgetToleranceSat: params.budgetToleranceSat,
      }))
    const signed = signPassthroughPurchase(quote, params)
    const result = await submitPassthroughPurchase(signed)
    outcome.protected = {
      ids: plan.protectedItems.map((item) => item.inscriptionId),
      txid: result.txid || quote.links[0].saleTxid,
      result,
      partial: result.stopped_at !== undefined,
    }
  }

  if (plan.legacy.length > 0) {
    try {
      outcome.legacy = {
        ids: plan.legacy.map((item) => item.inscriptionId),
        result: await purchaseLegacy(plan.legacy, params),
      }
    } catch (err) {
      if (!outcome.protected) throw err
      const data = (err as ApiErrorLike)?.response?.data
      const detail = typeof data === 'string' ? data : data?.message || (err as Error).message
      throw new ProtectedTradeError(
        'partial_purchase',
        `The protected purchase went through (txid ${outcome.protected.txid}), but the ${plan.legacy.length} standard listing(s) failed: ${detail}. ` +
          'Nothing was spent on them; retry those ids once the first purchase shows in your wallet.',
      )
    }
  }

  return { result: outcome }
}
