import { describe, it, expect } from 'vitest'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keypairFromMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'
import {
  NUMS_INTERNAL_KEY_HEX,
  PINNED_COSIGNER_XONLY_HEX,
  PassthroughError,
  passthroughEscrow,
} from '../src/passthrough.js'
import {
  OPTS,
  seller,
  sellerXOnly,
  sellerAddress,
  attacker,
  ITEM,
  PRICE,
  script,
  escrowWith,
  templates,
  type TemplateOptions,
} from './passthrough-listing-fixtures.js'
import {
  RECOVERY_DELAY_BLOCKS,
  assertListingTemplates,
  assertRecoveryTemplate,
  assertSignedSaleTemplate,
  signListingTemplates,
  signRecovery,
  tapLeafHash,
} from '../src/passthrough-listing.js'

/**
 * Seller-side passthrough v4: templates are built here the way the API builds
 * them (passthrough_listing.rs), with throwaway keys only (the published
 * BIP-39 test mnemonic and constant byte patterns; none has held funds).
 */

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof PassthroughError) return err.code
    throw err
  }
  return 'accepted'
}

const listingCheck = (o: TemplateOptions = {}) => {
  const t = templates(o)
  return code(() =>
    assertListingTemplates({
      passthroughPsbtHex: t.passthroughPsbtHex,
      salePsbtHex: t.salePsbtHex,
      expectedOutpoint: ITEM,
      sellerXOnly,
      sellerAddress,
      expectedSellerSats: PRICE,
      assetAddress: sellerAddress,
    }),
  )
}

describe('assertListingTemplates', () => {
  it('accepts honest templates and derives the escrow locally', () => {
    const t = templates()
    const checked = assertListingTemplates({
      passthroughPsbtHex: t.passthroughPsbtHex,
      salePsbtHex: t.salePsbtHex,
      expectedOutpoint: ITEM,
      sellerXOnly,
      sellerAddress,
      expectedSellerSats: PRICE,
    })
    expect(checked.passthroughTxid).toBe(t.passthroughTxid)
    expect(checked.escrowValue).toBe(546)
    expect(bytesToHex(checked.escrow.script)).toBe(bytesToHex(passthroughEscrow(sellerXOnly).script))
  })

  it('accepts a passthrough that shaves exactly the 12-sat relay fee', () => {
    expect(listingCheck({ postage: 1_000, escrowValue: 988 })).toBe('accepted')
  })

  const refused: Array<[string, TemplateOptions, string]> = [
    ['an escrow co-signed by a key other than the pinned one', { cosigner: attacker.xOnly }, 'listing_escrow_mismatch'],
    ['a passthrough of a different item', { passthroughSpends: `${'cd'.repeat(32)}:0` }, 'listing_input_mismatch'],
    ['a passthrough with an extra output', { extraPassthroughOutput: true }, 'listing_output_shape'],
    ['a passthrough that takes more than the 12-sat fee', { postage: 1_000, escrowValue: 987 }, 'listing_postage_mismatch'],
    ['an escrow below the 330-sat dust floor', { postage: 329 }, 'listing_postage_mismatch'],
    ['a passthrough asking for SIGHASH_SINGLE|ANYONECANPAY', { passthroughSighash: 0x83 }, 'listing_sighash'],
    ['a passthrough asking for a script-path signature', { passthroughLeaf: true }, 'listing_script_path'],
    ['a sale template paying someone else', { salePayTo: attacker.address }, 'listing_payout_mismatch'],
    ['a sale template paying less than the price', { salePrice: PRICE - 1 }, 'listing_price_mismatch'],
    ['a sale template with an extra output', { saleExtraOutput: true }, 'sale_template_shape'],
    ['a sale template asking for SIGHASH_ALL', { saleSighash: 0x01 }, 'sale_template_sighash'],
    ['a sale template with a spendable internal key', { saleInternalKey: sellerXOnly }, 'sale_template_internal_key'],
    ['a sale template that also carries the recovery leaf', { saleExtraLeaf: true }, 'sale_template_leaf'],
    ['a sale template spending another output', { saleSpendsVout: 1 }, 'sale_template_input'],
  ]
  it.each(refused)('refuses %s', (_, opts, expected) => {
    expect(listingCheck(opts)).toBe(expected)
  })

  it('refuses an item that is not at our address', () => {
    const t = templates()
    expect(
      code(() =>
        assertListingTemplates({
          passthroughPsbtHex: t.passthroughPsbtHex,
          salePsbtHex: t.salePsbtHex,
          expectedOutpoint: ITEM,
          sellerXOnly,
          sellerAddress,
          expectedSellerSats: PRICE,
          assetAddress: attacker.address,
        }),
      ),
    ).toBe('listing_input_not_yours')
  })
})

