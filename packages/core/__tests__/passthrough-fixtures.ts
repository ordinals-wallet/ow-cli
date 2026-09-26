/**
 * Builds passthrough v4 build responses for tests: an honest one by default,
 * and one tampered with in a single, named way per option.
 *
 * Every key here is a throwaway: the buyer is the published BIP-39 test
 * mnemonic, the rest are constant byte patterns. None has ever held funds.
 */
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keypairFromMnemonic } from '../src/keys.js'
import { publicKeyToP2TR } from '../src/address.js'
import { bytesToHex, hexToBytes } from '../src/signer.js'
import {
  MARKET_FEE_ADDRESS,
  NUMS_INTERNAL_KEY_HEX,
  PINNED_COSIGNER_XONLY_HEX,
  type SaleListing,
  type SaleParent,
} from '../src/passthrough.js'

/** Re-exported so other packages' tests can parse PSBTs without their own dependency. */
export { btc }

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function party(fill: number) {
  const xOnly = secp.schnorr.getPublicKey(new Uint8Array(32).fill(fill))
  return { xOnly, address: btc.p2tr(xOnly).address! }
}

const buyerKeys = keypairFromMnemonic(TEST_MNEMONIC)

export const THROWAWAY = {
  buyer: { mnemonic: TEST_MNEMONIC, address: publicKeyToP2TR(buyerKeys.publicKey).address, publicKey: bytesToHex(buyerKeys.publicKey) },
  seller: party(0x01),
  creator: party(0x05),
  attacker: party(0x07),
}

const ESCROW_VALUE = 546
const OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, allowLegacyWitnessUtxo: true }

function script(address: string): Uint8Array {
  return btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address))
}

function txid(tx: btc.Transaction): string {
  return bytesToHex(sha256(sha256(tx.toBytes(true, false))).reverse())
}

function escrowFor(seller: Uint8Array, cosigner: Uint8Array) {
  const leaf = new Uint8Array([0x20, ...seller, 0xac, 0x20, ...cosigner, 0xba, 0x52, 0x9c])
  const recovery = new Uint8Array([0x02, 0x90, 0x00, 0xb2, 0x75, 0x20, ...seller, 0xac])
  const payment = btc.p2tr(hexToBytes(NUMS_INTERNAL_KEY_HEX), [{ script: leaf }, { script: recovery }], btc.NETWORK, true)
  const entry = payment.tapLeafScript!.find(([, s]) => bytesToHex(s.slice(0, -1)) === bytesToHex(leaf))!
  return { script: payment.script, leaf, entry }
}

export interface FixtureOptions {
  /** 1 or 2: distinct listings for chained purchases. */
  item?: number
  payout?: number
  marketFee?: number
  royalty?: number
  networkFee?: number
  payoutTo?: string
  assetTo?: string
  assetValue?: number
  changeTo?: string
  marketTo?: string
  changeOneDelta?: number
  extraOutput?: { to: string; value: number }
  cosigner?: Uint8Array
  leafSeller?: Uint8Array
  internalKey?: Uint8Array
  omitLeaf?: boolean
  cosigned?: boolean
  sellerSighash?: number
  parentSpends?: string
  declaredParentTxid?: string
  escrowPrevoutValue?: number
  buyerSighash?: number
  trailingOwner?: string
  prefilledWitness?: boolean
  noLeadingInput?: boolean
  noTrailingInput?: boolean
  /** Both funding inputs spend this transaction (a setup, or the previous sale). */
  fundingTxid?: string
  /** With `fundingTxid`: the outputs of it the two funding inputs spend (default 0 and 5: a previous sale's change). */
  fundingVouts?: [number, number]
  /** The listing's `escrow_price` the payout must equal; `null` leaves it unknown. Default 50,000. */
  listedEscrowPrice?: number | null
  /** Serve the parent seller-signed (the API used to); by default it is witness-stripped, as served now. */
  signedParent?: boolean
}

export interface Fixture {
  salePsbt: string
  saleTxid: string
  parent: SaleParent
  listing: SaleListing
}

