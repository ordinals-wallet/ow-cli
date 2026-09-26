/**
 * Signing vectors shared with the Rust SDK (`rust/ordinalswallet/tests/signing_vectors.rs`),
 * in the repo-root `fixtures/` directory. Two checks per file:
 *
 * 1. The generator (shared-vectors/generate.ts) run against this package
 *    reproduces the committed file exactly, so the vectors are what the
 *    TypeScript implementation does today.
 * 2. Every case is replayed from the JSON through the public functions.
 *
 * `OW_WRITE_VECTORS=1` rewrites the files instead of comparing them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { HDKey } from '@scure/bip32'
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { keypairFromMnemonic, keypairFromWIF, validateMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'
import { bip322MessageHash, bip322ToSpendTxid, bip322AddressScript, signBip322Simple, verifyBip322Simple } from '../src/bip322.js'
import {
  offerEscrow,
  verifyFundingPsbt,
  signOfferFunding,
  verifyPresignPsbt,
  signOfferPresign,
  verifyAcceptPsbt,
  signAcceptPsbt,
  verifyCancelPsbt,
  signOfferCancel,
  OfferVerificationError,
} from '../src/offers-verify.js'
import {
  PassthroughError,
  PINNED_COSIGNER_XONLY_HEX,
  passthroughEscrow,
  parsePassthroughLeaf,
  verifySale,
  verifySetup,
  verifyPassthroughPurchase,
  assertQuoteFresh,
  signOwnInputs,
} from '../src/passthrough.js'
import {
  tapLeafHash,
  assertListingTemplates,
  assertSignedSaleTemplate,
  signListingTemplates,
  assertRecoveryTemplate,
  signRecovery,
} from '../src/passthrough-listing.js'
import { buildCancelProof, inspectCancelProof } from '../src/cancel-proof.js'
import { buildSharedVectors } from './shared-vectors/generate.js'
import { useZeroAuxRand } from './shared-vectors/deterministic.js'

const FIXTURES = new URL('../../../fixtures/', import.meta.url)
const WRITE = process.env.OW_WRITE_VECTORS === '1'
const vec = (name: string): any => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))
const OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, allowLegacyWitnessUtxo: true }
const parse = (hex: string) => btc.Transaction.fromPSBT(hexToBytes(hex), OPTS)
const h = hexToBytes
const serialize = (content: unknown) => JSON.stringify(content, null, 2) + '\n'

if (WRITE) {
  for (const [name, content] of Object.entries(await buildSharedVectors())) {
    writeFileSync(new URL(name, FIXTURES), serialize(content))
  }
}

let restore: () => void
beforeAll(() => {
  restore = useZeroAuxRand()
})
afterAll(() => restore())

/** `{ ok: true, ... }` or `{ ok: false, code }`, as the vectors record outcomes. */
function run<T>(fn: () => T): { ok: true; value: T } | { ok: false; code: string } {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    if (err instanceof PassthroughError) return { ok: false, code: err.code }
    throw err
  }
}
function expectOutcome<T>(expected: any, fn: () => T, pick: (v: T) => Record<string, unknown> = () => ({})) {
  const got = run(fn)
  if (!expected.ok) {
    expect(got).toEqual({ ok: false, code: expected.code })
    return
  }
  if (!got.ok) throw new Error(`expected success, got ${got.code}`)
  const { ok: _ok, ...rest } = expected
  expect(pick(got.value)).toEqual(rest)
}

function signedInputs(hex: string) {
  const tx = parse(hex)
  return Array.from({ length: tx.inputsLength }, (_, i) => {
    const inp = tx.getInput(i)
    return {
      tap_key_sig: inp.tapKeySig ? bytesToHex(inp.tapKeySig) : null,
      tap_script_sigs: (inp.tapScriptSig ?? []).map(([k, sig]) => ({ public_key: bytesToHex(k.pubKey), leaf_hash: bytesToHex(k.leafHash), signature: bytesToHex(sig) })),
      partial_sigs: (inp.partialSig ?? []).map(([pk, sig]) => ({ public_key: bytesToHex(pk), signature: bytesToHex(sig) })),
      final_script_witness: inp.finalScriptWitness ? inp.finalScriptWitness.map(bytesToHex) : null,
    }
  })
}

