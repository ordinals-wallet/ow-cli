/**
 * Client-side checks and signing for Offers v1 PSBTs.
 *
 * The server builds every PSBT; these helpers rebuild what each one must look
 * like from values the caller already trusts (their own keys and addresses,
 * the price they agreed, the pinned Ordinals Wallet co-signer key) and refuse
 * to sign anything else. See "Signing safely" in the developer docs.
 *
 * Escrow: `tr(NUMS, {multi_a(2, buyer, OW), and(older(delay), pk(buyer))})`
 * with sale leaf `<buyer> CHECKSIG <OW> CHECKSIGADD 2 NUMEQUAL`.
 */
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { bytesToHex, hexToBytes } from './signer.js'

/** Ordinals Wallet's escrow co-signer (x-only). Pinned so a compromised API cannot swap it. */
export const OW_COSIGNER_XONLY = '1d08b7c71f6f1e97a0a4cf005db7a977c85e34652a0c9365842aee25997c7dee'
/** Where the marketplace fee is paid. */
export const OW_MARKET_FEE_ADDRESS = 'bc1p6yd49679azsaxqgtr52ff6jjvj2wv5dlaqwhaxarkamevgle2jaqs8vlnr'
/** BIP-341 provably unspendable internal key `H`. */
export const NUMS_INTERNAL_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'

const SIGHASH_DEFAULT = 0x00
const SIGHASH_ALL = 0x01
const SIGHASH_NONE_ANYONECANPAY = 0x82
const TAPSCRIPT_LEAF_VERSION = 0xc0

export type OfferScopeKind = 'item' | 'collection' | 'trait'

/** A PSBT failed verification; `problems` lists every rule it broke. Nothing was signed. */
export class OfferVerificationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Refusing to sign offer PSBT: ${problems.join('; ')}`)
    this.name = 'OfferVerificationError'
  }
}

function parsePsbt(psbt: string): btc.Transaction {
  const bytes = /^[0-9a-fA-F]+$/.test(psbt)
    ? hexToBytes(psbt)
    : Uint8Array.from(atob(psbt), (c) => c.charCodeAt(0))
  return btc.Transaction.fromPSBT(bytes, { allowUnknownOutputs: true, allowUnknownInputs: true })
}

function addressScript(address: string): Uint8Array {
  return btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address))
}

function eq(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])
}

function xOnly(pub: Uint8Array | string): Uint8Array {
  const b = typeof pub === 'string' ? hexToBytes(pub) : pub
  if (b.length === 33) return b.slice(1)
  if (b.length === 32) return b
  throw new Error(`Invalid public key length ${b.length}`)
}

function outpointOf(input: { txid?: Uint8Array; index?: number }): string {
  return `${bytesToHex(input.txid ?? new Uint8Array())}:${input.index}`
}

/** The offer escrow's sale leaf and recovery leaf, and its P2TR output. */
export function offerEscrow(
  buyerPublicKey: Uint8Array | string,
  recoveryDelayBlocks: number,
  cosignerXOnly: string = OW_COSIGNER_XONLY,
): { saleLeaf: Uint8Array; recoveryLeaf: Uint8Array; script: Uint8Array; address: string } {
  const buyer = xOnly(buyerPublicKey)
  const cosigner = hexToBytes(cosignerXOnly)
  const saleLeaf = btc.Script.encode([buyer, 'CHECKSIG', cosigner, 'CHECKSIGADD', 2, 'NUMEQUAL'])
  const recoveryLeaf = btc.Script.encode([recoveryDelayBlocks, 'CHECKSEQUENCEVERIFY', 'DROP', buyer, 'CHECKSIG'])
  const p2tr = btc.p2tr(
    hexToBytes(NUMS_INTERNAL_KEY),
    [{ script: saleLeaf }, { script: recoveryLeaf }],
    btc.NETWORK,
    true,
  )
  return { saleLeaf, recoveryLeaf, script: p2tr.script, address: p2tr.address! }
}

/** Check that `input` is the offer escrow spent on its sale leaf with the pinned co-signer. */
function checkEscrowInput(
  tx: btc.Transaction,
  idx: number,
  buyerPublicKey: Uint8Array | string,
  recoveryDelayBlocks: number,
  escrowValue: number | undefined,
  problems: string[],
): void {
  if (idx < 0 || idx >= tx.inputsLength) {
    problems.push(`sign_input_index ${idx} out of range`)
    return
  }
  const input = tx.getInput(idx)
  const escrow = offerEscrow(buyerPublicKey, recoveryDelayBlocks)
  if (!eq(input.witnessUtxo?.script, escrow.script)) {
    problems.push(`input ${idx} is not this offer's escrow (co-signer must be ${OW_COSIGNER_XONLY.slice(0, 8)}…)`)
  }
  if (escrowValue !== undefined && input.witnessUtxo?.amount !== BigInt(escrowValue)) {
    problems.push(`escrow input value ${input.witnessUtxo?.amount} != expected ${escrowValue}`)
  }
  const leaves = input.tapLeafScript ?? []
  if (leaves.length !== 1) {
    problems.push(`escrow input must carry exactly the sale leaf (found ${leaves.length} leaves)`)
  } else {
    const [, scriptWithVer] = leaves[0]
    const ver = scriptWithVer[scriptWithVer.length - 1]
    if (ver !== TAPSCRIPT_LEAF_VERSION || !eq(scriptWithVer.subarray(0, -1), escrow.saleLeaf)) {
      problems.push('escrow input leaf is not the 2-of-2 sale leaf with the pinned co-signer')
    }
  }
}