export function buildFixture(o: FixtureOptions = {}): Fixture {
  const item = o.item ?? 1
  const payout = o.payout ?? 50_000
  const marketFee = o.marketFee ?? 1_350
  const royalty = o.royalty ?? 500
  const networkFee = o.networkFee ?? 1_000
  const buyer = script(THROWAWAY.buyer.address)
  const sourceOutpoint = `${'a'.repeat(62)}0${item}:0`
  const listing: SaleListing = {
    outpoint: sourceOutpoint,
    sellerAddress: THROWAWAY.seller.address,
    creatorAddress: THROWAWAY.creator.address,
    satoshiPrice: 51_350,
    escrowPriceSat: o.listedEscrowPrice === undefined ? 50_000 : o.listedEscrowPrice,
  }

  const escrow = escrowFor(THROWAWAY.seller.xOnly, o.cosigner ?? hexToBytes(PINNED_COSIGNER_XONLY_HEX))

  // The zero-fee passthrough: the seller's inscription UTXO into the escrow.
  const [spendsTxid, spendsVout] = (o.parentSpends ?? sourceOutpoint).split(':')
  const parentTx = new btc.Transaction(OPTS)
  parentTx.addInput({
    txid: spendsTxid,
    index: Number(spendsVout),
    witnessUtxo: { script: script(THROWAWAY.seller.address), amount: BigInt(ESCROW_VALUE) },
  })
  parentTx.addOutput({ script: escrow.script, amount: BigInt(ESCROW_VALUE) })
  const parentTxid = txid(parentTx)
  // The API serves the parent witness-stripped: same txid, not broadcastable.
  let raw = bytesToHex(parentTx.toBytes(true, false))
  if (o.signedParent) {
    parentTx.updateInput(0, { finalScriptWitness: [new Uint8Array(64).fill(0x11)] }, true)
    raw = bytesToHex(parentTx.toBytes(true, true))
  }
  const parent: SaleParent = {
    txid: o.declaredParentTxid ?? parentTxid,
    raw,
    source_outpoint: sourceOutpoint,
  }

  const leading = 100_000
  const trailing = 20_000
  const funding = (n: number, amount: number, owner: Uint8Array) => ({
    txid: o.fundingTxid ?? `${n}${n}`.repeat(32),
    index: o.fundingTxid ? (o.fundingVouts ?? [0, 5])[n === 1 ? 0 : 1] : n,
    witnessUtxo: { script: owner, amount: BigInt(amount) },
    ...(o.buyerSighash !== undefined ? { sighashType: o.buyerSighash } : {}),
  })
  const leafSource = o.leafSeller ? escrowFor(o.leafSeller, hexToBytes(PINNED_COSIGNER_XONLY_HEX)) : escrow
  const passthroughInput: Record<string, unknown> = {
    txid: parentTxid,
    index: 0,
    witnessUtxo: { script: escrow.script, amount: BigInt(o.escrowPrevoutValue ?? ESCROW_VALUE) },
  }
  // Witnesses go on after the outputs: the library refuses to extend a signed transaction.
  const witnesses: Array<[number, Uint8Array[]]> = []
  let cosignedWitness: Uint8Array[] | undefined
  if (o.cosigned) {
    cosignedWitness = [
      new Uint8Array(64).fill(0x22),
      new Uint8Array([...new Uint8Array(64).fill(0x33), o.sellerSighash ?? 0x83]),
      leafSource.leaf,
      btc.TaprootControlBlock.encode(leafSource.entry[0]),
    ]
  } else if (!o.omitLeaf) {
    passthroughInput.tapLeafScript = [leafSource.entry]
    passthroughInput.tapInternalKey = o.internalKey ?? hexToBytes(NUMS_INTERNAL_KEY_HEX)
    passthroughInput.sighashType = 0x83
  }

  const sale = new btc.Transaction(OPTS)
  const trailingOwner = o.trailingOwner ? script(o.trailingOwner) : buyer
  if (!o.noLeadingInput) sale.addInput(funding(1, leading, buyer))
  if (o.noTrailingInput) sale.addInput(funding(3, 1_000, buyer))
  if (cosignedWitness) witnesses.push([sale.inputsLength, cosignedWitness])
  sale.addInput(passthroughInput as never)
  if (o.prefilledWitness) witnesses.push([sale.inputsLength, [new Uint8Array(64).fill(0x44)]])
  if (!o.noTrailingInput) sale.addInput(funding(2, trailing, trailingOwner))
  if (o.noLeadingInput) sale.addInput(funding(3, 1_000, buyer))

  const change = o.changeTo ? script(o.changeTo) : buyer
  // Outputs 0 and 1 sum to the leading input, so the asset's first sat lines up with output 2.
  sale.addOutput({ script: change, amount: BigInt(leading - payout + (o.changeOneDelta ?? 0)) })
  sale.addOutput({ script: script(o.payoutTo ?? THROWAWAY.seller.address), amount: BigInt(payout) })
  sale.addOutput({ script: o.assetTo ? script(o.assetTo) : buyer, amount: BigInt(o.assetValue ?? ESCROW_VALUE) })
  if (marketFee > 0) sale.addOutput({ script: script(o.marketTo ?? MARKET_FEE_ADDRESS), amount: BigInt(marketFee) })
  if (royalty > 0) sale.addOutput({ script: script(THROWAWAY.creator.address), amount: BigInt(royalty) })
  if (o.extraOutput) sale.addOutput({ script: script(o.extraOutput.to), amount: BigInt(o.extraOutput.value) })
  const spent = marketFee + royalty + networkFee + (o.extraOutput?.value ?? 0)
  sale.addOutput({ script: buyer, amount: BigInt(trailing - spent) })
  for (const [index, finalScriptWitness] of witnesses) sale.updateInput(index, { finalScriptWitness }, true)

  return { salePsbt: bytesToHex(sale.toPSBT()), saleTxid: txid(sale), parent, listing }
}

export function buildSetup(o: {
  feeSat?: number
  secondOutputTo?: string
  thirdOutput?: boolean
  inputOwner?: string
  sighash?: number
} = {}): { psbt: string; txid: string; feeSat: number } {
  const buyer = script(THROWAWAY.buyer.address)
  const feeSat = o.feeSat ?? 900
  const tx = new btc.Transaction(OPTS)
  tx.addInput({
    txid: '99'.repeat(32),
    index: 0,
    witnessUtxo: { script: o.inputOwner ? script(o.inputOwner) : buyer, amount: 200_000n },
    ...(o.sighash !== undefined ? { sighashType: o.sighash } : {}),
  })
  tx.addOutput({ script: buyer, amount: 100_000n })
  const rest = 100_000 - feeSat - (o.thirdOutput ? 1_000 : 0)
  tx.addOutput({ script: o.secondOutputTo ? script(o.secondOutputTo) : buyer, amount: BigInt(rest) })
  if (o.thirdOutput) tx.addOutput({ script: buyer, amount: 1_000n })
  return { psbt: bytesToHex(tx.toPSBT()), txid: txid(tx), feeSat }
}