describe('signListingTemplates', () => {
  const sign = (o: TemplateOptions = {}) => {
    const t = templates(o)
    return {
      t,
      signed: signListingTemplates({
        passthroughPsbtHex: t.passthroughPsbtHex,
        salePsbtHex: t.salePsbtHex,
        expectedOutpoint: ITEM,
        sellerAddress,
        expectedSellerSats: PRICE,
        assetAddress: sellerAddress,
        privateKey: seller.privateKey,
      }),
    }
  }

  it('signs the passthrough on the key path with SIGHASH_DEFAULT', async () => {
    const { t, signed } = sign()
    expect(signed.passthroughTxid).toBe(t.passthroughTxid)
    const tx = btc.Transaction.fromPSBT(hexToBytes(signed.psbt), OPTS)
    const input = tx.getInput(0)
    expect(input.tapKeySig?.length).toBe(64)
    expect(input.tapScriptSig).toBeUndefined()
    expect(input.finalScriptWitness).toBeUndefined()
    const digest = tx.preimageWitnessV1(0, [input.witnessUtxo!.script], btc.SigHash.DEFAULT, [input.witnessUtxo!.amount])
    const outputKey = input.witnessUtxo!.script.slice(2)
    expect(await secp.schnorr.verify(input.tapKeySig!, digest, outputKey)).toBe(true)
  })

  it('signs the sale on the sale leaf only, untweaked, with 0x83', async () => {
    const { t, signed } = sign()
    const tx = btc.Transaction.fromPSBT(hexToBytes(signed.salePsbt), OPTS)
    const input = tx.getInput(0)
    expect(input.tapKeySig).toBeUndefined()
    expect(input.tapScriptSig).toHaveLength(1)
    const [{ pubKey, leafHash }, sig] = input.tapScriptSig![0]
    expect(bytesToHex(pubKey)).toBe(bytesToHex(sellerXOnly))
    expect(bytesToHex(leafHash)).toBe(bytesToHex(tapLeafHash(t.escrow.leaf)))
    expect(sig).toHaveLength(65)
    expect(sig[64]).toBe(0x83)
    const digest = tx.preimageWitnessV1(0, [t.escrow.script], 0x83, [BigInt(t.escrowValue)], undefined, t.escrow.leaf, 0xc0)
    expect(await secp.schnorr.verify(sig.slice(0, 64), digest, sellerXOnly)).toBe(true)
  })

  it('refuses to sign tampered templates', () => {
    expect(code(() => sign({ cosigner: attacker.xOnly }))).toBe('listing_escrow_mismatch')
    expect(code(() => sign({ salePrice: PRICE - 1 }))).toBe('listing_price_mismatch')
    expect(code(() => sign({ saleSighash: 0x01 }))).toBe('sale_template_sighash')
  })
})

describe('assertSignedSaleTemplate', () => {
  const expectation = (t: ReturnType<typeof templates>) => ({
    sellerXOnly,
    passthroughTxid: t.passthroughTxid,
    escrowValue: t.escrowValue,
    sellerAddress,
    priceSats: PRICE,
  })
  const signedSale = () => {
    const t = templates()
    const s = signListingTemplates({
      passthroughPsbtHex: t.passthroughPsbtHex,
      salePsbtHex: t.salePsbtHex,
      expectedOutpoint: ITEM,
      sellerAddress,
      expectedSellerSats: PRICE,
      privateKey: seller.privateKey,
    })
    return { t, hex: s.salePsbt }
  }

  it('strips a stray key-path signature', () => {
    const { t, hex } = signedSale()
    const tx = btc.Transaction.fromPSBT(hexToBytes(hex), OPTS)
    tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0x09) }, true)
    const cleaned = assertSignedSaleTemplate(bytesToHex(tx.toPSBT()), expectation(t))
    expect(btc.Transaction.fromPSBT(hexToBytes(cleaned), OPTS).getInput(0).tapKeySig).toBeUndefined()
  })

  it('refuses an unsigned template, a forged signature and a wrong sighash byte', () => {
    const t = templates()
    expect(code(() => assertSignedSaleTemplate(t.salePsbtHex, expectation(t)))).toBe('sale_unsigned')

    const { hex } = signedSale()
    const tx = btc.Transaction.fromPSBT(hexToBytes(hex), OPTS)
    const [[key, sig]] = tx.getInput(0).tapScriptSig!
    const forged = sig.slice()
    forged[3] ^= 0x01
    tx.updateInput(0, { tapScriptSig: undefined }, true)
    tx.updateInput(0, { tapScriptSig: [[key, forged]] }, true)
    expect(code(() => assertSignedSaleTemplate(bytesToHex(tx.toPSBT()), expectation(t)))).toBe('sale_presignature_invalid')

    const wrongByte = sig.slice()
    wrongByte[64] = 0x01
    tx.updateInput(0, { tapScriptSig: undefined }, true)
    tx.updateInput(0, { tapScriptSig: [[key, wrongByte]] }, true)
    expect(code(() => assertSignedSaleTemplate(bytesToHex(tx.toPSBT()), expectation(t)))).toBe('sale_template_sighash')
  })

  it('refuses a signed template whose price changed', () => {
    const { t, hex } = signedSale()
    expect(code(() => assertSignedSaleTemplate(hex, { ...expectation(t), priceSats: PRICE + 1 }))).toBe('listing_price_mismatch')
  })
})