describe('shared signing vectors are what this implementation produces', () => {
  it('regenerates every file byte for byte', async () => {
    const files = await buildSharedVectors()
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(new URL(name, FIXTURES), 'utf8'), `fixtures/${name} is stale; rerun with OW_WRITE_VECTORS=1`).toBe(serialize(content))
    }
  })
})

describe('fixtures/bip39.json', () => {
  const v = vec('bip39.json')
  it('wordlist', () => {
    expect(wordlist).toHaveLength(2048)
  })
  it.each(v.vectors as any[])('$mnemonic', (c) => {
    expect(entropyToMnemonic(h(c.entropy), wordlist)).toBe(c.mnemonic)
    expect(bytesToHex(mnemonicToEntropy(c.mnemonic, wordlist))).toBe(c.entropy)
    expect(validateMnemonic(c.mnemonic)).toBe(true)
    expect(bytesToHex(mnemonicToSeedSync(c.mnemonic, c.passphrase))).toBe(c.seed)
    expect(HDKey.fromMasterSeed(h(c.seed)).privateExtendedKey).toBe(c.xprv)
  })
  it('seeds without a passphrase', () => {
    for (const c of v.no_passphrase) expect(bytesToHex(mnemonicToSeedSync(c.mnemonic, ''))).toBe(c.seed)
  })
  it('invalid mnemonics', () => {
    for (const c of v.invalid) expect(validateMnemonic(c.mnemonic), c.reason).toBe(false)
  })
})

describe('fixtures/derivation.json', () => {
  const v = vec('derivation.json')
  const fields = (kp: ReturnType<typeof keypairFromWIF>) => ({
    private_key: bytesToHex(kp.privateKey),
    public_key: bytesToHex(kp.publicKey),
    x_only_public_key: bytesToHex(kp.xOnlyPublicKey),
    p2tr_address: publicKeyToP2TR(kp.publicKey).address,
    p2wpkh_address: btc.p2wpkh(kp.publicKey).address,
  })
  it('matches the BIP-86 test vector', () => {
    expect(publicKeyToP2TR(keypairFromMnemonic(v.bip86_official.mnemonic).publicKey).address).toBe(v.bip86_official.p2tr_address)
  })
  it.each(v.mnemonics as any[])('$mnemonic', ({ mnemonic, ...expected }) => {
    expect(fields(keypairFromMnemonic(mnemonic))).toEqual(expected)
  })
  it.each(v.wif as any[])('$wif', ({ wif, ...expected }) => {
    expect(fields(keypairFromWIF(wif))).toEqual(expected)
  })
  it('refuses invalid mnemonics', () => {
    for (const m of v.invalid_mnemonics) expect(() => keypairFromMnemonic(m)).toThrow(/Invalid mnemonic/)
  })
})

describe('fixtures/bip322.json', () => {
  const v = vec('bip322.json')
  it('official hashes', () => {
    for (const c of v.official.tx_hashes) {
      expect(bytesToHex(bip322MessageHash(c.message))).toBe(c.message_hash)
      expect(bip322ToSpendTxid(bip322AddressScript(c.address).script, c.message)).toBe(c.to_spend_tx_hash)
    }
  })
  it('official signatures verify', async () => {
    for (const c of v.official.simple) for (const sig of c.bip322_signatures) expect(await verifyBip322Simple(c.address, c.message, sig)).toBe(true)
    for (const c of v.official.error) expect(await verifyBip322Simple(c.address, c.message, c.signature)).toBe(false)
  })
  it.each(v.sign as any[])('sign $description', async (c) => {
    expect(signBip322Simple(c.address, c.message, keypairFromWIF(c.wif).privateKey)).toBe(c.signature)
    expect(await verifyBip322Simple(c.address, c.message, c.signature)).toBe(true)
  })
  it.each(v.verify as any[])('verify $description', async (c) => {
    expect(await verifyBip322Simple(c.address, c.message, c.signature)).toBe(c.valid)
  })
  it.each(v.sign_errors as any[])('refuses $description', (c) => {
    expect(() => signBip322Simple(c.address, c.message, keypairFromWIF(c.wif).privateKey)).toThrow(c.ts_error)
  })
})

