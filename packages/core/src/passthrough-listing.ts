import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from './signer.js'
import {
  NUMS_INTERNAL_KEY_HEX,
  SIGHASH_SINGLE_ANYONECANPAY,
  TAPSCRIPT_LEAF_VERSION,
  equal,
  fail,
  outpointOf,
  parsePsbt,
  passthroughEscrow,
  scriptForAddress,
  txidOf,
  type PassthroughEscrow,
} from './passthrough.js'

/**
 * Passthrough v4 (snipe-protected listings), seller side.
 *
 * Listing signs two templates the API builds: the passthrough (the item's
 * UTXO into the seller's own escrow, key path, SIGHASH_ALL/DEFAULT) and the
 * sale template (that escrow paying the seller their price, script path,
 * SIGHASH_SINGLE|ANYONECANPAY). Both are checked against an escrow rebuilt
 * here from the seller's key and the pinned co-signer before anything is
 * signed. Nothing is broadcast by listing.
 *
 * Port of the wallet frontend's `assertListingTemplates` /
 * `sanitizeSignedSaleTemplate`, plus the recovery path.
 */

/** Taproot dust floor: protection needs at least this much postage. */
export const MIN_ESCROW_VALUE_SATS = 330
/** A passthrough may shave exactly this (0.1 sat/vB relay floor) off the postage. */
export const PASSTHROUGH_PARENT_FEE_SATS = 12
/** The recovery leaf's relative timelock. */
export const RECOVERY_DELAY_BLOCKS = 144
/** Size of the recovery transaction (one script-path input, one P2TR output). */
const RECOVERY_VBYTES = 141

const SELLER_PASSTHROUGH_SIGHASHES = [0x00, 0x01]

let hashesReady = false
function ensureSyncHashes(): void {
  if (hashesReady) return
  if (!secp.utils.sha256Sync) {
    secp.utils.sha256Sync = (...messages: Uint8Array[]) => sha256(secp.utils.concatBytes(...messages))
  }
  hashesReady = true
}

function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  return sha256(secp.utils.concatBytes(tagHash, tagHash, ...parts))
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  throw new Error('script too long')
}

/** BIP-341 leaf hash. */
export function tapLeafHash(script: Uint8Array, version = TAPSCRIPT_LEAF_VERSION): Uint8Array {
  return taggedHash('TapLeaf', Uint8Array.of(version), compactSize(script.length), script)
}

function schnorrSign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  ensureSyncHashes()
  return secp.schnorr.signSync(message, privateKey)
}

function schnorrVerify(signature: Uint8Array, message: Uint8Array, xOnly: Uint8Array): boolean {
  ensureSyncHashes()
  try {
    return secp.schnorr.verifySync(signature, message, xOnly)
  } catch {
    return false
  }
}

function xOnlyOf(privateKey: Uint8Array): Uint8Array {
  return secp.schnorr.getPublicKey(privateKey)
}

// ---- listing templates ---------------------------------------------------------

export interface ListingTemplateCheck {
  passthroughPsbtHex: string
  salePsbtHex: string
  /** `txid:vout` of the item the seller chose to list. */
  expectedOutpoint: string
  sellerXOnly: Uint8Array
  /** Where the sale must pay the seller. */
  sellerAddress: string
  /** The price the seller typed: the sale pays exactly this. */
  expectedSellerSats: number
  /** When given, the passthrough must spend an output at this address (the seller's own). */
  assetAddress?: string
}

export interface ListingTemplates {
  escrow: PassthroughEscrow
  escrowValue: number
  passthroughTxid: string
}

/**
 * The two templates a seller signs. Passthrough: one input, exactly the item;
 * one output, the escrow rebuilt locally from the seller key and the pinned
 * co-signer; the postage moved whole or less exactly 12 sats; escrow at least
 * 330 sats; key path only, SIGHASH_ALL/DEFAULT. Sale template: that escrow as
 * the only input, one output paying the seller exactly their price, the NUMS
 * internal key, the sale leaf and nothing else, SIGHASH_SINGLE|ANYONECANPAY.
 */
