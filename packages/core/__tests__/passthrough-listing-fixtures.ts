/**
 * Seller-side passthrough v4 templates built the way the API builds them
 * (passthrough_listing.rs), honest by default and tampered one named way per
 * option. Throwaway keys only: the published BIP-39 test mnemonic and
 * constant byte patterns; none has held funds.
 */
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keypairFromMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'
import { NUMS_INTERNAL_KEY_HEX, PINNED_COSIGNER_XONLY_HEX } from '../src/passthrough.js'

export const OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, allowLegacyWitnessUtxo: true }
export const seller = keypairFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
export const sellerXOnly = seller.xOnlyPublicKey
export const sellerAddress = publicKeyToP2TR(seller.publicKey).address
export const attacker = (() => {
  const xOnly = secp.schnorr.getPublicKey(new Uint8Array(32).fill(0x07))
  return { xOnly, address: btc.p2tr(xOnly).address! }
})()
export const ITEM = `${'ab'.repeat(32)}:1`
export const PRICE = 50_000

export function script(address: string): Uint8Array {
  return btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address))
}

export function escrowWith(cosigner: Uint8Array) {
  const leaf = new Uint8Array([0x20, ...sellerXOnly, 0xac, 0x20, ...cosigner, 0xba, 0x52, 0x9c])
  const recovery = new Uint8Array([0x02, 0x90, 0x00, 0xb2, 0x75, 0x20, ...sellerXOnly, 0xac])
  const payment = btc.p2tr(hexToBytes(NUMS_INTERNAL_KEY_HEX), [{ script: leaf }, { script: recovery }], btc.NETWORK, true)
  const entry = (s: Uint8Array) => payment.tapLeafScript!.find(([, x]) => bytesToHex(x.slice(0, -1)) === bytesToHex(s))!
  return { script: payment.script, leaf, recovery, saleEntry: entry(leaf), recoveryEntry: entry(recovery) }
}

export interface TemplateOptions {
  cosigner?: Uint8Array
  postage?: number
  escrowValue?: number
  passthroughSighash?: number
  passthroughSpends?: string
  passthroughLeaf?: boolean
  extraPassthroughOutput?: boolean
  saleSighash?: number
  salePayTo?: string
  salePrice?: number
  saleExtraOutput?: boolean
  saleInternalKey?: Uint8Array
  saleExtraLeaf?: boolean
  saleSpendsVout?: number
}

export function templates(o: TemplateOptions = {}) {
  const escrow = escrowWith(o.cosigner ?? hexToBytes(PINNED_COSIGNER_XONLY_HEX))
  const postage = o.postage ?? 546
  const escrowValue = o.escrowValue ?? postage
  const [txid, vout] = (o.passthroughSpends ?? ITEM).split(':')

  const passthrough = new btc.Transaction(OPTS)
  passthrough.addInput({
    txid,
    index: Number(vout),
    witnessUtxo: { script: script(sellerAddress), amount: BigInt(postage) },
    tapInternalKey: sellerXOnly,
    sighashType: o.passthroughSighash ?? 0x00,
    ...(o.passthroughLeaf ? { tapLeafScript: [escrow.recoveryEntry] } : {}),
  })
  passthrough.addOutput({ script: escrow.script, amount: BigInt(escrowValue) })
  if (o.extraPassthroughOutput) passthrough.addOutput({ script: script(attacker.address), amount: 1_000n })
  const passthroughTxid = bytesToHex(sha256(sha256(passthrough.toBytes(true, false))).reverse())

  const sale = new btc.Transaction(OPTS)
  sale.addInput({
    txid: passthroughTxid,
    index: o.saleSpendsVout ?? 0,
    witnessUtxo: { script: escrow.script, amount: BigInt(escrowValue) },
    tapInternalKey: o.saleInternalKey ?? hexToBytes(NUMS_INTERNAL_KEY_HEX),
    tapLeafScript: o.saleExtraLeaf ? [escrow.saleEntry, escrow.recoveryEntry] : [escrow.saleEntry],
    sighashType: o.saleSighash ?? 0x83,
  })
  sale.addOutput({ script: script(o.salePayTo ?? sellerAddress), amount: BigInt(o.salePrice ?? PRICE) })
  if (o.saleExtraOutput) sale.addOutput({ script: script(attacker.address), amount: 1_000n })

  return {
    passthroughPsbtHex: bytesToHex(passthrough.toPSBT()),
    salePsbtHex: bytesToHex(sale.toPSBT()),
    passthroughTxid,
    escrowValue,
    escrow,
  }
}