describe('fixtures/escrow.json', () => {
  const v = vec('escrow.json')
  it.each(v.offer as any[])('offer escrow $buyer_public_key / $recovery_delay_blocks', (c) => {
    const e = offerEscrow(c.buyer_public_key, c.recovery_delay_blocks)
    expect({ sale_leaf: bytesToHex(e.saleLeaf), recovery_leaf: bytesToHex(e.recoveryLeaf), script: bytesToHex(e.script), address: e.address })
      .toEqual({ sale_leaf: c.sale_leaf, recovery_leaf: c.recovery_leaf, script: c.script, address: c.address })
  })
  it.each(v.protected as any[])('protected escrow $seller_x_only', ({ seller_x_only, ...expected }) => {
    const e = passthroughEscrow(h(seller_x_only))
    expect({
      leaf: bytesToHex(e.leaf),
      recovery_leaf: bytesToHex(e.recoveryLeaf),
      script: bytesToHex(e.script),
      address: e.address,
      leaf_control_block: bytesToHex(e.leafControlBlock),
      recovery_control_block: bytesToHex(e.recoveryControlBlock),
      leaf_hash: bytesToHex(tapLeafHash(e.leaf)),
    }).toEqual(expected)
  })
  it.each(v.protected_errors as any[])('protected escrow refuses $description', (c) => {
    const { description: _d, seller_x_only, ...expected } = c
    expectOutcome(expected, () => passthroughEscrow(h(seller_x_only)), (e) => ({ script: bytesToHex(e.script) }))
  })
  it.each(v.passthrough_leaf_parse as any[])('parses $description', (c) => {
    const keys = parsePassthroughLeaf(h(c.leaf))
    expect(keys ? { seller: bytesToHex(keys.seller), cosigner: bytesToHex(keys.cosigner) } : null).toEqual(c.keys)
  })
})

function offerReplay(file: string, verify: (c: any) => string[], sign: (c: any) => string) {
  const v = vec(file)
  describe(`fixtures/${file}`, () => {
    it.each(v.cases as any[])('$description', (c) => {
      if (c.error !== undefined) {
        expect(() => verify(c)).toThrow()
        expect(() => sign(c)).toThrow()
        return
      }
      expect(verify(c)).toEqual(c.problems)
      if (c.signed) {
        const psbt = sign(c)
        expect(psbt).toBe(c.signed.psbt)
        expect(signedInputs(psbt)).toEqual(c.signed.inputs)
      } else if (c.sign_problems) {
        try {
          sign(c)
          throw new Error('expected a refusal')
        } catch (err) {
          expect(err).toBeInstanceOf(OfferVerificationError)
          expect((err as OfferVerificationError).problems).toEqual(c.sign_problems)
        }
      } else {
        expect(() => sign(c)).toThrow(c.sign_error)
      }
    })
  })
}