// ─── Buyer: funding ─────────────────────────────────────────────────

export interface FundingExpectations {
  /** Buyer key that owns the escrow (33-byte compressed or x-only, hex or bytes). */
  buyerPublicKey: Uint8Array | string
  /** Address funding the offer; all inputs must be from it, change may only return to it. */
  paymentAddress: string
  /** From the build response. */
  escrowValue: number
  recoveryDelayBlocks: number
  /** Refuse if the funding transaction's miner fee exceeds this. */
  maxMinerFeeSats?: number
}

/** Verify a funding PSBT pays exactly `escrowValue` into this offer's escrow and nothing else leaves the wallet. */
export function verifyFundingPsbt(psbt: string, expect: FundingExpectations): string[] {
  const problems: string[] = []
  const tx = parsePsbt(psbt)
  const escrow = offerEscrow(expect.buyerPublicKey, expect.recoveryDelayBlocks)
  const mine = addressScript(expect.paymentAddress)
  let inSum = 0n
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    if (!eq(inp.witnessUtxo?.script, mine)) problems.push(`funding input ${i} is not from ${expect.paymentAddress}`)
    inSum += inp.witnessUtxo?.amount ?? 0n
  }
  let escrowOutputs = 0
  let outSum = 0n
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    outSum += out.amount ?? 0n
    if (eq(out.script, escrow.script)) {
      escrowOutputs++
      if (out.amount !== BigInt(expect.escrowValue)) {
        problems.push(`escrow output ${out.amount} != escrow_value ${expect.escrowValue}`)
      }
    } else if (!eq(out.script, mine)) {
      problems.push(`funding output ${i} pays an unexpected script`)
    }
  }
  if (escrowOutputs !== 1) problems.push(`expected exactly one escrow output, found ${escrowOutputs}`)
  const fee = inSum - outSum
  if (fee < 0n) problems.push('funding outputs exceed inputs')
  if (expect.maxMinerFeeSats !== undefined && fee > BigInt(expect.maxMinerFeeSats)) {
    problems.push(`funding miner fee ${fee} exceeds max ${expect.maxMinerFeeSats}`)
  }
  return problems
}

// ─── Buyer: pre-signature on the escrow leaf ────────────────────────

export interface PresignParams {
  privateKey: Uint8Array
  scope: OfferScopeKind
  /** From the prepare response. */
  signInputIndex: number
  sighash: number
  recoveryDelayBlocks: number
  escrowValue: number
  /** Item offers only: the acceptance template must deliver the item here… */
  buyerAddress?: string
  /** …pay exactly this much to the seller… */
  priceSats?: number
  /** …and exactly this to the marketplace. */
  marketFeeSats?: number
}

