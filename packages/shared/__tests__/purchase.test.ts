import { describe, it, expect, vi, beforeEach } from 'vitest'
import { keypairFromMnemonic, hexToBytes, PINNED_COSIGNER_XONLY_HEX } from '@ow-cli/core'
import { btc, buildFixture, THROWAWAY, type Fixture, type FixtureOptions } from '../../core/__tests__/passthrough-fixtures.js'

const market = vi.hoisted(() => ({
  getListing: vi.fn(),
  getSecurePurchaseCapabilities: vi.fn(),
  buildSecurePurchase: vi.fn(),
  submitSecurePurchase: vi.fn(),
  buildPurchaseBulk: vi.fn(),
  submitPurchase: vi.fn(),
}))
vi.mock('@ow-cli/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ow-cli/api')>()
  return { ...{ market }, OwApiError: real.OwApiError, isOwApiError: real.isOwApiError }
})

import { OwApiError } from '@ow-cli/api'
const apiError = (status: number, body: Record<string, unknown>) =>
  new OwApiError({ status, message: typeof body.message === 'string' ? body.message : `HTTP ${status}`, body })

import {
  canonicalOutpoint,
  executePurchase,
  isProtectedListing,
  planPurchase,
  buildPassthroughPurchase,
  signPassthroughPurchase,
  submitPassthroughPurchase,
} from '../src/purchase.js'
import { ProtectedTradeError } from '../src/protected-errors.js'

const kp = keypairFromMnemonic(THROWAWAY.buyer.mnemonic)
const wallet = {
  feeRate: 5,
  address: THROWAWAY.buyer.address,
  publicKey: THROWAWAY.buyer.publicKey,
  privateKey: kp.privateKey,
  publicKeyBytes: kp.publicKey,
}
const PROTECTED_ID = 'a'.repeat(64) + 'i0'
const LEGACY_ID = 'b'.repeat(64) + 'i0'

const listingRow = (f: Fixture, extra: Record<string, unknown> = {}) => ({
  inscription_id: PROTECTED_ID,
  outpoint: f.listing.outpoint,
  seller_address: f.listing.sellerAddress,
  creator_address: f.listing.creatorAddress,
  satoshi_price: f.listing.satoshiPrice,
  escrow_price: 50_000,
  buyer_address: null,
  secure_purchase_version: 2,
  secure_purchase_state: 'listed',
  protected: true,
  ...extra,
})

const buildResponse = (f: Fixture, extra: Record<string, unknown> = {}) => ({
  version: 4,
  policy: 'passthrough_v4',
  sale_txid: f.saleTxid,
  sales: [{ sale_txid: f.saleTxid, psbt: f.salePsbt, parent: f.parent }],
  recipient_address: THROWAWAY.buyer.address,
  cosigner_public_key: PINNED_COSIGNER_XONLY_HEX,
  economics: { buyer_total_sats: 52_850 },
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  ...extra,
})

/** Serve one protected listing, answered at build time by a (possibly tampered) fixture. */
function serve(tamper: FixtureOptions = {}, buildExtra: Record<string, unknown> = {}) {
  const honest = buildFixture()
  market.getListing.mockImplementation(async (id: string) =>
    id === PROTECTED_ID
      ? listingRow(honest)
      : id === LEGACY_ID
        ? { inscription_id: id, outpoint: 'f'.repeat(64) + ':1', seller_address: THROWAWAY.seller.address, satoshi_price: 9_000, protected: false }
        : null,
  )
  market.buildSecurePurchase.mockResolvedValue(buildResponse(buildFixture(tamper), buildExtra))
  return honest
}

const rejection = async (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'accepted', (err) => (err as { code?: string }).code ?? `uncoded: ${(err as Error).message}`)

beforeEach(() => {
  Object.values(market).forEach((fn) => fn.mockReset())
  market.getSecurePurchaseCapabilities.mockResolvedValue({
    escrow_policy: 'passthrough_v4',
    build_enabled: true,
    submit_enabled: true,
    cosigner_public_key: PINNED_COSIGNER_XONLY_HEX,
    protocol_status: { ordinal: 'enabled' },
  })
  market.submitSecurePurchase.mockImplementation(async (body: { sales: Array<{ sale_txid: string }> }) => ({
    accepted: true,
    txid: body.sales[0].sale_txid,
    state: 'broadcast',
  }))
  market.buildPurchaseBulk.mockResolvedValue({ setup: 'unused', purchase: 'unused' })
  market.submitPurchase.mockResolvedValue({ success: true, txid: 'legacy_txid' })
})