export function assertListingTemplates(input: ListingTemplateCheck): ListingTemplates {
  const escrow = passthroughEscrow(input.sellerXOnly)
  const sellerScript = scriptForAddress(input.sellerAddress)
  if (!Number.isSafeInteger(input.expectedSellerSats) || input.expectedSellerSats < MIN_ESCROW_VALUE_SATS) {
    fail('price_below_dust', `Price must be at least ${MIN_ESCROW_VALUE_SATS} sats`)
  }

  const passthrough = parsePsbt(input.passthroughPsbtHex, 'Passthrough')
  if (passthrough.inputsLength !== 1) {
    fail('listing_input_count', 'Passthrough must spend exactly the item')
  }
  if (outpointOf(passthrough, 0) !== input.expectedOutpoint.toLowerCase()) {
    fail('listing_input_mismatch', 'Passthrough spends a different UTXO than the item you selected')
  }
  const source = passthrough.getInput(0)
  if (!source.witnessUtxo) fail('missing_witness_utxo', 'Passthrough input is missing its prevout')
  if (input.assetAddress && !equal(source.witnessUtxo!.script, scriptForAddress(input.assetAddress))) {
    fail('listing_input_not_yours', 'Passthrough spends an output that is not at your address')
  }
  if (source.tapLeafScript?.length || source.tapMerkleRoot) {
    fail('listing_script_path', 'Passthrough asks for a script-path signature on your item')
  }
  if (source.tapInternalKey && !equal(source.tapInternalKey, input.sellerXOnly)) {
    fail('listing_internal_key', 'Passthrough names an internal key other than your wallet key')
  }
  if (source.sighashType !== undefined && !SELLER_PASSTHROUGH_SIGHASHES.includes(source.sighashType)) {
    fail('listing_sighash', 'Passthrough must be signed with SIGHASH_ALL')
  }
  if (source.finalScriptWitness || source.tapKeySig) {
    fail('listing_prefilled', 'Passthrough already carries a signature')
  }
  const postage = Number(source.witnessUtxo!.amount)
  if (passthrough.outputsLength !== 1) {
    fail('listing_output_shape', 'Passthrough has an unexpected output')
  }
  const escrowOut = passthrough.getOutput(0)
  if (!equal(escrowOut.script, escrow.script)) {
    fail('listing_escrow_mismatch', 'Passthrough does not send the item to your own passthrough escrow')
  }
  const escrowValue = Number(escrowOut.amount)
  const shaved = postage - escrowValue
  if ((shaved !== 0 && shaved !== PASSTHROUGH_PARENT_FEE_SATS) || escrowValue < MIN_ESCROW_VALUE_SATS) {
    fail(
      'listing_postage_mismatch',
      `Passthrough must move the postage whole (or shave exactly ${PASSTHROUGH_PARENT_FEE_SATS} sats); it moves ${escrowValue} of ${postage} sats`,
    )
  }
  const passthroughTxid = txidOf(passthrough)

  const sale = parsePsbt(input.salePsbtHex, 'Sale template')
  assertSaleTemplateShape(sale, {
    escrow,
    escrowValue,
    passthroughTxid,
    sellerScript,
    priceSats: input.expectedSellerSats,
  })
  const saleInput = sale.getInput(0)
  if (saleInput.tapScriptSig?.length || saleInput.tapKeySig || saleInput.finalScriptWitness) {
    fail('sale_template_prefilled', 'Sale template already carries a signature')
  }
  return { escrow, escrowValue, passthroughTxid }
}

interface SaleTemplateExpectation {
  escrow: PassthroughEscrow
  escrowValue: number
  passthroughTxid: string
  sellerScript: Uint8Array
  priceSats: number
}