/** Expected pre-sign sighash per scope: 0x01 for item offers, 0x82 for collection/trait. */
export function expectedPresignSighash(scope: OfferScopeKind): number {
  return scope === 'item' ? SIGHASH_ALL : SIGHASH_NONE_ANYONECANPAY
}

export function verifyPresignPsbt(psbt: string, p: PresignParams): string[] {
  const problems: string[] = []
  const expected = expectedPresignSighash(p.scope)
  if (p.sighash !== SIGHASH_ALL && p.sighash !== SIGHASH_NONE_ANYONECANPAY) {
    problems.push(`sighash 0x${p.sighash.toString(16)} is not 0x01 or 0x82`)
  } else if (p.sighash !== expected) {
    problems.push(`sighash 0x${p.sighash.toString(16)} does not match ${p.scope} scope (0x${expected.toString(16)})`)
  }
  const tx = parsePsbt(psbt)
  const pub = secp.schnorr.getPublicKey(p.privateKey)
  checkEscrowInput(tx, p.signInputIndex, pub, p.recoveryDelayBlocks, p.escrowValue, problems)
  const input = p.signInputIndex < tx.inputsLength ? tx.getInput(p.signInputIndex) : undefined
  if (input && input.sighashType !== expected) {
    problems.push(`escrow input requests sighash ${input.sighashType}, expected 0x${expected.toString(16)}`)
  }
  if (p.scope === 'item') {
    if (p.buyerAddress === undefined || p.priceSats === undefined || p.marketFeeSats === undefined) {
      problems.push('item offers need buyerAddress, priceSats and marketFeeSats to check the sale')
      return problems
    }
    if (tx.inputsLength !== 2 || p.signInputIndex !== 1) problems.push('item sale must be [item, escrow]')
    if (tx.outputsLength !== 3) {
      problems.push(`item sale must have 3 outputs, found ${tx.outputsLength}`)
    } else {
      const [item, seller, fee] = [0, 1, 2].map((i) => tx.getOutput(i))
      const itemIn = tx.getInput(0).witnessUtxo
      if (!eq(item.script, addressScript(p.buyerAddress))) problems.push('output 0 does not deliver the item to you')
      if (itemIn && item.amount !== itemIn.amount) problems.push('output 0 does not carry the whole item output')
      if (seller.amount !== BigInt(p.priceSats)) problems.push(`seller output ${seller.amount} != price ${p.priceSats}`)
      if (!eq(fee.script, addressScript(OW_MARKET_FEE_ADDRESS))) problems.push('output 2 is not the marketplace fee')
      if (fee.amount !== BigInt(p.marketFeeSats)) problems.push(`fee output ${fee.amount} != ${p.marketFeeSats}`)
    }
  } else if (tx.inputsLength !== 1 || p.signInputIndex !== 0) {
    problems.push('collection/trait pre-sign template must spend only the escrow')
  }
  return problems
}

function signLeafInput(tx: btc.Transaction, idx: number, privateKey: Uint8Array, sighash: number): void {
  const pub = secp.schnorr.getPublicKey(privateKey)
  tx.signIdx(privateKey, idx, [sighash])
  const sigs = tx.getInput(idx).tapScriptSig ?? []
  if (!sigs.some(([k]) => eq(k.pubKey, pub))) throw new Error('escrow leaf signature missing after signing')
}

/**
 * Verify and pre-sign the escrow input of the acceptance template from
 * `offers.prepare` (or `batch_accept`). Signs that one input on the sale leaf
 * with the scope's sighash and returns the PSBT hex for `offers.activate`.
 */
export function signOfferPresign(psbt: string, p: PresignParams): string {
  const problems = verifyPresignPsbt(psbt, p)
  if (problems.length) throw new OfferVerificationError(problems)
  const tx = parsePsbt(psbt)
  signLeafInput(tx, p.signInputIndex, p.privateKey, p.sighash)
  return bytesToHex(tx.toPSBT())
}