describe('listing kind', () => {
  it('detects protected listings the way the API marks them', () => {
    expect(isProtectedListing({ protected: true })).toBe(true)
    expect(isProtectedListing({ secure_purchase_version: 2, secure_purchase_state: 'listed' })).toBe(true)
    expect(isProtectedListing({ secure_purchase_version: 2, state: 'listed' })).toBe(true)
    expect(isProtectedListing({ secure_purchase_version: 2, secure_purchase_state: 'sold' })).toBe(false)
    expect(isProtectedListing({ secure_purchase_version: 1, secure_purchase_state: 'listed' })).toBe(false)
    expect(isProtectedListing({ protected: false, satoshi_price: 1 })).toBe(false)
    expect(isProtectedListing(null)).toBe(false)
  })

  it('reads outpoints in both forms the API uses', () => {
    const wire = '2e37e8926f62dbba853c876d615ee74e8bf607831bc0b1d4ab25c92661f7e4fe01000000'
    expect(canonicalOutpoint(wire)).toBe('fee4f76126c925abd4b1c01b8307f68b4ee75e616d873c85badb626f92e8372e:1')
    expect(canonicalOutpoint('AB'.repeat(32) + ':3')).toBe('ab'.repeat(32) + ':3')
    expect(canonicalOutpoint('nonsense')).toBeNull()
  })

  it('sorts a mixed purchase into its two kinds', async () => {
    serve()
    const plan = await planPurchase([PROTECTED_ID, LEGACY_ID], THROWAWAY.buyer.address)
    expect(plan.protectedItems.map((i) => i.inscriptionId)).toEqual([PROTECTED_ID])
    expect(plan.legacy.map((i) => i.inscriptionId)).toEqual([LEGACY_ID])
    expect(plan.listedTotalSat).toBe(51_350 + 9_000)
  })

  it('names the inscription that is not for sale', async () => {
    serve()
    const missing = 'c'.repeat(64) + 'i0'
    await expect(planPurchase([PROTECTED_ID, missing])).rejects.toThrow(`${missing} is not listed for sale`)
    expect(await rejection(planPurchase([PROTECTED_ID, PROTECTED_ID]))).toBe('duplicate_items')
  })

  it('refuses to buy your own listing', async () => {
    serve()
    expect(await rejection(planPurchase([PROTECTED_ID], THROWAWAY.seller.address))).toBe('own_listing')
  })
})

