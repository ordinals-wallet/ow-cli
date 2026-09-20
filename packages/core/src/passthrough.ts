import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from './signer.js'
import { publicKeyToP2TR } from './address.js'

/**
 * Passthrough v4 (snipe-protected listings), buyer side.
 *
 * Nothing here trusts the API. Before the wallet signs anything, the sale is
 * checked against the listings the buyer chose, the co-signer key pinned in
 * this build, and the buyer's own address. The buyer then signs ONLY its own
 * inputs, with SIGHASH_DEFAULT or SIGHASH_ALL, and leaves the PSBT unfinalized
 * so the marketplace can co-sign the escrow input and submit the package.
 *
 * This is a port of the wallet frontend's `verifySale` / `verifySaleChain` /
 * `verifySetup`, plus explicit spend caps.
 */

/**
 * The Ordinals Wallet co-signer key, pinned in the build. The API publishes it
 * too, but a client that took the API's word for it could be pointed at an
 * escrow only an attacker can co-sign. Rotating it requires a CLI release.
 */
export const PINNED_COSIGNER_XONLY_HEX = '1d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7dee'

/** BIP-341's provably unspendable internal key: the escrow has no key path. */
export const NUMS_INTERNAL_KEY_HEX = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

/** Where the marketplace fee is paid. Pinned for the same reason as the co-signer. */
export const MARKET_FEE_ADDRESS = 'bc1p6yd49679azsaxqgtr52ff6jjvj2wv5dlaqwhaxarkamevgle2jaqs8vlnr'

export const PASSTHROUGH_POLICY = 'passthrough_v4'
export const TAPSCRIPT_LEAF_VERSION = 0xc0
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83
/** The API refuses longer chains; so do we, before asking. */
export const MAX_PROTECTED_ITEMS_PER_PURCHASE = 12

/** Sighash types the buyer will sign with: DEFAULT and ALL. Nothing else. */
const BUYER_SIGHASHES = [0x00, 0x01]
/** Ceiling on one sale's size when capping its network fee (a link is ~600 vB with its parent). */
const MAX_SALE_VBYTES = 1500
/** Ceiling on creator royalties, as a share of the listed prices. */
export const MAX_CREATOR_ROYALTY_BPS = 1000
const RECOVERY_DELAY_BLOCKS_LE = [0x90, 0x00] // 144, minimally encoded

const PSBT_OPTS = { allowLegacyWitnessUtxo: true, allowUnknownOutputs: true, allowUnknownInputs: true }

export class PassthroughError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'PassthroughError'
  }
}

function fail(code: string, message: string): never {
  throw new PassthroughError(code, message)
}

function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function parsePsbt(hex: string, what: string): btc.Transaction {
  try {
    return btc.Transaction.fromPSBT(hexToBytes(hex), PSBT_OPTS)
  } catch {
    return fail('invalid_psbt', `${what} is not a valid PSBT`)
  }
}

/** txid of a transaction whose inputs are all native segwit (witness-stripped double-SHA256). */
function txidOf(tx: btc.Transaction): string {
  const hash = sha256(sha256(tx.toBytes(true, false)))
  return bytesToHex(hash.reverse())
}

/** The txid a PSBT will have once signed. Valid because every input we accept is native segwit. */
export function unsignedTxid(psbtHex: string): string {
  return txidOf(parsePsbt(psbtHex, 'Transaction'))
}

function outpointOf(tx: btc.Transaction, index: number): string {
  const input = tx.getInput(index)
  if (!input.txid || input.index === undefined) fail('invalid_psbt', `Input ${index} has no outpoint`)
  return `${bytesToHex(input.txid!)}:${input.index}`
}

function scriptForAddress(address: string): Uint8Array {
  try {
    return btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address))
  } catch {
    return fail('invalid_address', `Not a valid mainnet address: ${address}`)
  }
}

// ---- escrow -------------------------------------------------------------------