/**
 * Verify and sign an offer's funding PSBT (key-path, every input is the
 * buyer's). Returns the signed PSBT hex for `offers.prepare` / `activate`.
 */
export function signOfferFunding(psbt: string, privateKey: Uint8Array, expect: FundingExpectations): string {
  const problems = verifyFundingPsbt(psbt, expect)
  if (problems.length) throw new OfferVerificationError(problems)
  const tx = parsePsbt(psbt)
  const internal = secp.schnorr.getPublicKey(privateKey)
  const isTaproot = btc.Address(btc.NETWORK).decode(expect.paymentAddress).type === 'tr'
  for (let i = 0; i < tx.inputsLength; i++) {
    if (isTaproot) tx.updateInput(i, { tapInternalKey: internal })
    tx.signIdx(privateKey, i, [SIGHASH_DEFAULT, SIGHASH_ALL])
    tx.finalizeIdx(i)
  }
  return bytesToHex(tx.toPSBT())
}

// ─── Seller: accept / fill ──────────────────────────────────────────

export interface AcceptExpectations {
  /** The seller's address holding the item (receives the price). */
  myAddress: string
  /** `txid:vout` of the item being sold. */
  inscriptionOutpoint: string
  /** Minimum the seller must receive. */
  priceSats: number
  /** If known, the item must go exactly here (offer.buyer_address). */
  buyerAddress?: string
  /** If known, change may only go here (offer.buyer_payment_address). */
  buyerPaymentAddress?: string
}

/**
 * Seller-side rules for `build-accept` / `build-fill` PSBTs:
 * input 0 is the seller's item and no other input is the seller's; output 0
 * carries the whole item to the buyer; one output pays the seller at least
 * `priceSats`; exactly one output pays the marketplace fee; at most one other
 * output (buyer change); input 0 signs with SIGHASH_ALL.
 * Returns the list of problems (empty = OK).
 */
export function verifyAcceptPsbt(psbt: string | btc.Transaction, expect: AcceptExpectations): string[] {
  const problems: string[] = []
  const tx = typeof psbt === 'string' ? parsePsbt(psbt) : psbt
  const mine = addressScript(expect.myAddress)
  const feeScript = addressScript(OW_MARKET_FEE_ADDRESS)
  if (tx.inputsLength < 1) return ['no inputs']

  const item = tx.getInput(0)
  if (outpointOf(item) !== expect.inscriptionOutpoint) {
    problems.push(`input 0 is ${outpointOf(item)}, not your item ${expect.inscriptionOutpoint}`)
  }
  if (!eq(item.witnessUtxo?.script, mine)) problems.push('input 0 is not held by your address')
  if (item.sighashType !== undefined && item.sighashType !== SIGHASH_ALL && item.sighashType !== SIGHASH_DEFAULT) {
    problems.push(`input 0 requests sighash ${item.sighashType}; only SIGHASH_ALL is allowed`)
  }
  for (let i = 1; i < tx.inputsLength; i++) {
    if (eq(tx.getInput(i).witnessUtxo?.script, mine)) problems.push(`input ${i} also spends from your address`)
  }

  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
  if (outs.length === 0) return [...problems, 'no outputs']
  const delivery = outs[0]
  if (eq(delivery.script, mine)) problems.push('output 0 returns the item to you instead of the buyer')
  if (item.witnessUtxo && delivery.amount !== item.witnessUtxo.amount) {
    problems.push('output 0 does not carry the whole item output (inscription could land elsewhere)')
  }
  if (expect.buyerAddress && !eq(delivery.script, addressScript(expect.buyerAddress))) {
    problems.push('output 0 does not deliver the item to the offer buyer')
  }

  const rest = outs.slice(1)
  const payIdx = rest.findIndex((o) => eq(o.script, mine) && (o.amount ?? 0n) >= BigInt(expect.priceSats))
  if (payIdx < 0) problems.push(`no output pays you at least ${expect.priceSats} sats`)
  if (rest.filter((o) => eq(o.script, mine)).length > 1) problems.push('more than one output pays you')
  const fees = rest.filter((o) => eq(o.script, feeScript))
  if (fees.length !== 1) problems.push(`expected exactly one marketplace fee output, found ${fees.length}`)
  const others = rest.filter((o) => !eq(o.script, mine) && !eq(o.script, feeScript))
  if (others.length > 1) problems.push(`unexpected extra outputs (${others.length}); only buyer change is allowed`)
  if (others.length === 1 && expect.buyerPaymentAddress && !eq(others[0].script, addressScript(expect.buyerPaymentAddress))) {
    problems.push('extra output is not buyer change to the offer payment address')
  }
  return problems
}

