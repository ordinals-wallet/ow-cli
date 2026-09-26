import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PINNED_COSIGNER_XONLY_HEX, bytesToHex, hexToBytes } from '@ow-cli/core'
import { btc } from '../../core/__tests__/passthrough-fixtures.js'
import {
  seller,
  sellerAddress,
  attacker,
  ITEM,
  PRICE,
  templates,
  OPTS,
  type TemplateOptions,
} from '../../core/__tests__/passthrough-listing-fixtures.js'

const api = vi.hoisted(() => ({
  securePurchase: { capabilities: vi.fn() },
  secureListing: { buildBulk: vi.fn(), authorizeBulk: vi.fn(), status: vi.fn(), recover: vi.fn() },
  wallet: { getInscriptionOutpoint: vi.fn(), broadcast: vi.fn() },
  outpointToTxidVout: (s: string) => {
    const txid = s.slice(0, 64).match(/../g)!.reverse().join('')
    const vout = parseInt(s.slice(64).match(/../g)!.reverse().join(''), 16)
    return `${txid}:${vout}`
  },
}))
vi.mock('@ow-cli/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ow-cli/api')>()
  return { ...api, OwApiError: real.OwApiError, isOwApiError: real.isOwApiError }
})

import { OwApiError } from '@ow-cli/api'
const apiError = (status: number, body: Record<string, unknown>) =>
  new OwApiError({ status, message: typeof body.message === 'string' ? body.message : `HTTP ${status}`, body })

import { planListing, executeProtectedListing, recoverProtectedListing } from '../src/protected-listing.js'
import { ProtectedTradeError } from '../src/protected-errors.js'

const ID = 'c'.repeat(64) + 'i0'
const PUBLIC_KEY = bytesToHex(seller.publicKey)
const serialized = (outpoint: string) => {
  const [txid, vout] = outpoint.split(':')
  const le = Number(vout).toString(16).padStart(8, '0').match(/../g)!.reverse().join('')
  return txid.match(/../g)!.reverse().join('') + le
}

function serveBuild(o: TemplateOptions = {}, row: Record<string, unknown> = {}) {
  const t = templates(o)
  api.secureListing.buildBulk.mockResolvedValue({
    version: 4,
    policy: 'passthrough_v4',
    items: [{
      version: 4,
      state: 'authorization_required',
      outpoint: ITEM,
      protocol: 'ordinal',
      policy: 'passthrough_v4',
      template_digest: '11'.repeat(32),
      psbt: t.passthroughPsbtHex,
      sale_psbt: t.salePsbtHex,
      passthrough_txid: t.passthroughTxid,
      escrow_value: t.escrowValue,
      escrow_price_sats: PRICE,
      cosigner_public_key: PINNED_COSIGNER_XONLY_HEX,
      ...row,
    }],
  })
  return t
}

const list = () =>
  executeProtectedListing({ items: [{ outpoint: ITEM, priceSats: PRICE, inscriptionId: ID }], address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey })

beforeEach(() => {
  vi.clearAllMocks()
  api.securePurchase.capabilities.mockResolvedValue({
    escrow_policy: 'passthrough_v4',
    listing_enabled: true,
    cosigner_public_key: PINNED_COSIGNER_XONLY_HEX,
    min_postage_sats: 330,
    protocol_status: { ordinal: 'enabled' },
  })
  api.wallet.getInscriptionOutpoint.mockResolvedValue({
    inscription: { id: ID, sat_offset: 0, outpoint: serialized(ITEM), address: sellerAddress, sats: 546 },
    owner: sellerAddress,
    sats: 546,
    escrow: null,
  })
  api.secureListing.status.mockResolvedValue(null)
  api.secureListing.authorizeBulk.mockImplementation(async (items: Array<{ outpoint: string }>) => ({
    items: items.map((i) => ({ state: 'listed', outpoint: i.outpoint, passthrough_txid: 'ab'.repeat(32) })),
  }))
})

