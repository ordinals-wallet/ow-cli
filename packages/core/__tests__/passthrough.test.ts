import { describe, it, expect } from 'vitest'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { keypairFromMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'
import {
  MARKET_FEE_ADDRESS,
  NUMS_INTERNAL_KEY_HEX,
  PINNED_COSIGNER_XONLY_HEX,
  PassthroughError,
  parsePassthroughLeaf,
  passthroughEscrow,
  signOwnInputs,
  unsignedTxid,
  verifyPassthroughPurchase,
  verifySale,
  verifySetup,
} from '../src/passthrough.js'
import { buildFixture, buildSetup, THROWAWAY, type FixtureOptions } from './passthrough-fixtures.js'

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof PassthroughError) return err.code
    throw err
  }
  return 'accepted'
}

const check = (opts: FixtureOptions = {}, feeRateSatVb = 5) => {
  const f = buildFixture(opts)
  return code(() =>
    verifySale({
      salePsbtHex: f.salePsbt,
      parent: f.parent,
      listing: f.listing,
      buyerAddress: THROWAWAY.buyer.address,
      feeRateSatVb,
    }),
  )
}

describe('passthrough escrow', () => {
  it('matches the escrow the reference implementation derives for the same keys', () => {
    // Vector produced with the wallet frontend's own escrow builder.
    const seller = hexToBytes('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5')
    const escrow = passthroughEscrow(seller)
    expect(bytesToHex(escrow.leaf)).toBe(
      '20c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ac201d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7deeba529c',
    )
    expect(bytesToHex(escrow.recoveryLeaf)).toBe(
      '029000b27520c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5ac',
    )
    expect(bytesToHex(escrow.script)).toBe('512028745191b3e8dfa72dfb553a6931e922bafd3acd4082e4af1a51046a6b915f69')
    expect(escrow.address).toBe('bc1p9p69rydnar06wt0m25axjv0fy2a06wkdgzpwftc62yzx56u3ta5ssxklk7')
  })

  it('parses only an exact 2-of-2 leaf', () => {
    const seller = THROWAWAY.seller.xOnly
    const leaf = passthroughEscrow(seller).leaf
    const keys = parsePassthroughLeaf(leaf)
    expect(bytesToHex(keys!.seller)).toBe(bytesToHex(seller))
    expect(bytesToHex(keys!.cosigner)).toBe(PINNED_COSIGNER_XONLY_HEX)
    expect(parsePassthroughLeaf(leaf.slice(0, -1))).toBeNull()
    const oneOfTwo = leaf.slice()
    oneOfTwo[68] = 0x51 // OP_1: either key alone
    expect(parsePassthroughLeaf(oneOfTwo)).toBeNull()
  })

  it('refuses a seller key equal to the co-signer', () => {
    expect(code(() => passthroughEscrow(hexToBytes(PINNED_COSIGNER_XONLY_HEX)))).toBe('escrow_keys_identical')
  })
})