{
  const v = vec('offer-funding.json')
  const buyer = keypairFromWIF(v.buyer_wif)
  const ex = (e: any) => ({ buyerPublicKey: e.buyer_public_key, paymentAddress: e.payment_address, escrowValue: e.escrow_value, recoveryDelayBlocks: e.recovery_delay_blocks, maxMinerFeeSats: e.max_miner_fee_sats })
  offerReplay('offer-funding.json', (c) => verifyFundingPsbt(c.psbt, ex(c.expect)), (c) => signOfferFunding(c.psbt, buyer.privateKey, ex(c.expect)))
}
{
  const v = vec('offer-presign.json')
  const buyer = keypairFromWIF(v.buyer_wif)
  const p = (x: any) => ({
    privateKey: buyer.privateKey,
    scope: x.scope,
    signInputIndex: x.sign_input_index,
    sighash: x.sighash,
    recoveryDelayBlocks: x.recovery_delay_blocks,
    escrowValue: x.escrow_value,
    buyerAddress: x.buyer_address,
    priceSats: x.price_sats,
    marketFeeSats: x.market_fee_sats,
  })
  offerReplay('offer-presign.json', (c) => verifyPresignPsbt(c.psbt, p(c.params)), (c) => signOfferPresign(c.psbt, p(c.params)))
}
{
  const v = vec('offer-accept.json')
  const seller = keypairFromWIF(v.seller_wif)
  const ex = (e: any) => ({ myAddress: e.my_address, inscriptionOutpoint: e.inscription_outpoint, priceSats: e.price_sats, buyerAddress: e.buyer_address, buyerPaymentAddress: e.buyer_payment_address })
  offerReplay('offer-accept.json', (c) => verifyAcceptPsbt(c.psbt, ex(c.expect)), (c) => signAcceptPsbt(c.psbt, seller.privateKey, ex(c.expect)))
}
{
  const v = vec('offer-cancel.json')
  const buyer = keypairFromWIF(v.buyer_wif)
  const p = (x: any) => ({ privateKey: buyer.privateKey, buyerPaymentAddress: x.buyer_payment_address, escrowValue: x.escrow_value, recoveryDelayBlocks: x.recovery_delay_blocks, maxMinerFeeSats: x.max_miner_fee_sats })
  offerReplay('offer-cancel.json', (c) => verifyCancelPsbt(c.psbt, p(c.params)), (c) => signOfferCancel(c.psbt, p(c.params)))
}

describe('fixtures/listing-templates.json', () => {
  const v = vec('listing-templates.json')
  const sellerXOnly = h(v.seller.x_only_public_key)
  const privateKey = h(v.seller.private_key)
  const check = (c: any) => ({
    passthroughPsbtHex: c.passthrough_psbt,
    salePsbtHex: c.sale_psbt,
    expectedOutpoint: c.expected_outpoint,
    sellerAddress: c.seller_address,
    expectedSellerSats: c.expected_seller_sats,
    assetAddress: c.asset_address,
  })
  it.each(v.templates as any[])('$description', (c) => {
    expectOutcome(c.expect, () => assertListingTemplates({ ...check(c.check), sellerXOnly }), (r) => ({
      escrow_value: r.escrowValue,
      passthrough_txid: r.passthroughTxid,
      escrow_script: bytesToHex(r.escrow.script),
    }))
    expectOutcome(c.sign, () => signListingTemplates({ ...check(c.check), privateKey }), (r) => ({
      psbt: r.psbt,
      sale_psbt: r.salePsbt,
      passthrough_txid: r.passthroughTxid,
      escrow_value: r.escrowValue,
      passthrough_inputs: signedInputs(r.psbt),
      sale_inputs: signedInputs(r.salePsbt),
    }))
  })
  it.each(v.signed_sale as any[])('signed sale: $description', (c) => {
    expectOutcome(c.expect, () => assertSignedSaleTemplate(c.psbt, {
      sellerXOnly,
      passthroughTxid: c.expectation.passthrough_txid,
      escrowValue: c.expectation.escrow_value,
      sellerAddress: c.expectation.seller_address,
      priceSats: c.expectation.price_sats,
    }), (out) => ({ unchanged: out === c.psbt, has_key_sig: !!parse(out).getInput(0).tapKeySig, inputs: signedInputs(out) }))
  })
})