export interface PassthroughEscrow {
  /** Sale leaf: `<S> OP_CHECKSIG <C> OP_CHECKSIGADD OP_2 OP_NUMEQUAL` */
  leaf: Uint8Array
  /** Recovery leaf: `<144> OP_CHECKSEQUENCEVERIFY OP_DROP <S> OP_CHECKSIG` */
  recoveryLeaf: Uint8Array
  /** scriptPubKey of `tr(NUMS, {leaf, recoveryLeaf})` */
  script: Uint8Array
  address: string
}

/** Rebuild a listing's escrow locally from the seller key and the pinned co-signer. */
export function passthroughEscrow(
  sellerXOnly: Uint8Array,
  cosignerXOnly: Uint8Array = hexToBytes(PINNED_COSIGNER_XONLY_HEX),
): PassthroughEscrow {
  if (sellerXOnly.length !== 32 || cosignerXOnly.length !== 32) {
    fail('invalid_public_key', 'Escrow keys must be x-only')
  }
  if (equal(sellerXOnly, cosignerXOnly)) {
    fail('escrow_keys_identical', 'Seller and co-signer keys must be distinct')
  }
  const leaf = concat(
    Uint8Array.of(0x20), sellerXOnly, Uint8Array.of(0xac),
    Uint8Array.of(0x20), cosignerXOnly, Uint8Array.of(0xba, 0x52, 0x9c),
  )
  const recoveryLeaf = concat(
    Uint8Array.of(RECOVERY_DELAY_BLOCKS_LE.length, ...RECOVERY_DELAY_BLOCKS_LE, 0xb2, 0x75, 0x20),
    sellerXOnly,
    Uint8Array.of(0xac),
  )
  try {
    const payment = btc.p2tr(
      hexToBytes(NUMS_INTERNAL_KEY_HEX),
      [{ script: leaf }, { script: recoveryLeaf }],
      btc.NETWORK,
      true,
    )
    return { leaf, recoveryLeaf, script: payment.script, address: payment.address! }
  } catch {
    return fail('invalid_public_key', 'Seller key is not a valid Taproot key')
  }
}

/** Both x-only keys of a `multi_a(2, S, C)` leaf, or null if the script is not exactly one. */
export function parsePassthroughLeaf(leaf: Uint8Array): { seller: Uint8Array; cosigner: Uint8Array } | null {
  if (leaf.length !== 70) return null
  if (leaf[0] !== 0x20 || leaf[33] !== 0xac || leaf[34] !== 0x20) return null
  if (leaf[67] !== 0xba || leaf[68] !== 0x52 || leaf[69] !== 0x9c) return null
  return { seller: leaf.slice(1, 33), cosigner: leaf.slice(35, 67) }
}

// ---- verification -------------------------------------------------------------

export interface SaleParent {
  txid: string
  raw: string
  source_outpoint?: string
}

export interface SaleListing {
  /** The outpoint the buyer chose. */
  outpoint: string
  sellerAddress: string
  creatorAddress?: string | null
  /** Buyer-facing price: seller payout + marketplace fee must not exceed it. */
  satoshiPrice: number
}

export interface SaleVerification {
  sellerProceedsSat: number
  marketFeeSat: number
  creatorRoyaltySat: number
  networkFeeSat: number
  changeSat: number
  /** Input index of the passthrough (escrow) input. Never signed by the buyer. */
  passthroughInput: number
  /** Output index where the item lands in the buyer's wallet. */
  assetOutput: number
  /** The only inputs the buyer signs. */
  buyerInputs: number[]
  saleTxid: string
}

function maxNetworkFee(feeRateSatVb: number): number {
  return Math.ceil(MAX_SALE_VBYTES * Math.max(feeRateSatVb, 1))
}

/**
 * Verify one single-item sale before the buyer signs anything.
 *
 * A parent that spends exactly the chosen outpoint into an escrow whose leaf
 * names the pinned co-signer; a sale input spending that parent's output 0;
 * the output at the same index paying the listing's seller; an asset output
 * paying this buyer the escrow value, positioned so the sats line up; buyer
 * inputs only at the ends; every other output either the marketplace fee, the
 * listed creator's royalty, or the buyer's change; a network fee within cap.
 */