/**
 * Verify an accept/fill PSBT with `verifyAcceptPsbt`, then sign input 0
 * only (P2TR key path, SIGHASH_ALL). Returns the PSBT hex for
 * `offers.accept` / `offers.fill`. Throws `OfferVerificationError` otherwise.
 */
export function signAcceptPsbt(psbt: string, privateKey: Uint8Array, expect: AcceptExpectations): string {
  const tx = parsePsbt(psbt)
  const problems = verifyAcceptPsbt(tx, expect)
  if (btc.Address(btc.NETWORK).decode(expect.myAddress).type !== 'tr') {
    problems.push('signAcceptPsbt signs taproot (bc1p) items only')
  }
  if (problems.length) throw new OfferVerificationError(problems)
  tx.updateInput(0, { tapInternalKey: secp.schnorr.getPublicKey(privateKey), sighashType: SIGHASH_ALL }, true)
  tx.signIdx(privateKey, 0, [SIGHASH_ALL])
  const sig = tx.getInput(0).tapKeySig
  if (!sig) throw new Error('item input signature missing after signing')
  tx.updateInput(0, { finalScriptWitness: [sig] } as Record<string, unknown>, true)
  return bytesToHex(tx.toPSBT())
}

// ─── Buyer: cancel ──────────────────────────────────────────────────

export interface CancelParams {
  privateKey: Uint8Array
  buyerPaymentAddress: string
  escrowValue: number
  recoveryDelayBlocks: number
  /** Refuse if the refund pays more than this in miner fee. */
  maxMinerFeeSats?: number
}

export function verifyCancelPsbt(psbt: string, p: CancelParams): string[] {
  const problems: string[] = []
  const tx = parsePsbt(psbt)
  if (tx.inputsLength !== 1) problems.push('refund must spend only the escrow')
  checkEscrowInput(tx, 0, secp.schnorr.getPublicKey(p.privateKey), p.recoveryDelayBlocks, p.escrowValue, problems)
  if (tx.inputsLength >= 1 && tx.getInput(0).sighashType !== SIGHASH_ALL) problems.push('refund must be signed SIGHASH_ALL')
  if (tx.outputsLength !== 1) {
    problems.push('refund must have exactly one output')
  } else {
    const out = tx.getOutput(0)
    if (!eq(out.script, addressScript(p.buyerPaymentAddress))) problems.push('refund does not go to your payment address')
    const fee = BigInt(p.escrowValue) - (out.amount ?? 0n)
    if (fee < 0n) problems.push('refund exceeds escrow')
    if (p.maxMinerFeeSats !== undefined && fee > BigInt(p.maxMinerFeeSats)) {
      problems.push(`refund miner fee ${fee} exceeds max ${p.maxMinerFeeSats}`)
    }
  }
  return problems
}

/** Verify and sign the refund from `offers.buildCancel`. Returns PSBT hex for `offers.cancel`. */
export function signOfferCancel(psbt: string, p: CancelParams): string {
  const problems = verifyCancelPsbt(psbt, p)
  if (problems.length) throw new OfferVerificationError(problems)
  const tx = parsePsbt(psbt)
  signLeafInput(tx, 0, p.privateKey, SIGHASH_ALL)
  return bytesToHex(tx.toPSBT())
}