describe('fixtures/recovery.json', () => {
  const v = vec('recovery.json')
  it.each(v.cases as any[])('$description', (c) => {
    const check = { psbtHex: c.psbt, passthroughTxid: c.passthrough_txid, destinationAddress: c.destination_address, feeRateSatVb: c.fee_rate }
    expectOutcome(c.expect, () => assertRecoveryTemplate({ ...check, sellerXOnly: h(v.seller.x_only_public_key) }), (r) => ({
      escrow_value: r.escrowValue,
      value_sat: r.valueSat,
      fee_sat: r.feeSat,
    }))
    expectOutcome(c.sign, () => signRecovery({ ...check, privateKey: h(v.seller.private_key) }), (r) => ({
      rawtx: r.rawtx,
      txid: r.txid,
      value_sat: r.valueSat,
      fee_sat: r.feeSat,
    }))
  })
})

describe('fixtures/purchase-verify.json', () => {
  const v = vec('purchase-verify.json')
  const listing = (l: any) => ({ outpoint: l.outpoint, sellerAddress: l.seller_address, creatorAddress: l.creator_address, satoshiPrice: l.satoshi_price, escrowPriceSat: l.escrow_price_sat })
  const sale = (s: any) => ({
    sellerProceedsSat: s.seller_proceeds_sat,
    marketFeeSat: s.market_fee_sat,
    creatorRoyaltySat: s.creator_royalty_sat,
    networkFeeSat: s.network_fee_sat,
    changeSat: s.change_sat,
    passthroughInput: s.passthrough_input,
    assetOutput: s.asset_output,
    buyerInputs: s.buyer_inputs,
    changeOutputs: s.change_outputs,
    saleTxid: s.sale_txid,
  })
  it.each(v.sales as any[])('sale: $description', (c) => {
    const got = run(() => verifySale({
      salePsbtHex: c.input.sale_psbt,
      parent: c.input.parent,
      listing: listing(c.input.listing),
      buyerAddress: c.input.buyer_address,
      feeRateSatVb: c.input.fee_rate,
      recipientAddress: c.input.recipient_address,
      marketFeeAddress: c.input.market_fee_address,
    }))
    if (!c.expect.ok) expect(got).toEqual({ ok: false, code: c.expect.code })
    else expect(got).toEqual({ ok: true, value: sale(c.expect) })
  })
  it.each(v.setups as any[])('setup: $description', (c) => {
    expectOutcome(c.expect, () => verifySetup({ setupPsbtHex: c.psbt, buyerAddress: c.buyer_address, feeRateSatVb: c.fee_rate }), (s) => ({
      txid: s.txid,
      fee_sat: s.feeSat,
      buyer_inputs: s.buyerInputs,
      change_outputs: s.changeOutputs,
    }))
  })
  it.each(v.purchases as any[])('purchase: $description', (c) => {
    const got = run(() => verifyPassthroughPurchase({
      links: c.input.links.map((l: any) => ({ saleTxid: l.sale_txid, salePsbtHex: l.sale_psbt, parent: l.parent, listing: listing(l.listing) })),
      setup: c.input.setup,
      buyerAddress: c.input.buyer_address,
      feeRateSatVb: c.input.fee_rate,
      recipientAddress: c.input.recipient_address,
      expiresAt: c.input.expires_at,
      maxTotalSat: c.input.max_total_sat,
      now: c.input.now,
    }))
    if (!c.expect.ok) {
      expect(got).toEqual({ ok: false, code: c.expect.code })
      return
    }
    if (!got.ok) throw new Error(got.code)
    const r = got.value
    expect({
      seller_proceeds_sat: r.sellerProceedsSat,
      market_fee_sat: r.marketFeeSat,
      creator_royalty_sat: r.creatorRoyaltySat,
      network_fee_sat: r.networkFeeSat,
      setup_fee_sat: r.setupFeeSat,
      total_sat: r.totalSat,
    }).toEqual({
      seller_proceeds_sat: c.expect.seller_proceeds_sat,
      market_fee_sat: c.expect.market_fee_sat,
      creator_royalty_sat: c.expect.creator_royalty_sat,
      network_fee_sat: c.expect.network_fee_sat,
      setup_fee_sat: c.expect.setup_fee_sat,
      total_sat: c.expect.total_sat,
    })
    expect(r.links).toEqual(c.expect.links.map(sale))
  })
  it.each(v.sign_own_inputs as any[])('sign: $description', (c) => {
    const kp = keypairFromMnemonic(v.buyer.mnemonic)
    expectOutcome(c.expect, () => signOwnInputs({ psbt: c.psbt, indexes: c.indexes, privateKey: kp.privateKey, publicKey: kp.publicKey }), (out) => ({
      psbt: out,
      inputs: signedInputs(out),
    }))
  })
  it.each(v.quote_fresh as any[])('quote expiry $expires_at at $now', ({ expires_at, now, ...expected }) => {
    expectOutcome(expected, () => assertQuoteFresh(expires_at, now))
  })
})