export function verifySale(input: {
  salePsbtHex: string
  parent: SaleParent
  listing: SaleListing
  buyerAddress: string
  feeRateSatVb: number
  marketFeeAddress?: string
  /** Chained sale: every buyer input must spend this earlier transaction. */
  fundingTxid?: string
  /** The first link of a chain carries the marketplace fee; later links do not. */
  carriesMarketFee?: boolean
}): SaleVerification {
  const sale = parsePsbt(input.salePsbtHex, 'Sale')
  const buyerScript = scriptForAddress(input.buyerAddress)
  const marketScript = scriptForAddress(input.marketFeeAddress || MARKET_FEE_ADDRESS)
  const sellerScript = scriptForAddress(input.listing.sellerAddress)
  const creatorScript = input.listing.creatorAddress ? scriptForAddress(input.listing.creatorAddress) : null
  const cosigner = hexToBytes(PINNED_COSIGNER_XONLY_HEX)
  const ownedByBuyer = (script?: Uint8Array) => equal(script, buyerScript)

  if (sale.inputsLength < 3) {
    fail('sale_input_count', 'Sale must spend the passthrough plus at least two of your funding inputs')
  }

  let parent: btc.Transaction
  try {
    parent = btc.Transaction.fromRaw(hexToBytes(input.parent.raw), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    })
  } catch {
    return fail('invalid_parent', 'Passthrough transaction could not be parsed')
  }
  const parentTxid = txidOf(parent)
  if (parentTxid !== input.parent.txid.toLowerCase()) {
    fail('parent_txid_mismatch', 'The passthrough does not hash to its declared txid')
  }

  const inputValues: number[] = []
  for (let i = 0; i < sale.inputsLength; i++) {
    const utxo = sale.getInput(i).witnessUtxo
    if (!utxo) fail('missing_witness_utxo', `Sale input ${i} is missing its prevout`)
    inputValues.push(Number(utxo!.amount))
  }
  const outputs: Array<{ script: Uint8Array; value: number }> = []
  for (let i = 0; i < sale.outputsLength; i++) {
    const o = sale.getOutput(i)
    if (!o.script || o.amount === undefined) fail('invalid_psbt', `Sale output ${i} is malformed`)
    outputs.push({ script: o.script!, value: Number(o.amount) })
  }

  // Layout: leading buyer inputs, the passthrough, trailing buyer inputs.
  const indexes = Array.from({ length: sale.inputsLength }, (_, i) => i)
  const isPassthrough = (i: number) => outpointOf(sale, i).split(':')[0] === parentTxid
  const index = indexes.findIndex(isPassthrough)
  if (index < 1) {
    fail('sale_input_count', 'Sale must start with at least one of your funding inputs')
  }
  if (index + 1 >= sale.inputsLength) {
    fail('sale_input_count', 'Sale must end with at least one of your fee inputs')
  }
  const buyerInputs = indexes.filter((i) => i !== index)
  for (const i of buyerInputs) {
    const data = sale.getInput(i)
    if (!ownedByBuyer(data.witnessUtxo?.script)) {
      fail('funding_not_yours', `Sale input ${i} is not one of your UTXOs`)
    }
    if (data.finalScriptWitness || data.finalScriptSig?.length) {
      fail('funding_prefilled', 'Your funding input already carries a witness')
    }
    if (data.sighashType !== undefined && !BUYER_SIGHASHES.includes(data.sighashType)) {
      fail(
        'buyer_sighash',
        `Asked to sign input ${i} with sighash 0x${data.sighashType.toString(16).padStart(2, '0')}; a purchase only ever uses SIGHASH_ALL`,
      )
    }
    if (input.fundingTxid && outpointOf(sale, i).split(':')[0] !== input.fundingTxid.toLowerCase()) {
      fail('chain_funding_mismatch', `Sale input ${i} does not spend the previous transaction in this purchase`)
    }
  }

  // The passthrough input.
  const data = sale.getInput(index)
  if (outpointOf(sale, index) !== `${parentTxid}:0`) {
    fail('sale_input_not_passthrough', `Sale input ${index} does not spend a passthrough`)
  }
  if (parent.inputsLength !== 1 || parent.outputsLength !== 1 ||
    outpointOf(parent, 0) !== input.listing.outpoint.toLowerCase()) {
    fail('parent_source_mismatch', 'The passthrough does not move the item you selected')
  }
  const escrowOut = parent.getOutput(0)
  const escrowValue = Number(escrowOut.amount)
  if (!data.witnessUtxo || !equal(data.witnessUtxo.script, escrowOut.script) ||
    Number(data.witnessUtxo.amount) !== escrowValue) {
    fail('sale_prevout_mismatch', `Sale input ${index} misstates its passthrough prevout`)
  }
  // Either already co-signed (complete 2-of-2 witness) or carrying the leaf
  // for the marketplace to co-sign at submit. Either way the leaf must name
  // the pinned co-signer and the prevout must be the escrow that leaf implies.
  let leaf: Uint8Array
  const witness = data.finalScriptWitness
  if (witness) {
    if (witness.length !== 4) {
      fail('sale_witness_shape', `Sale input ${index} witness is not a 2-of-2 script path`)
    }
    const [cosig, sellersig] = witness
    leaf = witness[2]
    if (cosig.length !== 64 || sellersig.length !== 65 || sellersig[64] !== SIGHASH_SINGLE_ANYONECANPAY) {
      fail('sale_witness_sighash', `Sale input ${index} signatures have unexpected sighash types`)
    }
  } else {
    const entry = (data.tapLeafScript || []).find(([, scriptWithVersion]) => {
      const version = scriptWithVersion[scriptWithVersion.length - 1]
      return version === TAPSCRIPT_LEAF_VERSION && parsePassthroughLeaf(scriptWithVersion.slice(0, -1)) !== null
    })
    if (!entry) {
      return fail('sale_not_cosigned', `Sale input ${index} carries neither a co-signed witness nor its escrow leaf`)
    }
    leaf = entry[1].slice(0, -1)
    if (!equal(data.tapInternalKey, hexToBytes(NUMS_INTERNAL_KEY_HEX))) {
      fail('sale_template_internal_key', `Sale input ${index} does not use the unspendable escrow key`)
    }
  }
  const keys = parsePassthroughLeaf(leaf)
  if (!keys || !equal(keys.cosigner, cosigner)) {
    return fail('sale_leaf_unpinned', `Sale input ${index} is not co-signed by Ordinals Wallet's pinned key`)
  }
  if (!equal(passthroughEscrow(keys.seller, keys.cosigner).script, escrowOut.script)) {
    fail('sale_escrow_mismatch', 'The passthrough escrow does not match its leaf')
  }

  // Payout at the same index as the passthrough input.
  const payout = outputs[index]
  if (!payout || !equal(payout.script, sellerScript)) {
    fail('sale_payout_mismatch', `Sale output ${index} does not pay the seller of the item`)
  }
  // Asset output at the same sat offset as the passthrough's first sat, so
  // the inscription's sats land in it.
  const inOffset = inputValues.slice(0, index).reduce((a, b) => a + b, 0)
  let running = 0
  const outOffsets = outputs.map((o) => {
    const at = running
    running += o.value
    return at
  })
  const assetOutput = outOffsets.findIndex((offset, oi) => offset === inOffset && oi > 1)
  const asset = assetOutput >= 0 ? outputs[assetOutput] : undefined
  if (!asset || asset.value !== escrowValue || !ownedByBuyer(asset.script)) {
    fail('sale_asset_mismatch', 'The item would not land in your wallet on its own sats')
  }

  // Every remaining output: marketplace fee, the listed creator's royalty, or our change.
  const buyerIsMarket = ownedByBuyer(marketScript)
  const carriesMarketFee = input.carriesMarketFee ?? true
  let marketFeeSat = 0
  let creatorRoyaltySat = 0
  let changeSat = 0
  let marketSeen = false
  outputs.forEach((o, oi) => {
    if (oi === assetOutput || oi === index) return
    if (oi === 0) {
      if (!ownedByBuyer(o.script)) fail('sale_change_mismatch', 'Sale output 0 is not your change')
      changeSat += o.value
      return
    }
    const isMarket = equal(o.script, marketScript)
    // When the buyer IS the marketplace address, script alone cannot tell fee
    // from change: the first such output is the fee, in the first link only.
    const isFee = isMarket && (!buyerIsMarket || (carriesMarketFee && !marketSeen))
    if (isFee) {
      marketFeeSat += o.value
      marketSeen = true
    } else if (creatorScript && equal(o.script, creatorScript) && !ownedByBuyer(o.script)) {
      creatorRoyaltySat += o.value
    } else if (ownedByBuyer(o.script)) {
      changeSat += o.value
    } else {
      fail('sale_unknown_output', `Sale output ${oi} pays an unexpected party`)
    }
  })

  const totalIn = inputValues.reduce((a, b) => a + b, 0)
  const totalOut = outputs.reduce((a, o) => a + o.value, 0)
  const networkFeeSat = totalIn - totalOut
  if (networkFeeSat <= 0) fail('sale_fee', 'Sale outputs exceed its inputs')
  if (networkFeeSat > maxNetworkFee(input.feeRateSatVb)) {
    fail(
      'sale_fee',
      `Sale network fee of ${networkFeeSat} sats is above the ${maxNetworkFee(input.feeRateSatVb)} sat cap for ${input.feeRateSatVb} sat/vB`,
    )
  }

  return {
    sellerProceedsSat: payout.value,
    marketFeeSat,
    creatorRoyaltySat,
    networkFeeSat,
    changeSat,
    passthroughInput: index,
    assetOutput,
    buyerInputs,
    saleTxid: txidOf(sale),
  }
}

