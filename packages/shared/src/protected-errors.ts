import { PassthroughError, MAX_PROTECTED_ITEMS_PER_PURCHASE } from '@ow-cli/core'

/**
 * Typed errors for snipe-protected (passthrough v4) trading. Every failure
 * the listing and purchase endpoints return, and every local verification
 * refusal, surfaces as a `ProtectedTradeError` with a stable `code`, the
 * stage it happened in, and the same user-facing copy the wallet frontend
 * shows. `ProtectedTradeError` extends `PassthroughError`, so existing
 * `instanceof PassthroughError` checks keep working.
 */

export type ProtectedTradeStage =
  | 'purchase capability check'
  | 'purchase build'
  | 'purchase sign'
  | 'purchase submit'
  | 'listing capability check'
  | 'listing build'
  | 'listing sign'
  | 'listing authorize'
  | 'recovery'
  | 'delist'

/** Codes callers are expected to branch on. Any other server or verification code may also appear. */
export type ProtectedErrorCode =
  | 'already_listed'
  | 'postage_too_small'
  | 'template_digest_mismatch'
  | 'signed_template_mutated'
  | 'listing_changed'
  | 'escrow_mismatch'
  | 'too_many_items'
  | 'too_many_pending_purchases'
  | 'two_funding_utxos_required'
  | 'insufficient_funds'
  | 'listing_source_spent'
  | 'listing_not_found'
  | 'quote_expired'
  | 'over_budget'
  | 'cosigner_key_unpinned'
  | 'secure_purchase_disabled'
  | 'secure_listing_unavailable'

/** Codes that clear on their own (a new block, the index catching up, a restart): retry shortly. */
const RETRYABLE = new Set([
  'build_tip_changed',
  'build_tip',
  'authorize_tip',
  'authorize_tip_changed',
  'asset_index_tip_changed',
  'asset_index_tip_mismatch',
  'asset_index_incomplete',
  'asset_index_unavailable',
  'asset_index_stale',
  'ord_index_stale',
  'chain_tip_unavailable',
  'secure_listing_unavailable',
  'outpoint_not_fully_indexed',
  'too_many_pending_purchases',
])

export class ProtectedTradeError extends PassthroughError {
  /** True when the same request may succeed if simply retried in a moment. */
  readonly retryable: boolean

  constructor(
    code: ProtectedErrorCode | (string & {}),
    message: string,
    readonly stage?: ProtectedTradeStage,
    /** HTTP status, when the error came from the API. */
    readonly status?: number,
  ) {
    super(code, message)
    this.name = 'ProtectedTradeError'
    this.retryable = RETRYABLE.has(code) || (status !== undefined && status >= 500)
  }
}

const LISTING_COPY: Record<string, string> = {
  already_listed: 'Already listed from another wallet. Delist it there first.',
  postage_too_small: 'This item needs at least 330 sats of postage for protection. Send it to yourself with more sats, then list it.',
  template_digest_mismatch: 'The listing changed while signing. Try again.',
  signed_template_mutated: 'The listing changed while signing. Try again.',
  sale_template_mutated: 'The listing changed while signing. Try again.',
  secure_listing_requires_fresh_outpoint: 'This item was listed unprotected before. Send it to yourself, then list it with protection.',
  outpoint_spent_in_mempool: 'This item just moved. Refresh and try again.',
  asset_not_current: 'This item just moved. Refresh and try again.',
  unconfirmed_asset_outpoint: 'This item has not confirmed yet. Try again after the next block.',
  seller_key_does_not_control_asset: 'This wallet does not own this item.',
  no_supported_assets_on_output: 'Nothing listable on this UTXO.',
  ambiguous_inscription_assets: 'This item shares a UTXO with other inscriptions. Send it to yourself to split them, or list it without protection.',
  protocol_mismatch: 'Snipe protection cannot cover this item type yet. List it with --unprotected.',
  unverified_fungible_inscription: 'This looks like a token transfer we cannot verify. List it with --unprotected.',
  outpoint_not_fully_indexed: 'This item confirmed in the latest block. Protection can list it after the next block; you can list it with --unprotected now.',
  ord_index_stale: 'Our index is catching up. Try again in a minute.',
  asset_index_tip_mismatch: 'Our index is catching up. Try again in a minute.',
  asset_index_fork_mismatch: 'Our index is catching up. Try again in a minute.',
  price_below_dust: 'Price is too low to send on Bitcoin.',
  inscription_offset_too_deep: 'This inscription sits too deep in its UTXO for protection.',
  unsupported_seller_script: 'Protection needs the item in a Taproot or native SegWit address.',
  duplicate_outpoint: 'The same item was selected twice.',
  asset_index_tip_changed: 'A new block arrived while publishing. Try again.',
  authorize_tip: 'A new block arrived while publishing. Try again.',
  authorize_tip_changed: 'A new block arrived while publishing. Try again.',
  build_tip: 'A new block arrived while publishing. Try again.',
  build_tip_changed: 'A new block arrived while publishing. Try again.',
  authorization_conflict: 'The listing could not be saved. Refresh and try again; if it repeats, send us the item id.',
  invalid_seller_authorization: 'The wallet signature did not match. Try again.',
  invalid_seller_sighash: 'The wallet signature did not match. Try again.',
  passthrough_signature_invalid: 'The wallet signature did not match. Try again.',
  sale_presignature_invalid: 'The wallet signature did not match. Try again.',
  sale_signed_on_key_path: 'The wallet signature did not match. Try again.',
  cosigner_unavailable: 'Snipe protection is unavailable right now.',
  secure_listing_unavailable: 'Snipe protection is unavailable right now.',
  escrow_unconfirmed: 'The passthrough has not confirmed; there is nothing to recover yet.',
  escrow_spent: 'This escrow was already spent (sold or recovered).',
  recovery_below_dust: 'The escrow is too small to recover at this fee rate; try a lower fee rate.',
  invalid_passthrough_txid: 'That is not a valid passthrough txid.',
}

