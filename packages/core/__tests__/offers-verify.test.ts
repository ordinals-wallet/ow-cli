import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import {
  OW_COSIGNER_XONLY,
  OW_MARKET_FEE_ADDRESS,
  NUMS_INTERNAL_KEY,
  OfferVerificationError,
  offerEscrow,
  expectedPresignSighash,
  verifyFundingPsbt,
  signOfferFunding,
  verifyPresignPsbt,
  signOfferPresign,
  verifyAcceptPsbt,
  signAcceptPsbt,
  verifyCancelPsbt,
  signOfferCancel,
} from '../src/offers-verify.js'
import { keypairFromWIF } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'

// PSBTs produced by a Rust harness that mirrors ow-api's offers.rs templates
// (bitcoin 0.29.2, the server's version). Signatures made by these helpers
// were verified there with the server's own extraction/sighash logic.
const F = JSON.parse(
  readFileSync(new URL('./fixtures/offers-server-psbts.json', import.meta.url), 'utf8'),
) as Record<string, any>

const buyer = keypairFromWIF(F.buyer_wif)
const seller = keypairFromWIF(F.seller_wif)
const buyerAddr: string = F.buyer_address
const sellerAddr: string = F.seller_address

const presign = {
  privateKey: buyer.privateKey,
  scope: 'item' as const,
  signInputIndex: 1,
  sighash: 0x01,
  recoveryDelayBlocks: F.delay,
  escrowValue: F.escrow_value,
  buyerAddress: buyerAddr,
  priceSats: F.price_sats,
  marketFeeSats: F.market_fee_sats,
}
const acceptExpect = {
  myAddress: sellerAddr,
  inscriptionOutpoint: F.item_outpoint,
  priceSats: F.price_sats,
  buyerAddress: buyerAddr,
}

function parse(hex: string) {
  return btc.Transaction.fromPSBT(hexToBytes(hex), { allowUnknownOutputs: true })
}

/** Rewrite one output of an unsigned PSBT. */
function mutateOutput(hex: string, idx: number, patch: { amount?: bigint; script?: Uint8Array }): string {
  const tx = parse(hex)
  tx.updateOutput(idx, patch)
  return bytesToHex(tx.toPSBT())
}

function addOutput(hex: string, script: Uint8Array, amount: bigint): string {
  const tx = parse(hex)
  tx.addOutput({ script, amount })
  return bytesToHex(tx.toPSBT())
}

const scriptOf = (a: string) => btc.OutScript.encode(btc.Address(btc.NETWORK).decode(a))

describe('offer escrow', () => {
  it('rebuilds the server escrow script with the pinned co-signer', () => {
    expect(bytesToHex(offerEscrow(buyer.publicKey, F.delay).script)).toBe(F.escrow_script)
  })

  it('pins the documented co-signer and NUMS key', () => {
    expect(OW_COSIGNER_XONLY.startsWith('1d08b7c7')).toBe(true)
    expect(OW_COSIGNER_XONLY.endsWith('7dee')).toBe(true)
    expect(NUMS_INTERNAL_KEY).toBe(bytesToHex(btc.TAPROOT_UNSPENDABLE_KEY))
  })

  it('depends on the recovery delay', () => {
    expect(bytesToHex(offerEscrow(buyer.publicKey, F.delay + 1).script)).not.toBe(F.escrow_script)
  })

  it('expected sighash per scope', () => {
    expect(expectedPresignSighash('item')).toBe(0x01)
    expect(expectedPresignSighash('collection')).toBe(0x82)
    expect(expectedPresignSighash('trait')).toBe(0x82)
  })
})