export interface SetupVerification {
  txid: string
  feeSat: number
  buyerInputs: number[]
}

/**
 * The buyer's setup transaction: their own inputs into exactly two outputs at
 * their own address, which the first sale then spends. Nothing leaves the
 * wallet except the miner fee.
 */
export function verifySetup(input: {
  setupPsbtHex: string
  buyerAddress: string
  feeRateSatVb: number
}): SetupVerification {
  const setup = parsePsbt(input.setupPsbtHex, 'Setup transaction')
  const buyerScript = scriptForAddress(input.buyerAddress)
  if (setup.inputsLength === 0) fail('setup_input_not_yours', 'Setup transaction has no inputs')
  let totalIn = 0
  const buyerInputs: number[] = []
  for (let i = 0; i < setup.inputsLength; i++) {
    const data = setup.getInput(i)
    if (!data.witnessUtxo || !equal(data.witnessUtxo.script, buyerScript)) {
      fail('setup_input_not_yours', `Setup input ${i} is not one of your UTXOs`)
    }
    if (data.finalScriptWitness || data.finalScriptSig?.length) {
      fail('funding_prefilled', 'Setup input already carries a witness')
    }
    if (data.sighashType !== undefined && !BUYER_SIGHASHES.includes(data.sighashType)) {
      fail('buyer_sighash', `Asked to sign setup input ${i} with a sighash other than SIGHASH_ALL`)
    }
    totalIn += Number(data.witnessUtxo!.amount)
    buyerInputs.push(i)
  }
  if (setup.outputsLength !== 2) {
    fail('setup_output_shape', 'Setup transaction must have exactly two outputs')
  }
  let totalOut = 0
  for (let i = 0; i < 2; i++) {
    const o = setup.getOutput(i)
    if (!equal(o.script, buyerScript)) {
      fail('setup_output_not_yours', 'Setup transaction pays someone other than you')
    }
    totalOut += Number(o.amount)
  }
  const feeSat = totalIn - totalOut
  // ~58 vB per input + ~100 vB base, at the buyer's rate, with headroom.
  const maxFee = Math.ceil((100 + 58 * setup.inputsLength) * Math.max(input.feeRateSatVb, 1) * 1.5) + 50
  if (feeSat <= 0 || feeSat > maxFee) {
    fail('setup_fee', `Setup transaction fee of ${feeSat} sats is out of range (cap ${maxFee})`)
  }
  return { txid: txidOf(setup), feeSat, buyerInputs }
}