function assertSaleTemplateShape(sale: btc.Transaction, e: SaleTemplateExpectation): void {
  if (sale.inputsLength !== 1 || sale.outputsLength !== 1) {
    fail('sale_template_shape', 'Sale template must have one input and one output')
  }
  if (outpointOf(sale, 0) !== `${e.passthroughTxid}:0`) {
    fail('sale_template_input', 'Sale template does not spend the passthrough output')
  }
  const saleInput = sale.getInput(0)
  if (
    !saleInput.witnessUtxo ||
    !equal(saleInput.witnessUtxo.script, e.escrow.script) ||
    Number(saleInput.witnessUtxo.amount) !== e.escrowValue
  ) {
    fail('sale_template_prevout', 'Sale template prevout is not the passthrough escrow')
  }
  if (saleInput.sighashType !== SIGHASH_SINGLE_ANYONECANPAY) {
    fail('sale_template_sighash', 'Sale template must be signed with SIGHASH_SINGLE|ANYONECANPAY (0x83)')
  }
  // Exactly the sale leaf, with the control block this escrow implies. A
  // template carrying any other leaf (the recovery leaf included) would get
  // a signature the seller never meant to give.
  const leaves = saleInput.tapLeafScript || []
  const onlySaleLeaf = leaves.length === 1 && leaves.every(([cb, scriptWithVersion]) =>
    scriptWithVersion[scriptWithVersion.length - 1] === TAPSCRIPT_LEAF_VERSION &&
    equal(scriptWithVersion.subarray(0, -1), e.escrow.leaf) &&
    equal(btc.TaprootControlBlock.encode(cb), e.escrow.leafControlBlock))
  if (!onlySaleLeaf) {
    fail('sale_template_leaf', 'Sale template does not carry exactly your escrow sale leaf')
  }
  // The escrow has no key path; any other internal key (yours included)
  // would make the wallet sign the wrong thing.
  if (!equal(saleInput.tapInternalKey, hexToBytes(NUMS_INTERNAL_KEY_HEX))) {
    fail('sale_template_internal_key', 'Sale template internal key is not the unspendable escrow key')
  }
  const payout = sale.getOutput(0)
  if (!equal(payout.script, e.sellerScript)) {
    fail('listing_payout_mismatch', 'Sale template pays someone other than your wallet')
  }
  if (Number(payout.amount) !== e.priceSats) {
    fail('listing_price_mismatch', `Sale template pays ${Number(payout.amount)} sats, not the ${e.priceSats} you asked for`)
  }
}

function saleSighash(sale: btc.Transaction, escrow: PassthroughEscrow, escrowValue: number): Uint8Array {
  return sale.preimageWitnessV1(
    0,
    [escrow.script],
    SIGHASH_SINGLE_ANYONECANPAY,
    [BigInt(escrowValue)],
    undefined,
    escrow.leaf,
    TAPSCRIPT_LEAF_VERSION,
  )
}

export interface SignedSaleTemplateExpectation {
  sellerXOnly: Uint8Array
  passthroughTxid: string
  escrowValue: number
  sellerAddress: string
  priceSats: number
}

/**
 * Check a signed sale template and return the form the API accepts: our
 * 65-byte 0x83 script-path signature over the sale leaf, valid for our key,
 * and no key-path signature (a stray one is dropped; the API refuses any
 * template carrying one).
 */
export function assertSignedSaleTemplate(signedSalePsbtHex: string, e: SignedSaleTemplateExpectation): string {
  const escrow = passthroughEscrow(e.sellerXOnly)
  const sale = parsePsbt(signedSalePsbtHex, 'Signed sale template')
  assertSaleTemplateShape(sale, {
    escrow,
    escrowValue: e.escrowValue,
    passthroughTxid: e.passthroughTxid.toLowerCase(),
    sellerScript: scriptForAddress(e.sellerAddress),
    priceSats: e.priceSats,
  })
  const input = sale.getInput(0)
  const leafHash = tapLeafHash(escrow.leaf)
  const mine = (input.tapScriptSig || []).filter(([{ pubKey, leafHash: lh }]) =>
    equal(pubKey, e.sellerXOnly) && equal(lh, leafHash))
  if (mine.length !== 1) {
    fail(input.tapKeySig ? 'sale_signed_on_key_path' : 'sale_unsigned', 'Sale template carries no script-path signature from your key')
  }
  if ((input.tapScriptSig || []).length !== 1) {
    fail('sale_template_mutated', 'Sale template carries signatures other than yours')
  }
  const signature = mine[0][1]
  if (signature.length !== 65 || signature[64] !== SIGHASH_SINGLE_ANYONECANPAY) {
    fail('sale_template_sighash', 'Sale signature does not commit with SIGHASH_SINGLE|ANYONECANPAY')
  }
  if (!schnorrVerify(signature.subarray(0, 64), saleSighash(sale, escrow, e.escrowValue), e.sellerXOnly)) {
    fail('sale_presignature_invalid', 'Sale signature does not verify for your key')
  }
  if (input.finalScriptWitness) {
    fail('sale_template_mutated', 'Sale template must not be finalized')
  }
  if (input.tapKeySig) {
    sale.updateInput(0, { tapKeySig: undefined }, true)
    return bytesToHex(sale.toPSBT())
  }
  return signedSalePsbtHex
}