describe('verifySale', () => {
  it('accepts an honest sale and reports what it pays', () => {
    const f = buildFixture()
    const v = verifySale({
      salePsbtHex: f.salePsbt,
      parent: f.parent,
      listing: f.listing,
      buyerAddress: THROWAWAY.buyer.address,
      feeRateSatVb: 5,
    })
    expect(v).toMatchObject({
      sellerProceedsSat: 50_000,
      marketFeeSat: 1_350,
      creatorRoyaltySat: 500,
      networkFeeSat: 1_000,
      passthroughInput: 1,
      assetOutput: 2,
      buyerInputs: [0, 2],
    })
    expect(v.saleTxid).toBe(f.saleTxid)
  })

  it('accepts a sale whose escrow input is already co-signed', () => {
    expect(check({ cosigned: true })).toBe('accepted')
  })

  it('verifies from a witness-stripped parent and from a signed one alike', () => {
    const stripped = buildFixture()
    // No segwit marker+flag after the version: the parent carries no witness.
    expect(stripped.parent.raw.slice(8, 12)).not.toBe('0001')
    expect(buildFixture({ signedParent: true }).parent.raw.slice(8, 12)).toBe('0001')
    expect(check()).toBe('accepted')
    const signed = buildFixture({ signedParent: true })
    expect(signed.parent.txid).toBe(stripped.parent.txid)
    expect(check({ signedParent: true })).toBe('accepted')
  })

  it('pays the seller exactly the listed escrow price', () => {
    expect(check({ payout: 50_001, networkFee: 999 })).toBe('sale_payout_mismatch')
    expect(check({ payout: 49_000 })).toBe('sale_payout_mismatch')
    // Unknown escrow price: bounded by the buyer-facing price instead (see chain checks).
    expect(check({ payout: 49_000, listedEscrowPrice: null })).toBe('accepted')
  })

  const refused: Array<[string, FixtureOptions, string]> = [
    ['a payout to someone other than the seller', { payoutTo: THROWAWAY.attacker.address }, 'sale_payout_mismatch'],
    ['the item sent to someone else', { assetTo: THROWAWAY.attacker.address }, 'sale_asset_mismatch'],
    ['the item landing on the wrong sats', { assetValue: 600 }, 'sale_asset_mismatch'],
    ['sat offsets shifted so the inscription lands in the fee output', { changeOneDelta: -546 }, 'sale_asset_mismatch'],
    ['an escrow co-signed by an unpinned key', { cosigner: THROWAWAY.attacker.xOnly }, 'sale_leaf_unpinned'],
    ['a leaf that does not match the escrow prevout', { leafSeller: THROWAWAY.attacker.xOnly }, 'sale_escrow_mismatch'],
    ['an escrow input with a spendable internal key', { internalKey: THROWAWAY.attacker.xOnly }, 'sale_template_internal_key'],
    ['an escrow input with no leaf and no witness', { omitLeaf: true }, 'sale_not_cosigned'],
    ['a co-signed witness whose seller signature is not 0x83', { cosigned: true, sellerSighash: 0x01 }, 'sale_witness_sighash'],
    ['a passthrough that moves a different item', { parentSpends: `${'cc'.repeat(32)}:0` }, 'parent_source_mismatch'],
    ['a passthrough that does not hash to its txid', { declaredParentTxid: 'dd'.repeat(32) }, 'parent_txid_mismatch'],
    ['a misstated escrow prevout value', { escrowPrevoutValue: 10_000 }, 'sale_prevout_mismatch'],
    ['an extra output to an unknown party', { extraOutput: { to: THROWAWAY.attacker.address, value: 5_000 } }, 'sale_unknown_output'],
    ['change sent to someone else', { changeTo: THROWAWAY.attacker.address }, 'sale_change_mismatch'],
    ['a network fee far above the chosen rate', { networkFee: 15_000 }, 'sale_fee'],
    ['outputs that exceed inputs', { networkFee: -1 }, 'sale_fee'],
    ['a funding input asking for SIGHASH_NONE|ANYONECANPAY', { buyerSighash: 0x82 }, 'buyer_sighash'],
    ['a funding input asking for SIGHASH_SINGLE|ANYONECANPAY', { buyerSighash: 0x83 }, 'buyer_sighash'],
    ['a funding input that is not ours', { trailingOwner: THROWAWAY.attacker.address }, 'funding_not_yours'],
    ['a funding input that already carries a witness', { prefilledWitness: true }, 'funding_prefilled'],
    ['a sale with no leading funding input', { noLeadingInput: true }, 'sale_input_count'],
    ['a sale with no trailing fee input', { noTrailingInput: true }, 'sale_input_count'],
  ]
  it.each(refused)('refuses %s', (_, opts, expected) => {
    expect(check(opts)).toBe(expected)
  })

  it('refuses garbage instead of a PSBT', () => {
    const f = buildFixture()
    expect(
      code(() =>
        verifySale({ salePsbtHex: 'psbt_purchase_hex', parent: f.parent, listing: f.listing, buyerAddress: THROWAWAY.buyer.address, feeRateSatVb: 5 }),
      ),
    ).toBe('invalid_psbt')
  })

  it('pins the marketplace fee address', () => {
    // A "fee" paid to any other address is an unknown output.
    expect(check({ marketTo: THROWAWAY.attacker.address })).toBe('sale_unknown_output')
    expect(MARKET_FEE_ADDRESS.startsWith('bc1p')).toBe(true)
  })
})