export interface SaleChainLink {
  saleTxid: string
  salePsbtHex: string
  parent: SaleParent
  listing: SaleListing
}

export interface SaleChainVerification {
  sellerProceedsSat: number
  marketFeeSat: number
  creatorRoyaltySat: number
  networkFeeSat: number
  setupFeeSat: number
  /** Everything the purchase costs: payouts, marketplace fee, royalties and miner fees. */
  totalSat: number
  links: SaleVerification[]
  setup?: SetupVerification
}

/**
 * A protected purchase is a chain of single-item sales. Each spends exactly
 * one zero-fee passthrough plus buyer inputs, which for every link after the
 * first are the previous link's outputs. The marketplace fee and royalties
 * sit in the first link only; listed prices are checked against the whole chain.
 */
export function verifyPassthroughPurchase(input: {
  links: SaleChainLink[]
  setup?: { txid: string; psbt: string }
  buyerAddress: string
  feeRateSatVb: number
  marketFeeAddress?: string
}): SaleChainVerification {
  if (input.links.length === 0) fail('invalid_sale', 'Sale has no items')
  if (input.links.length > MAX_PROTECTED_ITEMS_PER_PURCHASE) {
    fail('too_many_items', `Up to ${MAX_PROTECTED_ITEMS_PER_PURCHASE} protected items can be bought together`)
  }
  if (!Number.isFinite(input.feeRateSatVb) || input.feeRateSatVb <= 0) {
    fail('invalid_fee_rate', 'Fee rate must be a positive sat/vB value')
  }
  const chosen = new Set<string>()
  for (const link of input.links) {
    const price = link.listing.satoshiPrice
    if (!Number.isSafeInteger(price) || price <= 0) {
      fail('listing_price_unknown', 'Every item needs its listed price before a sale can be checked')
    }
    const outpoint = link.listing.outpoint.toLowerCase()
    if (chosen.has(outpoint)) fail('invalid_sale', 'The same listing appears twice in this purchase')
    chosen.add(outpoint)
  }

  let setup: SetupVerification | undefined
  if (input.setup) {
    setup = verifySetup({
      setupPsbtHex: input.setup.psbt,
      buyerAddress: input.buyerAddress,
      feeRateSatVb: input.feeRateSatVb,
    })
    if (setup.txid !== input.setup.txid.toLowerCase()) {
      fail('invalid_sale', 'Setup transaction does not hash to its declared txid')
    }
  }

  const links: SaleVerification[] = []
  let previous = setup?.txid
  for (const link of input.links) {
    const v = verifySale({
      salePsbtHex: link.salePsbtHex,
      parent: link.parent,
      listing: link.listing,
      buyerAddress: input.buyerAddress,
      feeRateSatVb: input.feeRateSatVb,
      marketFeeAddress: input.marketFeeAddress,
      fundingTxid: previous,
      carriesMarketFee: links.length === 0,
    })
    if (v.saleTxid !== link.saleTxid.toLowerCase()) {
      fail('invalid_sale', `Sale ${links.length + 1} does not hash to its declared txid`)
    }
    links.push(v)
    previous = v.saleTxid
  }

  const sum = (pick: (v: SaleVerification) => number) => links.reduce((a, v) => a + pick(v), 0)
  const sellerProceedsSat = sum((v) => v.sellerProceedsSat)
  const marketFeeSat = sum((v) => v.marketFeeSat)
  const creatorRoyaltySat = sum((v) => v.creatorRoyaltySat)
  const networkFeeSat = sum((v) => v.networkFeeSat)
  const listedSat = input.links.reduce((a, l) => a + l.listing.satoshiPrice, 0)
  if (sellerProceedsSat + marketFeeSat > listedSat) {
    fail(
      'sale_overcharge',
      `Sale charges ${sellerProceedsSat + marketFeeSat} sats for items listed at ${listedSat} sats`,
    )
  }
  const maxRoyalty = Math.ceil((listedSat * MAX_CREATOR_ROYALTY_BPS) / 10_000)
  if (creatorRoyaltySat > maxRoyalty) {
    fail('sale_royalty', `Creator royalties of ${creatorRoyaltySat} sats are above the ${maxRoyalty} sat cap`)
  }
  const setupFeeSat = setup?.feeSat ?? 0
  return {
    sellerProceedsSat,
    marketFeeSat,
    creatorRoyaltySat,
    networkFeeSat: networkFeeSat + setupFeeSat,
    setupFeeSat,
    totalSat: sellerProceedsSat + marketFeeSat + creatorRoyaltySat + networkFeeSat + setupFeeSat,
    links,
    setup,
  }
}