describe('buyer pre-signature', () => {
  it('signs only the escrow leaf input with SIGHASH_ALL for item offers', async () => {
    const signed = parse(signOfferPresign(F.accept_psbt, presign))
    const inp = signed.getInput(1)
    expect(inp.tapScriptSig).toHaveLength(1)
    const [key, sig] = inp.tapScriptSig![0]
    expect(bytesToHex(key.pubKey)).toBe(bytesToHex(buyer.xOnlyPublicKey))
    expect(sig).toHaveLength(65)
    expect(sig[64]).toBe(0x01)
    expect(signed.getInput(0).tapKeySig).toBeUndefined()
    expect(signed.getInput(0).finalScriptWitness).toBeUndefined()

    const escrow = offerEscrow(buyer.publicKey, F.delay)
    const prevScripts = [0, 1].map((i) => signed.getInput(i).witnessUtxo!.script)
    const amounts = [0, 1].map((i) => signed.getInput(i).witnessUtxo!.amount)
    const msg = signed.preimageWitnessV1(1, prevScripts, 0x01, amounts, undefined, escrow.saleLeaf, 0xc0)
    expect(await secp.schnorr.verify(sig.slice(0, 64), msg, buyer.xOnlyPublicKey)).toBe(true)
  })

  it('signs collection/trait templates with 0x82', () => {
    const signed = parse(
      signOfferPresign(F.scope_psbt, {
        privateKey: buyer.privateKey,
        scope: 'collection',
        signInputIndex: 0,
        sighash: 0x82,
        recoveryDelayBlocks: F.delay,
        escrowValue: F.escrow_value,
      }),
    )
    const sig = signed.getInput(0).tapScriptSig![0][1]
    expect(sig[64]).toBe(0x82)
  })

  it('refuses a sighash that is not 0x01/0x82', () => {
    expect(() => signOfferPresign(F.accept_psbt, { ...presign, sighash: 0x83 })).toThrow(OfferVerificationError)
    expect(verifyPresignPsbt(F.accept_psbt, { ...presign, sighash: 0x83 }).join()).toMatch(/not 0x01 or 0x82/)
  })

  it('refuses ANYONECANPAY on an item offer', () => {
    expect(verifyPresignPsbt(F.accept_psbt, { ...presign, sighash: 0x82 }).join()).toMatch(/does not match item/)
  })

  it('refuses 0x01 on a collection offer', () => {
    const p = verifyPresignPsbt(F.scope_psbt, {
      privateKey: buyer.privateKey,
      scope: 'trait',
      signInputIndex: 0,
      sighash: 0x01,
      recoveryDelayBlocks: F.delay,
      escrowValue: F.escrow_value,
    })
    expect(p.join()).toMatch(/does not match trait/)
  })

  it('refuses an escrow built with another co-signer', () => {
    expect(verifyPresignPsbt(F.bad_cosigner_accept_psbt, presign).join()).toMatch(/pinned co-signer/)
  })

  it('refuses a template that pays the seller more than agreed', () => {
    const bad = mutateOutput(F.accept_psbt, 1, { amount: BigInt(F.price_sats + 1) })
    expect(verifyPresignPsbt(bad, presign).join()).toMatch(/seller output/)
  })

  it('refuses a template that delivers the item elsewhere', () => {
    const bad = mutateOutput(F.accept_psbt, 0, { script: scriptOf(sellerAddr) })
    expect(verifyPresignPsbt(bad, presign).join()).toMatch(/does not deliver the item/)
  })

  it('refuses the wrong input index', () => {
    expect(verifyPresignPsbt(F.accept_psbt, { ...presign, signInputIndex: 0 }).length).toBeGreaterThan(0)
  })
})

describe('seller accept verification', () => {
  it('accepts the server template', () => {
    expect(verifyAcceptPsbt(F.accept_psbt, acceptExpect)).toEqual([])
  })

  it('signs input 0 only, key path, SIGHASH_ALL', () => {
    const signed = parse(signAcceptPsbt(F.accept_psbt, seller.privateKey, acceptExpect))
    const w = signed.getInput(0).finalScriptWitness!
    expect(w).toHaveLength(1)
    expect(w[0]).toHaveLength(65)
    expect(w[0][64]).toBe(0x01)
    expect(signed.getInput(1).tapScriptSig ?? []).toHaveLength(0)
    expect(signed.getInput(1).finalScriptWitness).toBeUndefined()
  })

  it('refuses when input 0 is not my item', () => {
    const p = verifyAcceptPsbt(F.accept_psbt, { ...acceptExpect, inscriptionOutpoint: `${'00'.repeat(32)}:0` })
    expect(p.join()).toMatch(/not your item/)
  })

  it('refuses when I am paid less than the price', () => {
    const p = verifyAcceptPsbt(F.accept_psbt, { ...acceptExpect, priceSats: F.price_sats + 1 })
    expect(p.join()).toMatch(/no output pays you/)
  })

  it('refuses when the payment goes elsewhere', () => {
    const bad = mutateOutput(F.accept_psbt, 1, { script: scriptOf(buyerAddr) })
    expect(verifyAcceptPsbt(bad, acceptExpect).join()).toMatch(/no output pays you/)
  })

  it('refuses when the item output is short (inscription could leak)', () => {
    const bad = mutateOutput(F.accept_psbt, 0, { amount: 330n })
    expect(verifyAcceptPsbt(bad, acceptExpect).join()).toMatch(/whole item/)
  })

  it('refuses when the item goes back to me or to a non-buyer', () => {
    const bad = mutateOutput(F.accept_psbt, 0, { script: scriptOf(sellerAddr) })
    expect(verifyAcceptPsbt(bad, acceptExpect).join()).toMatch(/returns the item to you/)
    const other = 'bc1pss0zhytly75awhm6x2hhvd5lnzv3vssgrf9axfheq8ldyzn88ges79fler'
    const bad2 = mutateOutput(F.accept_psbt, 0, { script: scriptOf(other) })
    expect(verifyAcceptPsbt(bad2, acceptExpect).join()).toMatch(/offer buyer/)
  })

  it('refuses without a marketplace fee output, or with two', () => {
    const none = mutateOutput(F.accept_psbt, 2, { script: scriptOf(buyerAddr) })
    expect(verifyAcceptPsbt(none, acceptExpect).join()).toMatch(/exactly one marketplace fee/)
    const two = addOutput(F.accept_psbt, scriptOf(OW_MARKET_FEE_ADDRESS), 1000n)
    expect(verifyAcceptPsbt(two, acceptExpect).join()).toMatch(/exactly one marketplace fee/)
  })

  it('allows one buyer-change output but not two extras', () => {
    const change = addOutput(F.accept_psbt, scriptOf(buyerAddr), 5000n)
    expect(verifyAcceptPsbt(change, { ...acceptExpect, buyerPaymentAddress: buyerAddr })).toEqual([])
    const other = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
    expect(verifyAcceptPsbt(change, { ...acceptExpect, buyerPaymentAddress: other }).join()).toMatch(/not buyer change/)
    const two = addOutput(change, scriptOf(other), 5000n)
    expect(verifyAcceptPsbt(two, acceptExpect).join()).toMatch(/unexpected extra outputs/)
  })

  it('refuses a non-ALL sighash on input 0', () => {
    const tx = parse(F.accept_psbt)
    tx.updateInput(0, { sighashType: 0x83 }, true)
    expect(verifyAcceptPsbt(bytesToHex(tx.toPSBT()), acceptExpect).join()).toMatch(/only SIGHASH_ALL/)
  })

  it('signAcceptPsbt throws and signs nothing on a bad PSBT', () => {
    expect(() =>
      signAcceptPsbt(F.accept_psbt, seller.privateKey, { ...acceptExpect, priceSats: F.price_sats * 2 }),
    ).toThrow(OfferVerificationError)
  })
})