describe('recovery', () => {
  const PASSTHROUGH_TXID = 'ef'.repeat(32)
  const recoveryPsbt = (o: { sequence?: number; to?: string; fee?: number; cosigner?: Uint8Array; vout?: number } = {}) => {
    const escrow = escrowWith(o.cosigner ?? hexToBytes(PINNED_COSIGNER_XONLY_HEX))
    const tx = new btc.Transaction({ ...OPTS, allowUnknownInputs: true })
    tx.addInput({
      txid: PASSTHROUGH_TXID,
      index: o.vout ?? 0,
      sequence: o.sequence ?? RECOVERY_DELAY_BLOCKS,
      witnessUtxo: { script: escrow.script, amount: 1_000n },
      tapInternalKey: hexToBytes(NUMS_INTERNAL_KEY_HEX),
      tapLeafScript: [escrow.recoveryEntry],
      sighashType: 0x00,
    })
    tx.addOutput({ script: script(o.to ?? sellerAddress), amount: BigInt(1_000 - (o.fee ?? 141 * 2)) })
    return { hex: bytesToHex(tx.toPSBT()), escrow }
  }
  const check = (o: Parameters<typeof recoveryPsbt>[0] = {}) =>
    code(() =>
      assertRecoveryTemplate({
        psbtHex: recoveryPsbt(o).hex,
        passthroughTxid: PASSTHROUGH_TXID,
        sellerXOnly,
        destinationAddress: sellerAddress,
        feeRateSatVb: 2,
      }),
    )

  it('signs the recovery leaf and finalizes a spendable witness', async () => {
    const { hex, escrow } = recoveryPsbt()
    const out = signRecovery({
      psbtHex: hex,
      passthroughTxid: PASSTHROUGH_TXID,
      destinationAddress: sellerAddress,
      feeRateSatVb: 2,
      privateKey: seller.privateKey,
    })
    expect(out.feeSat).toBe(282)
    const tx = btc.Transaction.fromRaw(hexToBytes(out.rawtx), OPTS)
    expect(tx.id).toBe(out.txid)
    const witness = tx.getInput(0).finalScriptWitness!
    expect(witness).toHaveLength(3)
    expect(bytesToHex(witness[1])).toBe(bytesToHex(escrow.recovery))
    expect(bytesToHex(witness[2])).toBe(bytesToHex(btc.TaprootControlBlock.encode(escrow.recoveryEntry[0])))
    const unsigned = btc.Transaction.fromPSBT(hexToBytes(hex), OPTS)
    const digest = unsigned.preimageWitnessV1(0, [escrow.script], 0x00, [1_000n], undefined, escrow.recovery, 0xc0)
    expect(await secp.schnorr.verify(witness[0], digest, sellerXOnly)).toBe(true)
  })

  it('refuses tampered recoveries', () => {
    expect(check()).toBe('accepted')
    expect(check({ sequence: 1 })).toBe('recovery_sequence')
    expect(check({ to: attacker.address })).toBe('recovery_destination')
    expect(check({ fee: 200 * 2 })).toBe('recovery_fee')
    expect(check({ cosigner: attacker.xOnly })).toBe('recovery_prevout')
    expect(check({ vout: 1 })).toBe('recovery_input')
    expect(check({ fee: 141 * 2 + 400 })).toBe('recovery_fee')
  })
})