const PURCHASE_COPY: Record<string, string> = {
  two_funding_utxos_required: 'A protected purchase needs at least two spendable UTXOs in your wallet. Split your balance first ("ow wallet split"), then try again.',
  insufficient_funds: 'Not enough spendable balance: your UTXOs must cover the item prices plus fees, with at least one UTXO on each side of the sale.',
  listing_not_found: 'One of the items is no longer available.',
  listing_source_spent: 'This item was just sold or its listing was moved, so it is no longer available.',
  listing_changed: 'One of the items is no longer available.',
  escrow_mismatch: 'This listing changed. Refresh and try again.',
  passthrough_missing: 'This listing changed. Refresh and try again.',
  passthrough_mismatch: 'This listing changed. Refresh and try again.',
  passthrough_invalid: 'This listing changed. Refresh and try again.',
  listings_conflict: 'Two of these listings cannot be bought together; buy them separately.',
  seller_presignature_invalid: "The seller's listing signature is invalid; the item cannot be bought right now.",
  cosigner_rotated: 'Protected purchases are temporarily unavailable.',
  cosigner_unavailable: 'Protected purchases are temporarily unavailable.',
  secure_purchase_disabled: 'Protected purchases are temporarily unavailable.',
  asset_index_stale: 'The marketplace index is catching up with the latest block. Try again in a moment.',
  asset_index_unavailable: 'The marketplace index is catching up with the latest block. Try again in a moment.',
  asset_index_incomplete: 'The marketplace index is catching up with the latest block. Try again in a moment.',
  asset_index_disagrees: 'The marketplace index is catching up with the latest block. Try again in a moment.',
  too_many_pending_purchases: 'This wallet has too many unfinished protected purchases; wait a few minutes and try again.',
  too_many_items: `Up to ${MAX_PROTECTED_ITEMS_PER_PURCHASE} protected items can be bought together.`,
  quote_expired: 'The quote expired before it was signed. Run the purchase again for a fresh one.',
  over_budget: 'The purchase would cost more than the quoted total; nothing was signed.',
}

const LISTING_STAGES = new Set<ProtectedTradeStage>(['listing capability check', 'listing build', 'listing sign', 'listing authorize', 'recovery'])

/** User-facing text for a protected-trading code, or '' when there is none. */
export function protectedErrorMessage(code: string, stage?: ProtectedTradeStage): string {
  const listingFirst = stage !== undefined && LISTING_STAGES.has(stage)
  const [first, second] = listingFirst ? [LISTING_COPY, PURCHASE_COPY] : [PURCHASE_COPY, LISTING_COPY]
  return first[code] ?? second[code] ?? ''
}

interface ApiErrorLike {
  response?: { status?: number; data?: { code?: string; message?: string } | string }
}

/**
 * Turn anything a protected-trading call threw into a `ProtectedTradeError`.
 * HTTP failures keep the server's code (or `http_<status>` when it sent none);
 * local verification refusals keep theirs; anything else is rethrown as is.
 */
export function toProtectedError(err: unknown, stage: ProtectedTradeStage): Error {
  if (err instanceof ProtectedTradeError) return err
  if (err instanceof PassthroughError) {
    const copy = protectedErrorMessage(err.code, stage)
    return new ProtectedTradeError(err.code, copy ? `${err.message}. ${copy}` : err.message, stage)
  }
  const response = (err as ApiErrorLike)?.response
  if (!response) return err as Error
  const data = typeof response.data === 'object' && response.data ? response.data : {}
  const code = String(data.code || `http_${response.status}`)
  const text = protectedErrorMessage(code, stage) || data.message || `request failed with status ${response.status}`
  return new ProtectedTradeError(code, `Protected ${stage} failed (${code}): ${text}`, stage, response.status)
}