// ---- signing ------------------------------------------------------------------

function signatureState(tx: btc.Transaction, index: number): string {
  const data = tx.getInput(index)
  return JSON.stringify([
    data.tapKeySig ? bytesToHex(data.tapKeySig) : null,
    (data.tapScriptSig || []).map(([, sig]) => bytesToHex(sig)),
    (data.partialSig || []).map(([, sig]) => bytesToHex(sig)),
    (data.finalScriptWitness || []).map((w) => bytesToHex(w)),
  ])
}

/**
 * Sign exactly `indexes`, each of which must be our own key-path P2TR input,
 * with SIGHASH_DEFAULT or SIGHASH_ALL. Nothing is finalized: the marketplace
 * co-signs the escrow input and assembles the transaction. Every other input
 * must come out byte-for-byte as it went in.
 */
export function signOwnInputs(opts: {
  psbt: string
  indexes: number[]
  privateKey: Uint8Array
  publicKey: Uint8Array
}): string {
  const tx = parsePsbt(opts.psbt, 'Transaction')
  const { script } = publicKeyToP2TR(opts.publicKey)
  const xOnly = secp.schnorr.getPublicKey(opts.privateKey)
  const txidBefore = txidOf(tx)
  if (opts.indexes.length === 0) {
    fail('missing_buyer_input', 'Transaction spends none of this wallet\'s inputs; refusing to sign')
  }
  const others = Array.from({ length: tx.inputsLength }, (_, i) => i).filter((i) => !opts.indexes.includes(i))
  const before = others.map((i) => signatureState(tx, i))

  for (const i of opts.indexes) {
    const data = tx.getInput(i)
    if (!data.witnessUtxo || !equal(data.witnessUtxo.script, script)) {
      fail('funding_not_yours', `Input ${i} is not one of this wallet's UTXOs; refusing to sign it`)
    }
    if (data.sighashType !== undefined && !BUYER_SIGHASHES.includes(data.sighashType)) {
      fail('buyer_sighash', `Input ${i} asks for a sighash other than SIGHASH_ALL; refusing to sign it`)
    }
    if (data.tapLeafScript?.length) {
      fail('buyer_script_path', `Input ${i} asks for a script-path signature; refusing to sign it`)
    }
    tx.updateInput(i, { tapInternalKey: xOnly })
    let signed = false
    try {
      signed = tx.signIdx(opts.privateKey, i, BUYER_SIGHASHES)
    } catch (err) {
      fail('sign_failed', `Could not sign input ${i}: ${(err as Error).message}`)
    }
    const sig = tx.getInput(i).tapKeySig
    if (!signed || !sig) fail('sign_failed', `Could not sign input ${i}`)
    if (sig!.length === 65 && sig![64] !== 0x01) {
      fail('buyer_sighash', `Input ${i} was signed with an unexpected sighash`)
    }
  }

  others.forEach((i, position) => {
    if (signatureState(tx, i) !== before[position]) {
      fail('foreign_input_changed', `Input ${i} is not ours but changed while signing`)
    }
  })
  if (txidOf(tx) !== txidBefore) {
    fail('sale_mismatch', 'Transaction changed while signing')
  }
  return bytesToHex(tx.toPSBT())
}