describe('fixtures/cancel-proof.json', () => {
  const v = vec('cancel-proof.json')
  it.each(v.cases as any[])('$description', (c) => {
    expectOutcome(c.expect, () => buildCancelProof({ outpoint: c.outpoint, valueSats: c.value_sats, privateKey: h(c.private_key), publicKey: h(c.public_key) }), (psbt) => {
      const s = inspectCancelProof(psbt)
      return {
        psbt,
        signature: bytesToHex(parse(psbt).getInput(0).finalScriptWitness![0]),
        shape: { inputs: s.inputs, outputs: s.outputs, sighash: s.sighash, signature_length: s.signatureLength, outpoint: s.outpoint, output_sats: Number(s.outputSats) },
      }
    })
  })
  it.each(v.inspect as any[])('inspects $description', (c) => {
    const s = inspectCancelProof(c.psbt)
    expect({ inputs: s.inputs, outputs: s.outputs, sighash: s.sighash, signature_length: s.signatureLength, outpoint: s.outpoint, output_sats: Number(s.outputSats) }).toEqual(c.shape)
  })
})

describe('fixtures/chain/protected-sales.json (real mainnet sales)', () => {
  const v = vec('chain/protected-sales.json')
  it.each(v.sales as any[])('$txid rebuilds the escrow and verifies both signatures', async (sale) => {
    const tx = btc.Transaction.fromRaw(h(sale.raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true })
    expect(tx.id).toBe(sale.txid)
    const idx = Array.from({ length: tx.inputsLength }, (_, i) => i).find((i) => tx.getInput(i).finalScriptWitness?.length === 4)!
    const [cosig, sellerSig, leaf, cb] = tx.getInput(idx).finalScriptWitness!
    const keys = parsePassthroughLeaf(leaf)!
    expect(bytesToHex(keys.cosigner)).toBe(PINNED_COSIGNER_XONLY_HEX)
    const escrow = passthroughEscrow(keys.seller)
    expect(bytesToHex(escrow.leafControlBlock)).toBe(bytesToHex(cb))
    expect(bytesToHex(escrow.script)).toBe(sale.prevouts[idx].script)
    const parentTxid = bytesToHex(tx.getInput(idx).txid!)
    const parent = btc.Transaction.fromRaw(h(sale.parents.find((p: any) => p.txid === parentTxid).raw), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true })
    expect(bytesToHex(parent.getOutput(0).script!)).toBe(bytesToHex(escrow.script))
    const scripts = sale.prevouts.map((p: any) => h(p.script))
    const amounts = sale.prevouts.map((p: any) => BigInt(p.value))
    expect(sellerSig[64]).toBe(0x83)
    const sellerMsg = tx.preimageWitnessV1(idx, scripts, 0x83, amounts, undefined, escrow.leaf, 0xc0)
    const cosignerMsg = tx.preimageWitnessV1(idx, scripts, 0x00, amounts, undefined, escrow.leaf, 0xc0)
    expect(await secp.schnorr.verify(sellerSig.slice(0, 64), sellerMsg, keys.seller)).toBe(true)
    expect(await secp.schnorr.verify(cosig, cosignerMsg, keys.cosigner)).toBe(true)
  })
})