describe('buyer cancel', () => {
  const cancel = {
    privateKey: buyer.privateKey,
    buyerPaymentAddress: buyerAddr,
    escrowValue: F.escrow_value,
    recoveryDelayBlocks: F.delay,
  }

  it('signs the refund on the escrow leaf', () => {
    const signed = parse(signOfferCancel(F.cancel_psbt, cancel))
    expect(signed.getInput(0).tapScriptSig![0][1][64]).toBe(0x01)
  })

  it('refuses a refund to another address or with an excessive fee', () => {
    expect(verifyCancelPsbt(F.cancel_psbt, { ...cancel, buyerPaymentAddress: sellerAddr }).join()).toMatch(
      /not go to your payment address/,
    )
    expect(verifyCancelPsbt(F.cancel_psbt, { ...cancel, maxMinerFeeSats: 100 }).join()).toMatch(/exceeds max/)
  })
})

describe('buyer funding', () => {
  const buyerInfo = publicKeyToP2TR(buyer.publicKey)
  const escrow = offerEscrow(buyer.publicKey, F.delay)

  function fundingPsbt(outputs: { script: Uint8Array; amount: bigint }[]): string {
    const tx = new btc.Transaction({ allowUnknownOutputs: true })
    tx.addInput({
      txid: '11'.repeat(32),
      index: 0,
      witnessUtxo: { script: buyerInfo.script, amount: 400_000n },
      tapInternalKey: buyer.xOnlyPublicKey,
    })
    for (const o of outputs) tx.addOutput(o)
    return bytesToHex(tx.toPSBT())
  }
  const expectF = {
    buyerPublicKey: buyer.publicKey,
    paymentAddress: buyerInfo.address,
    escrowValue: F.escrow_value,
    recoveryDelayBlocks: F.delay,
  }

  it('signs a funding PSBT that pays the escrow and returns change', () => {
    const psbt = fundingPsbt([
      { script: escrow.script, amount: BigInt(F.escrow_value) },
      { script: buyerInfo.script, amount: 400_000n - BigInt(F.escrow_value) - 500n },
    ])
    const signed = parse(signOfferFunding(psbt, buyer.privateKey, expectF))
    expect(signed.getInput(0).finalScriptWitness).toHaveLength(1)
  })

  it('refuses funding to a foreign output or wrong amount', () => {
    const foreign = fundingPsbt([
      { script: escrow.script, amount: BigInt(F.escrow_value) },
      { script: scriptOf(sellerAddr), amount: 1000n },
    ])
    expect(verifyFundingPsbt(foreign, expectF).join()).toMatch(/unexpected script/)
    const wrong = fundingPsbt([{ script: escrow.script, amount: BigInt(F.escrow_value + 1) }])
    expect(verifyFundingPsbt(wrong, expectF).join()).toMatch(/escrow output/)
    const noEscrow = fundingPsbt([{ script: buyerInfo.script, amount: 1000n }])
    expect(verifyFundingPsbt(noEscrow, expectF).join()).toMatch(/exactly one escrow output/)
  })

  it('enforces a max miner fee', () => {
    const psbt = fundingPsbt([{ script: escrow.script, amount: BigInt(F.escrow_value) }])
    expect(verifyFundingPsbt(psbt, { ...expectF, maxMinerFeeSats: 1000 }).join()).toMatch(/miner fee/)
  })
})