describe('planListing', () => {
  it('protects by default when capabilities allow and postage is at least 330', async () => {
    const plan = await planListing([{ inscriptionId: ID, priceSats: PRICE }], sellerAddress)
    expect(plan.protectedItems).toHaveLength(1)
    expect(plan.protectedItems[0]).toMatchObject({ outpoint: ITEM, postageSat: 546, repricing: false })
  })

  it('lists standard with --unprotected, with small postage, or when protection is off', async () => {
    expect((await planListing([{ inscriptionId: ID, priceSats: PRICE }], sellerAddress, { unprotected: true })).standardItems).toHaveLength(1)
    expect(api.securePurchase.capabilities).not.toHaveBeenCalled()

    api.wallet.getInscriptionOutpoint.mockResolvedValue({
      inscription: { id: ID, sat_offset: 0, outpoint: serialized(ITEM), address: sellerAddress, sats: 294 }, owner: sellerAddress, sats: 294, escrow: null,
    })
    const small = await planListing([{ inscriptionId: ID, priceSats: PRICE }], sellerAddress)
    expect(small.standardItems[0].standardReason).toMatch(/below the 330/)

    api.securePurchase.capabilities.mockResolvedValue({ escrow_policy: 'passthrough_v4', listing_enabled: false, cosigner_public_key: PINNED_COSIGNER_XONLY_HEX })
    expect((await planListing([{ inscriptionId: ID, priceSats: PRICE }], sellerAddress)).standardItems).toHaveLength(1)
  })

  it('refuses outright when the API names another co-signer', async () => {
    api.securePurchase.capabilities.mockResolvedValue({ escrow_policy: 'passthrough_v4', cosigner_public_key: 'cd'.repeat(32) })
    await expect(planListing([{ inscriptionId: ID, priceSats: PRICE }], sellerAddress)).rejects.toMatchObject({ code: 'cosigner_key_unpinned' })
  })

  it('marks an existing protected listing as a reprice, and refuses items not in this wallet', async () => {
    api.secureListing.status.mockResolvedValue({ state: 'listed', outpoint: ITEM })
    expect((await planListing([{ inscriptionId: ID, priceSats: PRICE }], sellerAddress)).protectedItems[0].repricing).toBe(true)
    await expect(planListing([{ inscriptionId: ID, priceSats: PRICE }], attacker.address)).rejects.toMatchObject({ code: 'not_owner' })
  })
})