describe('verifyPassthroughPurchase', () => {
  const purchase = (f: ReturnType<typeof buildFixture>, extra: Partial<Parameters<typeof verifyPassthroughPurchase>[0]> = {}) =>
    verifyPassthroughPurchase({
      links: [{ saleTxid: f.saleTxid, salePsbtHex: f.salePsbt, parent: f.parent, listing: f.listing }],
      buyerAddress: THROWAWAY.buyer.address,
      feeRateSatVb: 5,
      ...extra,
    })

  it('totals an honest single-item purchase', () => {
    const v = purchase(buildFixture())
    expect(v.totalSat).toBe(50_000 + 1_350 + 500 + 1_000)
    expect(v.links[0].buyerInputs).toEqual([0, 2])
  })

  it('refuses a sale charging more than the listed price', () => {
    const f = buildFixture({ payout: 60_000, listedEscrowPrice: null })
    expect(code(() => purchase(f))).toBe('sale_overcharge')
  })

  it('refuses a marketplace fee inflated past the listed price', () => {
    expect(code(() => purchase(buildFixture({ marketFee: 9_000 })))).toBe('sale_overcharge')
  })

  it('refuses royalties above the cap', () => {
    expect(code(() => purchase(buildFixture({ royalty: 9_000 })))).toBe('sale_royalty')
  })

  it('refuses a sale that does not hash to its declared txid', () => {
    const f = buildFixture()
    expect(code(() => purchase({ ...f, saleTxid: 'ee'.repeat(32) }))).toBe('invalid_sale')
  })

  it('refuses a listing without a known price', () => {
    const f = buildFixture()
    expect(code(() => purchase({ ...f, listing: { ...f.listing, satoshiPrice: 0 } }))).toBe('listing_price_unknown')
  })

  it('verifies a setup transaction and ties the first sale to it', () => {
    const setup = buildSetup()
    const f = buildFixture({ fundingTxid: setup.txid, fundingVouts: [0, 1] })
    const v = purchase(f, { setup: { txid: setup.txid, psbt: setup.psbt } })
    expect(v.setupFeeSat).toBe(setup.feeSat)
    expect(v.setup!.buyerInputs).toEqual([0])
    // Same sale, but funded from somewhere other than the setup it came with.
    expect(code(() => purchase(buildFixture(), { setup: { txid: setup.txid, psbt: setup.psbt } }))).toBe('chain_funding_mismatch')
  })

  it('refuses a setup that leaks funds, overpays fees, or misdeclares its txid', () => {
    const verify = (opts: Parameters<typeof buildSetup>[0]) => {
      const s = buildSetup(opts)
      return code(() => verifySetup({ setupPsbtHex: s.psbt, buyerAddress: THROWAWAY.buyer.address, feeRateSatVb: 5 }))
    }
    expect(verify({})).toBe('accepted')
    expect(verify({ secondOutputTo: THROWAWAY.attacker.address })).toBe('setup_output_not_yours')
    expect(verify({ feeSat: 40_000 })).toBe('setup_fee')
    expect(verify({ thirdOutput: true })).toBe('setup_output_shape')
    expect(verify({ inputOwner: THROWAWAY.attacker.address })).toBe('setup_input_not_yours')
    expect(verify({ sighash: 0x83 })).toBe('buyer_sighash')
    const s = buildSetup()
    const f = buildFixture({ fundingTxid: s.txid, fundingVouts: [0, 1] })
    expect(code(() => purchase(f, { setup: { txid: 'ab'.repeat(32), psbt: s.psbt } }))).toBe('invalid_sale')
  })

  it('chains a second item onto the first sale and refuses a broken chain', () => {
    const first = buildFixture()
    const second = buildFixture({ fundingTxid: first.saleTxid, item: 2, marketFee: 0, royalty: 0 })
    const links = [first, second].map((f) => ({ saleTxid: f.saleTxid, salePsbtHex: f.salePsbt, parent: f.parent, listing: f.listing }))
    const v = verifyPassthroughPurchase({ links, buyerAddress: THROWAWAY.buyer.address, feeRateSatVb: 5 })
    expect(v.sellerProceedsSat).toBe(100_000)
    expect(v.links).toHaveLength(2)

    const stray = buildFixture({ item: 2, marketFee: 0, royalty: 0 })
    const broken = [links[0], { saleTxid: stray.saleTxid, salePsbtHex: stray.salePsbt, parent: stray.parent, listing: stray.listing }]
    expect(code(() => verifyPassthroughPurchase({ links: broken, buyerAddress: THROWAWAY.buyer.address, feeRateSatVb: 5 }))).toBe('chain_funding_mismatch')
    expect(code(() => verifyPassthroughPurchase({ links: [links[0], links[0]], buyerAddress: THROWAWAY.buyer.address, feeRateSatVb: 5 }))).toBe('invalid_sale')

    // Spending the previous sale's item or payout output instead of its change.
    for (const vouts of [[0, 2], [1, 5]] as Array<[number, number]>) {
      const wrong = buildFixture({ fundingTxid: first.saleTxid, fundingVouts: vouts, item: 2, marketFee: 0, royalty: 0 })
      const chain = [links[0], { saleTxid: wrong.saleTxid, salePsbtHex: wrong.salePsbt, parent: wrong.parent, listing: wrong.listing }]
      expect(code(() => verifyPassthroughPurchase({ links: chain, buyerAddress: THROWAWAY.buyer.address, feeRateSatVb: 5 }))).toBe('chain_funding_mismatch')
    }
  })

  it('refuses to verify a quote at or past its expiry', () => {
    const f = buildFixture()
    const now = Date.parse('2026-09-26T12:00:00Z')
    expect(code(() => purchase(f, { expiresAt: '2026-09-26T12:05:00Z', now }))).toBe('accepted')
    expect(code(() => purchase(f, { expiresAt: '2026-09-26T11:59:59Z', now }))).toBe('quote_expired')
    expect(code(() => purchase(f, { expiresAt: now, now }))).toBe('quote_expired')
    expect(code(() => purchase(f, { expiresAt: 'not a date', now }))).toBe('quote_expired')
  })

  it('refuses a purchase costing more than the spend cap', () => {
    const f = buildFixture()
    const total = 50_000 + 1_350 + 500 + 1_000
    expect(code(() => purchase(f, { maxTotalSat: total }))).toBe('accepted')
    expect(code(() => purchase(f, { maxTotalSat: total - 1 }))).toBe('over_budget')
    expect(code(() => purchase(f, { maxTotalSat: 0 }))).toBe('invalid_budget')
  })

  it('refuses an item delivered to someone other than the recipient', () => {
    const f = buildFixture()
    expect(code(() => purchase(f, { recipientAddress: THROWAWAY.attacker.address }))).toBe('sale_asset_mismatch')
  })
})