export interface SignListingTemplatesInput extends Omit<ListingTemplateCheck, 'sellerXOnly'> {
  privateKey: Uint8Array
}

export interface SignedListingTemplates {
  /** Passthrough PSBT with our key-path signature, unfinalized. */
  psbt: string
  /** Sale template PSBT with our script-path pre-signature. */
  salePsbt: string
  passthroughTxid: string
  escrowValue: number
}

/**
 * Verify both templates, then sign: the passthrough on the key path (the
 * wallet's usual tweaked key) with SIGHASH_DEFAULT/ALL, the sale on the sale
 * leaf only, untweaked, with SIGHASH_SINGLE|ANYONECANPAY. Nothing else is
 * signed and nothing is finalized.
 */
export function signListingTemplates(input: SignListingTemplatesInput): SignedListingTemplates {
  const sellerXOnly = xOnlyOf(input.privateKey)
  const checked = assertListingTemplates({ ...input, sellerXOnly })

  // Passthrough: key path, our own P2TR output.
  const passthrough = parsePsbt(input.passthroughPsbtHex, 'Passthrough')
  passthrough.updateInput(0, { tapInternalKey: sellerXOnly }, true)
  let signed = false
  try {
    signed = passthrough.signIdx(input.privateKey, 0, SELLER_PASSTHROUGH_SIGHASHES)
  } catch (err) {
    fail('sign_failed', `Could not sign the passthrough: ${(err as Error).message}`)
  }
  const keySig = passthrough.getInput(0).tapKeySig
  if (!signed || !keySig || passthrough.getInput(0).tapScriptSig?.length) {
    fail('sign_failed', 'Could not sign the passthrough on the key path; is the item at this wallet\'s address?')
  }
  if (keySig!.length !== 64 && !(keySig!.length === 65 && keySig![64] === 0x01)) {
    fail('listing_sighash', 'Passthrough was signed with an unexpected sighash')
  }
  if (txidOf(passthrough) !== checked.passthroughTxid) {
    fail('signed_template_mutated', 'Passthrough changed while signing')
  }

  // Sale template: script path, sale leaf only, no tweak.
  const sale = parsePsbt(input.salePsbtHex, 'Sale template')
  const signature = secp.utils.concatBytes(
    schnorrSign(saleSighash(sale, checked.escrow, checked.escrowValue), input.privateKey),
    Uint8Array.of(SIGHASH_SINGLE_ANYONECANPAY),
  )
  sale.updateInput(
    0,
    { tapScriptSig: [[{ pubKey: sellerXOnly, leafHash: tapLeafHash(checked.escrow.leaf) }, signature]] },
    true,
  )
  const salePsbt = assertSignedSaleTemplate(bytesToHex(sale.toPSBT()), {
    sellerXOnly,
    passthroughTxid: checked.passthroughTxid,
    escrowValue: checked.escrowValue,
    sellerAddress: input.sellerAddress,
    priceSats: input.expectedSellerSats,
  })
  return {
    psbt: bytesToHex(passthrough.toPSBT()),
    salePsbt,
    passthroughTxid: checked.passthroughTxid,
    escrowValue: checked.escrowValue,
  }
}