describe('protected purchase', () => {
  it('builds, verifies, signs only our inputs and submits unfinalized PSBTs', async () => {
    const f = serve()
    const { result } = await executePurchase({ ids: [PROTECTED_ID], ...wallet })
    expect(result.protected).toMatchObject({ ids: [PROTECTED_ID], txid: f.saleTxid, partial: false })
    expect(result.legacy).toBeUndefined()
    expect(market.buildPurchaseBulk).not.toHaveBeenCalled()
    expect(market.buildSecurePurchase).toHaveBeenCalledWith({
      outpoints: [f.listing.outpoint],
      protocol: 'ordinal',
      from: THROWAWAY.buyer.address,
      public_key: THROWAWAY.buyer.publicKey,
      fee_rate: 5,
      wallet_type: 'ow-cli',
    })
    const sent = market.submitSecurePurchase.mock.calls[0][0].sales
    expect(sent).toHaveLength(1)
    expect(sent[0].sale_txid).toBe(f.saleTxid)
    const tx = btc.Transaction.fromPSBT(hexToBytes(sent[0].psbt), { allowUnknownOutputs: true })
    expect(tx.getInput(0).tapKeySig).toBeDefined()
    expect(tx.getInput(2).tapKeySig).toBeDefined()
    expect(tx.getInput(1).tapKeySig).toBeUndefined()
    expect(tx.getInput(1).tapScriptSig).toBeUndefined()
    for (const i of [0, 1, 2]) expect(tx.getInput(i).finalScriptWitness).toBeUndefined()
  })

  it('reports amounts taken from the transaction, not from the API', async () => {
    serve({}, { economics: { buyer_total_sats: 60_000 } })
    const plan = await planPurchase([PROTECTED_ID])
    const quote = await buildPassthroughPurchase({ items: plan.protectedItems, ...wallet })
    expect(quote.verified.totalSat).toBe(52_850)
    expect(quote.quotedTotalSat).toBe(60_000)
  })

  it('refuses a sale costing more than its quoted total, unless within the caller tolerance', async () => {
    serve({}, { economics: { buyer_total_sats: 52_849 } })
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet }))).toBe('over_budget')
    expect(market.submitSecurePurchase).not.toHaveBeenCalled()
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet, budgetToleranceSat: 1 }))).toBe('accepted')
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet, budgetToleranceSat: -1 }))).toBe('invalid_budget')
  })

  it('refuses an expired quote before signing, and a quote that expires before submit', async () => {
    serve({}, { expires_at: new Date(Date.now() - 1_000).toISOString() })
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet }))).toBe('quote_expired')
    expect(market.submitSecurePurchase).not.toHaveBeenCalled()

    serve()
    const plan = await planPurchase([PROTECTED_ID])
    const quote = await buildPassthroughPurchase({ items: plan.protectedItems, ...wallet })
    const signed = signPassthroughPurchase(quote, wallet)
    expect(await rejection(submitPassthroughPurchase({ ...signed, expiresAt: new Date(Date.now() - 1).toISOString() }))).toBe('quote_expired')
    expect(await rejection(Promise.resolve().then(() => signPassthroughPurchase({ ...quote, expiresAt: new Date(Date.now() - 1).toISOString() }, wallet)))).toBe('quote_expired')
    expect(market.submitSecurePurchase).not.toHaveBeenCalled()
  })

  it('refuses a build without an expiry or a stated total', async () => {
    serve({}, { expires_at: undefined })
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet }))).toBe('invalid_sale')
    serve({}, { economics: {} })
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet }))).toBe('invalid_sale')
  })

  it('surfaces API failures as typed errors', async () => {
    serve()
    market.buildSecurePurchase.mockRejectedValue(apiError(409, { code: 'too_many_pending_purchases' }))
    const err = await executePurchase({ ids: [PROTECTED_ID], ...wallet }).catch((e) => e)
    expect(err).toBeInstanceOf(ProtectedTradeError)
    expect(err).toMatchObject({ code: 'too_many_pending_purchases', stage: 'purchase build', status: 409, retryable: true })
  })

  const tampered: Array<[string, FixtureOptions, Record<string, unknown>, string]> = [
    ['pays a different seller', { payoutTo: THROWAWAY.attacker.address }, {}, 'sale_payout_mismatch'],
    ['delivers the inscription elsewhere', { assetTo: THROWAWAY.attacker.address }, {}, 'sale_asset_mismatch'],
    ['pays the seller more than their listed price', { payout: 80_000 }, {}, 'sale_payout_mismatch'],
    ['adds an output to a stranger', { extraOutput: { to: THROWAWAY.attacker.address, value: 4_000 } }, {}, 'sale_unknown_output'],
    ['burns the wallet on fees', { networkFee: 15_000 }, {}, 'sale_fee'],
    ['asks for an ANYONECANPAY signature', { buyerSighash: 0x83 }, {}, 'buyer_sighash'],
    ['uses an escrow with a different co-signer', { cosigner: THROWAWAY.attacker.xOnly }, {}, 'sale_leaf_unpinned'],
    ['moves a different inscription', { item: 2 }, {}, 'parent_source_mismatch'],
    ['names another co-signer', {}, { cosigner_public_key: 'ab'.repeat(32) }, 'cosigner_key_unpinned'],
    ['speaks another policy', {}, { policy: 'two_of_two_ow' }, 'invalid_sale'],
    ['delivers to another recipient', {}, { recipient_address: THROWAWAY.attacker.address }, 'invalid_sale'],
    ['returns the wrong number of sales', {}, { sales: [] }, 'invalid_sale'],
  ]
  it.each(tampered)('refuses a build response that %s, and never submits', async (_, fixture, extra, expected) => {
    serve(fixture, extra)
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet }))).toBe(expected)
    expect(market.submitSecurePurchase).not.toHaveBeenCalled()
  })

  it('refuses when the API publishes a different co-signer key, before building', async () => {
    serve()
    market.getSecurePurchaseCapabilities.mockResolvedValue({ escrow_policy: 'passthrough_v4', cosigner_public_key: 'cd'.repeat(32) })
    expect(await rejection(executePurchase({ ids: [PROTECTED_ID], ...wallet }))).toBe('cosigner_key_unpinned')
    expect(market.buildSecurePurchase).not.toHaveBeenCalled()
  })

  it('explains build failures in plain words', async () => {
    serve()
    market.buildSecurePurchase.mockRejectedValue(apiError(400, { code: 'two_funding_utxos_required' }))
    await expect(executePurchase({ ids: [PROTECTED_ID], ...wallet })).rejects.toThrow(/at least two spendable UTXOs/)
  })
})

describe('mixed purchase', () => {
  it('runs the protected purchase first and reports a legacy failure as partial', async () => {
    const f = serve()
    market.buildPurchaseBulk.mockRejectedValue(apiError(400, { message: 'no longer listed' }))
    const err = await executePurchase({ ids: [LEGACY_ID, PROTECTED_ID], ...wallet }).catch((e) => e)
    expect(err.code).toBe('partial_purchase')
    expect(err.message).toContain(f.saleTxid)
    expect(err.message).toContain('no longer listed')
    expect(market.buildPurchaseBulk).toHaveBeenCalledWith(expect.objectContaining({ inscriptions: [LEGACY_ID] }))
  })

  it('sends only legacy ids to the legacy build', async () => {
    serve()
    market.getListing.mockImplementation(async (id: string) => ({ inscription_id: id, outpoint: 'f'.repeat(64) + ':1', seller_address: THROWAWAY.seller.address, satoshi_price: 9_000 }))
    // The legacy PSBTs here are placeholders, so signing them fails; what matters is the routing.
    await executePurchase({ ids: [LEGACY_ID], ...wallet }).catch(() => undefined)
    expect(market.buildSecurePurchase).not.toHaveBeenCalled()
    expect(market.getSecurePurchaseCapabilities).not.toHaveBeenCalled()
    expect(market.buildPurchaseBulk).toHaveBeenCalledTimes(1)
  })
})