describe('signOwnInputs', () => {
  const kp = keypairFromMnemonic(THROWAWAY.buyer.mnemonic)

  it('signs only our inputs, with SIGHASH_DEFAULT, and finalizes nothing', async () => {
    const f = buildFixture()
    const signed = signOwnInputs({ psbt: f.salePsbt, indexes: [0, 2], privateKey: kp.privateKey, publicKey: kp.publicKey })
    const tx = btc.Transaction.fromPSBT(hexToBytes(signed), { allowUnknownOutputs: true })
    for (const i of [0, 2]) {
      const input = tx.getInput(i)
      expect(input.tapKeySig?.length).toBe(64)
      expect(input.finalScriptWitness).toBeUndefined()
    }
    const escrowInput = tx.getInput(1)
    expect(escrowInput.tapKeySig).toBeUndefined()
    expect(escrowInput.tapScriptSig).toBeUndefined()
    expect(escrowInput.finalScriptWitness).toBeUndefined()
    expect(bytesToHex(escrowInput.tapInternalKey!)).toBe(NUMS_INTERNAL_KEY_HEX)
    expect(unsignedTxid(signed)).toBe(f.saleTxid)

    // The signature is a valid key-path signature for our output key.
    const prevScripts = [0, 1, 2].map((i) => tx.getInput(i).witnessUtxo!.script)
    const amounts = [0, 1, 2].map((i) => tx.getInput(i).witnessUtxo!.amount)
    const digest = tx.preimageWitnessV1(0, prevScripts, btc.SigHash.DEFAULT, amounts)
    const outputKey = publicKeyToP2TR(kp.publicKey).script.slice(2)
    expect(await secp.schnorr.verify(tx.getInput(0).tapKeySig!, digest, outputKey)).toBe(true)
  })

  it('refuses to sign an input that is not ours', () => {
    const f = buildFixture()
    expect(code(() => signOwnInputs({ psbt: f.salePsbt, indexes: [0, 1, 2], privateKey: kp.privateKey, publicKey: kp.publicKey }))).toBe('funding_not_yours')
  })

  it('refuses a disallowed sighash even if verification was skipped', () => {
    const f = buildFixture({ buyerSighash: 0x83 })
    expect(code(() => signOwnInputs({ psbt: f.salePsbt, indexes: [0, 2], privateKey: kp.privateKey, publicKey: kp.publicKey }))).toBe('buyer_sighash')
  })

  it('refuses to sign nothing', () => {
    const f = buildFixture()
    expect(code(() => signOwnInputs({ psbt: f.salePsbt, indexes: [], privateKey: kp.privateKey, publicKey: kp.publicKey }))).toBe('missing_buyer_input')
  })
})