// ---- recovery -------------------------------------------------------------------

export interface RecoveryCheck {
  psbtHex: string
  passthroughTxid: string
  sellerXOnly: Uint8Array
  destinationAddress: string
  feeRateSatVb: number
}

export interface RecoveryTemplate {
  escrow: PassthroughEscrow
  escrowValue: number
  valueSat: number
  feeSat: number
}

/**
 * The seller's unilateral recovery of an escrow that confirmed without its
 * sale: `passthrough:0` back to the seller through the `<144> CSV` leaf.
 * One input, sequence 144, prevout = our escrow; one output to our
 * destination; the fee within the requested rate.
 */
export function assertRecoveryTemplate(input: RecoveryCheck): RecoveryTemplate {
  const escrow = passthroughEscrow(input.sellerXOnly)
  const tx = parsePsbt(input.psbtHex, 'Recovery')
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1) {
    fail('recovery_shape', 'Recovery must have one input and one output')
  }
  if (tx.version < 2) fail('recovery_version', 'Recovery must be a version 2 transaction for its timelock to apply')
  if (outpointOf(tx, 0) !== `${input.passthroughTxid.toLowerCase()}:0`) {
    fail('recovery_input', 'Recovery does not spend this passthrough\'s escrow')
  }
  const data = tx.getInput(0)
  if (!data.witnessUtxo || !equal(data.witnessUtxo.script, escrow.script)) {
    fail('recovery_prevout', 'Recovery does not spend your escrow')
  }
  if (data.sequence !== RECOVERY_DELAY_BLOCKS) {
    fail('recovery_sequence', `Recovery input must wait ${RECOVERY_DELAY_BLOCKS} blocks`)
  }
  if (data.sighashType !== undefined && data.sighashType !== 0x00 && data.sighashType !== 0x01) {
    fail('recovery_sighash', 'Recovery must be signed with SIGHASH_DEFAULT')
  }
  const out = tx.getOutput(0)
  if (!equal(out.script, scriptForAddress(input.destinationAddress))) {
    fail('recovery_destination', 'Recovery pays somewhere other than your destination')
  }
  const escrowValue = Number(data.witnessUtxo!.amount)
  const valueSat = Number(out.amount)
  const feeSat = escrowValue - valueSat
  const maxFee = Math.ceil(Math.max(input.feeRateSatVb, 1) * RECOVERY_VBYTES) + 1
  if (feeSat <= 0 || feeSat > maxFee) {
    fail('recovery_fee', `Recovery fee of ${feeSat} sats is out of range (cap ${maxFee})`)
  }
  if (valueSat < MIN_ESCROW_VALUE_SATS) fail('recovery_below_dust', 'Recovery output would be dust')
  return { escrow, escrowValue, valueSat, feeSat }
}

/** Verify and sign a recovery; returns the finalized transaction, ready to broadcast once the escrow has 144 confirmations. */
export function signRecovery(input: Omit<RecoveryCheck, 'sellerXOnly'> & { privateKey: Uint8Array }): {
  rawtx: string
  txid: string
  valueSat: number
  feeSat: number
} {
  const sellerXOnly = xOnlyOf(input.privateKey)
  const checked = assertRecoveryTemplate({ ...input, sellerXOnly })
  const tx = parsePsbt(input.psbtHex, 'Recovery')
  const message = tx.preimageWitnessV1(
    0,
    [checked.escrow.script],
    0x00,
    [BigInt(checked.escrowValue)],
    undefined,
    checked.escrow.recoveryLeaf,
    TAPSCRIPT_LEAF_VERSION,
  )
  const signature = schnorrSign(message, input.privateKey)
  tx.updateInput(
    0,
    { finalScriptWitness: [signature, checked.escrow.recoveryLeaf, checked.escrow.recoveryControlBlock] },
    true,
  )
  return { rawtx: bytesToHex(tx.extract()), txid: tx.id, valueSat: checked.valueSat, feeSat: checked.feeSat }
}