describe('executeProtectedListing', () => {
  it('verifies, signs and authorizes; the payload carries the price for repricing', async () => {
    const t = serveBuild()
    const out = await list()
    expect(out.failures).toEqual([])
    expect(out.listed).toEqual([{ inscriptionId: ID, outpoint: ITEM, priceSats: PRICE, passthroughTxid: 'ab'.repeat(32) }])
    const [payload] = api.secureListing.authorizeBulk.mock.calls[0][0]
    expect(payload).toMatchObject({ outpoint: ITEM, protocol: 'ordinal', seller_public_key: PUBLIC_KEY, escrow_price_sats: PRICE, template_digest: '11'.repeat(32) })
    const pt = btc.Transaction.fromPSBT(hexToBytes(payload.psbt), OPTS)
    expect(pt.getInput(0).tapKeySig).toHaveLength(64)
    const sale = btc.Transaction.fromPSBT(hexToBytes(payload.sale_psbt), OPTS)
    expect(sale.getInput(0).tapKeySig).toBeUndefined()
    expect(sale.getInput(0).tapScriptSig![0][1][64]).toBe(0x83)
    expect(api.secureListing.buildBulk).toHaveBeenCalledWith({
      protocol: 'ordinal', seller_address: sellerAddress, seller_public_key: PUBLIC_KEY, items: [{ outpoint: ITEM, escrow_price_sats: PRICE }],
    })
    expect(t.passthroughTxid).toHaveLength(64)
  })

  const tampered: Array<[string, TemplateOptions, Record<string, unknown>, string]> = [
    ['an escrow for another co-signer', { cosigner: attacker.xOnly }, {}, 'listing_escrow_mismatch'],
    ['a payout to someone else', { salePayTo: attacker.address }, {}, 'listing_payout_mismatch'],
    ['a lower sale price', { salePrice: PRICE - 1 }, {}, 'listing_price_mismatch'],
    ['an extra passthrough output', { extraPassthroughOutput: true }, {}, 'listing_output_shape'],
    ['a sale template with SIGHASH_ALL', { saleSighash: 0x01 }, {}, 'sale_template_sighash'],
    ['a row naming another co-signer', {}, { cosigner_public_key: 'cd'.repeat(32) }, 'cosigner_key_unpinned'],
    ['a row for another price', {}, { escrow_price_sats: PRICE + 1 }, 'listing_price_mismatch'],
    ['a row whose passthrough txid does not match', {}, { passthrough_txid: 'ee'.repeat(32) }, 'stale_listing'],
  ]
  it.each(tampered)('refuses %s and never authorizes it', async (_, o, row, expected) => {
    serveBuild(o, row)
    const out = await list()
    expect(out.listed).toEqual([])
    expect(out.failures.map((f) => f.code)).toEqual([expected])
    expect(api.secureListing.authorizeBulk).not.toHaveBeenCalled()
  })

  it('maps server refusals to codes with the frontend copy', async () => {
    api.secureListing.buildBulk.mockResolvedValue({ items: [{ outpoint: ITEM, error: true, code: 'already_listed' }] })
    const built = await list()
    expect(built.failures[0]).toMatchObject({ inscriptionId: ID, code: 'already_listed', message: 'Already listed from another wallet. Delist it there first.' })

    serveBuild()
    api.secureListing.authorizeBulk.mockResolvedValue({ items: [{ outpoint: ITEM, error: true, code: 'template_digest_mismatch' }] })
    expect((await list()).failures[0]).toMatchObject({ code: 'template_digest_mismatch', message: 'The listing changed while signing. Try again.' })

    api.secureListing.buildBulk.mockRejectedValue(apiError(400, { error: true, code: 'postage_too_small' }))
    const err = await list().catch((e) => e)
    expect(err).toBeInstanceOf(ProtectedTradeError)
    expect(err).toMatchObject({ code: 'postage_too_small', stage: 'listing build', status: 400, retryable: false })
    expect(err.message).toMatch(/at least 330 sats of postage/)
  })
})

describe('recoverProtectedListing', () => {
  it('refuses a recovery template that pays someone else, before broadcasting', async () => {
    const escrow = templates().escrow
    const tx = new btc.Transaction(OPTS)
    tx.addInput({
      txid: 'ef'.repeat(32), index: 0, sequence: 144,
      witnessUtxo: { script: escrow.script, amount: 1_000n },
      tapLeafScript: [escrow.recoveryEntry],
    })
    tx.addOutput({ script: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(attacker.address)), amount: 718n })
    api.secureListing.recover.mockResolvedValue({ psbt: bytesToHex(tx.toPSBT()) })
    const err = await recoverProtectedListing({
      passthroughTxid: 'ef'.repeat(32), feeRate: 2, address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey,
    }).catch((e) => e)
    expect(err).toMatchObject({ code: 'recovery_destination', stage: 'recovery' })
    expect(api.wallet.broadcast).not.toHaveBeenCalled()
  })

  it('signs an honest recovery and broadcasts it', async () => {
    const escrow = templates().escrow
    const tx = new btc.Transaction(OPTS)
    tx.addInput({
      txid: 'ef'.repeat(32), index: 0, sequence: 144,
      witnessUtxo: { script: escrow.script, amount: 1_000n },
      tapLeafScript: [escrow.recoveryEntry],
    })
    tx.addOutput({ script: btc.OutScript.encode(btc.Address(btc.NETWORK).decode(sellerAddress)), amount: 718n })
    api.secureListing.recover.mockResolvedValue({ psbt: bytesToHex(tx.toPSBT()) })
    api.wallet.broadcast.mockResolvedValue({ txid: 'x' })
    const out = await recoverProtectedListing({
      passthroughTxid: 'ef'.repeat(32), feeRate: 2, address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey,
    })
    expect(out.feeSat).toBe(282)
    expect(api.wallet.broadcast).toHaveBeenCalledWith(out.rawtx)
    expect(api.secureListing.recover).toHaveBeenCalledWith({ passthrough_txid: 'ef'.repeat(32), fee_rate: 2, destination: sellerAddress })
  })
})
