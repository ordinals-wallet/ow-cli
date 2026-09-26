/**
 * Generates the signing vectors in the repo-root `fixtures/` directory from
 * this package's implementation. `shared-vectors.test.ts` regenerates them
 * and fails on any drift, then replays every case through the TypeScript
 * functions; the Rust SDK (`rust/ordinalswallet/tests/signing_vectors.rs`)
 * replays the same files. Rewrite them with:
 *
 *   OW_WRITE_VECTORS=1 pnpm --filter @ow-cli/core exec vitest run __tests__/shared-vectors.test.ts
 *
 * Keys are public test keys only (the BIP-39 "abandon … about" mnemonic, the
 * BIP-322 test WIFs, constant byte patterns). None has ever held funds.
 * Schnorr signatures use all-zero aux randomness (see deterministic.ts).
 */
import { readFileSync } from 'node:fs'
import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import { HDKey } from '@scure/bip32'
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { sha256 } from '@noble/hashes/sha256'
import { keypairFromMnemonic, keypairFromWIF, validateMnemonic } from '../../src/keys.js'
import { publicKeyToP2TR } from '../../src/address.js'
import { bytesToHex, hexToBytes } from '../../src/signer.js'
import { bip322MessageHash, bip322ToSpendTxid, bip322AddressScript, signBip322Simple, verifyBip322Simple } from '../../src/bip322.js'
import {
  OW_COSIGNER_XONLY,
  OW_MARKET_FEE_ADDRESS,
  NUMS_INTERNAL_KEY,
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
  type OfferScopeKind,
} from '../../src/offers-verify.js'
import {
  PassthroughError,
  PINNED_COSIGNER_XONLY_HEX,
  NUMS_INTERNAL_KEY_HEX,
  MARKET_FEE_ADDRESS,
  passthroughEscrow,
  parsePassthroughLeaf,
  verifySale,
  verifySetup,
  verifyPassthroughPurchase,
  assertQuoteFresh,
  signOwnInputs,
  type SaleVerification,
} from '../../src/passthrough.js'
import {
  tapLeafHash,
  assertListingTemplates,
  assertSignedSaleTemplate,
  signListingTemplates,
  assertRecoveryTemplate,
  signRecovery,
  RECOVERY_DELAY_BLOCKS,
} from '../../src/passthrough-listing.js'
import { buildCancelProof, inspectCancelProof } from '../../src/cancel-proof.js'
import { buildFixture, buildSetup, THROWAWAY, type FixtureOptions, type Fixture } from '../passthrough-fixtures.js'
import {
  OPTS,
  seller as listingSeller,
  sellerXOnly,
  sellerAddress,
  attacker,
  ITEM,
  PRICE,
  script,
  escrowWith,
  templates,
  type TemplateOptions,
} from '../passthrough-listing-fixtures.js'
import { ZERO_AUX_HEX, useZeroAuxRand } from './deterministic.js'

export const GENERATOR = 'packages/core/__tests__/shared-vectors/generate.ts'
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TEST_WIF = 'L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k'
const SELLER_WIF = 'KyrSGCFPhqZMjCe5fNTYddiLMp4tMj4gLKuJ26TsB2rvr1VJGPbt'

const here = (rel: string) => new URL(rel, import.meta.url)
const readJson = (rel: string) => JSON.parse(readFileSync(here(rel), 'utf8'))

type Outcome = { ok: true; [k: string]: unknown } | { ok: false; code: string }

/** Run `fn`; a PassthroughError becomes `{ ok: false, code }`, anything else is rethrown. */
function outcome(fn: () => Record<string, unknown>): Outcome {
  try {
    return { ok: true, ...fn() }
  } catch (err) {
    if (err instanceof PassthroughError) return { ok: false, code: err.code }
    throw err
  }
}

const parse = (hex: string) => btc.Transaction.fromPSBT(hexToBytes(hex), OPTS)
const p2wpkhAddress = (pub: Uint8Array) => btc.p2wpkh(pub).address!
const party = (fill: number) => {
  const privateKey = new Uint8Array(32).fill(fill)
  const xOnly = secp.schnorr.getPublicKey(privateKey)
  return { privateKey, xOnly, address: btc.p2tr(xOnly).address! }
}

// ─── bip39 / derivation ─────────────────────────────────────────────

function bip39Vectors() {
  const official = readJson('./bip39-trezor-english.json') as string[][]
  const joined = wordlist.join('\n') + '\n'
  return {
    description:
      'BIP-39 English: the official Trezor vectors (passphrase "TREZOR", with the BIP-32 root xprv of each seed), seeds with an empty passphrase, and mnemonics that must fail validation.',
    generated_by: GENERATOR,
    wordlist_sha256: bytesToHex(sha256(new TextEncoder().encode(joined))),
    vectors: official.map(([entropy, mnemonic, seed, xprv]) => {
      if (entropyToMnemonic(hexToBytes(entropy), wordlist) !== mnemonic) throw new Error('trezor mnemonic')
      if (bytesToHex(mnemonicToSeedSync(mnemonic, 'TREZOR')) !== seed) throw new Error('trezor seed')
      if (HDKey.fromMasterSeed(hexToBytes(seed)).privateExtendedKey !== xprv) throw new Error('trezor xprv')
      return { entropy, mnemonic, passphrase: 'TREZOR', seed, xprv }
    }),
    no_passphrase: [ABANDON, 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', official[3][1]].map((mnemonic) => ({
      mnemonic,
      seed: bytesToHex(mnemonicToSeedSync(mnemonic, '')),
    })),
    invalid: [
      { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon', reason: 'bad checksum' },
      { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandonx', reason: 'unknown word' },
      { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', reason: '11 words' },
      { mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', reason: '13 words' },
      { mnemonic: 'abandon  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', reason: 'double space' },
      { mnemonic: 'Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', reason: 'capital letter' },
      { mnemonic: `${ABANDON} `, reason: 'trailing space' },
      { mnemonic: '', reason: 'empty' },
    ].map((c) => {
      if (validateMnemonic(c.mnemonic)) throw new Error(`expected invalid: ${c.reason}`)
      return c
    }),
  }
}

function keyInfo(kp: { privateKey: Uint8Array; publicKey: Uint8Array; xOnlyPublicKey: Uint8Array }) {
  return {
    private_key: bytesToHex(kp.privateKey),
    public_key: bytesToHex(kp.publicKey),
    x_only_public_key: bytesToHex(kp.xOnlyPublicKey),
    p2tr_address: publicKeyToP2TR(kp.publicKey).address,
    p2wpkh_address: p2wpkhAddress(kp.publicKey),
  }
}

function derivationVectors() {
  const official = readJson('./bip39-trezor-english.json') as string[][]
  const mnemonics = [ABANDON, 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', official[1][1], official[5][1], official[11][1], official[23][1]]
  return {
    description:
      "Wallet keys as @ow-cli/core derives them: BIP-39 mnemonic (no passphrase) -> BIP-32 m/86'/0'/0'/0/0 -> key, its BIP-86 taproot address and the P2WPKH address of the same key; and WIF -> the same fields.",
    generated_by: GENERATOR,
    path: "m/86'/0'/0'/0/0",
    bip86_official: { mnemonic: ABANDON, p2tr_address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr' },
    mnemonics: mnemonics.map((mnemonic) => ({ mnemonic, ...keyInfo(keypairFromMnemonic(mnemonic)) })),
    wif: [TEST_WIF, SELLER_WIF, btc.WIF().encode(new Uint8Array(32).fill(1))].map((wif) => ({ wif, ...keyInfo(keypairFromWIF(wif)) })),
    invalid_mnemonics: [
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    ],
  }
}

// ─── bip322 ─────────────────────────────────────────────────────────

async function bip322Vectors() {
  const official = readJson('../fixtures/bip322-basic-test-vectors.json')
  const test = keypairFromWIF(TEST_WIF)
  const abandon = keypairFromMnemonic(ABANDON)
  const taproot = publicKeyToP2TR(test.publicKey).address
  const segwit = p2wpkhAddress(test.publicKey)
  const signIn = (address: string) =>
    `Sign in to Ordinals Wallet\n\nThis proves you own this address. It does not move funds or cost a fee.\n\nAddress: ${address}\nNonce: 0123456789abcdef0123456789abcdef\nIssued At: 1790424300000`
  const signers = [
    { name: 'test WIF', wif: TEST_WIF, kp: test },
    { name: 'abandon mnemonic', wif: btc.WIF().encode(abandon.privateKey), kp: abandon },
  ]
  const sign: Array<Record<string, unknown>> = []
  for (const s of signers) {
    for (const address of [publicKeyToP2TR(s.kp.publicKey).address, p2wpkhAddress(s.kp.publicKey)]) {
      for (const message of [signIn(address), '', 'Hello World', 'héllo ✓ ordinals']) {
        const signature = signBip322Simple(address, message, s.kp.privateKey)
        if (!(await verifyBip322Simple(address, message, signature))) throw new Error('self verify')
        sign.push({ description: `${s.name} ${address.slice(0, 4)} ${JSON.stringify(message.slice(0, 24))}`, wif: s.wif, address, message, signature })
      }
    }
  }
  const trSig = sign.find((c) => c.address === taproot && c.message === 'Hello World')!.signature as string
  const wpSig = sign.find((c) => c.address === segwit && c.message === 'Hello World')!.signature as string
  const raw = Uint8Array.from(atob(trSig), (c) => c.charCodeAt(0))
  const withByte = (b: number) => btoa(String.fromCharCode(1, 65, ...raw.slice(2), b))
  const verify = [
    { description: 'taproot SIGHASH_ALL (65-byte) vector for the test key', address: taproot, message: 'Hello World', signature: 'AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==' },
    { description: 'taproot, "smp"-prefixed', address: taproot, message: 'Hello World', signature: `smp${trSig}` },
    { description: 'taproot, tampered message', address: taproot, message: 'Hello World.', signature: trSig },
    { description: 'taproot, other address', address: publicKeyToP2TR(abandon.publicKey).address, message: 'Hello World', signature: trSig },
    { description: 'taproot, DEFAULT signature with an explicit 0x01 byte', address: taproot, message: 'Hello World', signature: withByte(0x01) },
    { description: 'taproot, 65-byte signature with sighash 0x02', address: taproot, message: 'Hello World', signature: withByte(0x02) },
    { description: 'taproot, two witness items', address: taproot, message: 'Hello World', signature: btoa(String.fromCharCode(2, 64, ...raw.slice(2), 0)) },
    { description: 'taproot, trailing byte', address: taproot, message: 'Hello World', signature: btoa(String.fromCharCode(...raw, 0)) },
    { description: 'segwit signature for a taproot address', address: taproot, message: 'Hello World', signature: wpSig },
    { description: 'segwit, valid', address: segwit, message: 'Hello World', signature: wpSig },
    { description: 'segwit, tampered message', address: segwit, message: 'hello world', signature: wpSig },
    { description: 'segwit, other address', address: p2wpkhAddress(abandon.publicKey), message: 'Hello World', signature: wpSig },
    { description: 'taproot signature for a segwit address', address: segwit, message: 'Hello World', signature: trSig },
    { description: 'legacy address', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', message: 'Hello World', signature: wpSig },
    { description: 'not base64', address: taproot, message: 'Hello World', signature: 'not-valid-base64!!!' },
    { description: 'empty signature', address: taproot, message: 'Hello World', signature: '' },
  ]
  for (const v of verify as Array<Record<string, unknown>>) v.valid = await verifyBip322Simple(v.address as string, v.message as string, v.signature as string)
  const throws = (fn: () => unknown) => {
    try {
      fn()
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('expected a throw')
  }
  const signErrors = [
    { description: 'key does not control the taproot address', wif: TEST_WIF, address: publicKeyToP2TR(abandon.publicKey).address, code: 'key_mismatch' },
    { description: 'key does not control the segwit address', wif: TEST_WIF, address: p2wpkhAddress(abandon.publicKey), code: 'key_mismatch' },
    { description: 'legacy address', wif: TEST_WIF, address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', code: 'unsupported_address' },
    { description: 'P2SH address', wif: TEST_WIF, address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', code: 'unsupported_address' },
    { description: 'testnet address', wif: TEST_WIF, address: 'tb1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l', code: 'invalid_address' },
  ].map((c) => ({ ...c, message: 'x', ts_error: throws(() => signBip322Simple(c.address, 'x', keypairFromWIF(c.wif).privateKey)) }))
  return {
    description:
      'BIP-322 simple signatures (P2TR key path with SIGHASH_DEFAULT, P2WPKH with SIGHASH_ALL). `official` is bitcoin/bips basic-test-vectors.json (P2WPKH and P2TR entries). `sign` cases were made with all-zero BIP-340 aux randomness, so P2TR signatures are reproducible; P2WPKH is RFC 6979.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    official: {
      tx_hashes: official.tx_hashes.map((v: any) => {
        const ok = bytesToHex(bip322MessageHash(v.message)) === v.message_hash &&
          bip322ToSpendTxid(bip322AddressScript(v.address).script, v.message) === v.to_spend_tx_hash
        if (!ok) throw new Error('official BIP-322 hash mismatch')
        return v
      }),
      simple: official.simple.filter((v: any) => v.type === 'p2wpkh' || v.type === 'p2tr'),
      error: official.error,
    },
    sign,
    verify,
    sign_errors: signErrors,
  }
}

// ─── escrows ────────────────────────────────────────────────────────

function escrowVectors() {
  const test = keypairFromWIF(TEST_WIF)
  const abandon = keypairFromMnemonic(ABANDON)
  const buyers = [bytesToHex(test.publicKey), bytesToHex(abandon.xOnlyPublicKey), bytesToHex(party(5).xOnly)]
  const delays = [1, 6, 16, 17, 127, 128, 144, 255, 256, 1008, 32767, 32768, 65535]
  const offer = buyers.flatMap((buyer, bi) =>
    delays.filter((_, di) => bi === 0 || di % 3 === 0).map((recovery_delay_blocks) => {
      const e = offerEscrow(buyer, recovery_delay_blocks)
      return {
        buyer_public_key: buyer,
        recovery_delay_blocks,
        sale_leaf: bytesToHex(e.saleLeaf),
        recovery_leaf: bytesToHex(e.recoveryLeaf),
        script: bytesToHex(e.script),
        address: e.address,
      }
    }),
  )
  const sellers = [
    abandon.xOnlyPublicKey,
    party(1).xOnly,
    party(5).xOnly,
    hexToBytes('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'),
    test.xOnlyPublicKey,
  ]
  const protectedEscrows = sellers.map((s) => {
    const e = passthroughEscrow(s)
    return {
      seller_x_only: bytesToHex(s),
      leaf: bytesToHex(e.leaf),
      recovery_leaf: bytesToHex(e.recoveryLeaf),
      script: bytesToHex(e.script),
      address: e.address,
      leaf_control_block: bytesToHex(e.leafControlBlock),
      recovery_control_block: bytesToHex(e.recoveryControlBlock),
      leaf_hash: bytesToHex(tapLeafHash(e.leaf)),
    }
  })
  const leaf = passthroughEscrow(party(1).xOnly).leaf
  const oneOfTwo = leaf.slice()
  oneOfTwo[68] = 0x51
  const parseCases = [
    { description: 'exact 2-of-2 leaf', leaf },
    { description: 'truncated', leaf: leaf.slice(0, -1) },
    { description: 'OP_1 instead of OP_2', leaf: oneOfTwo },
    { description: 'recovery leaf', leaf: passthroughEscrow(party(1).xOnly).recoveryLeaf },
  ].map((c) => {
    const keys = parsePassthroughLeaf(c.leaf)
    return { description: c.description, leaf: bytesToHex(c.leaf), keys: keys ? { seller: bytesToHex(keys.seller), cosigner: bytesToHex(keys.cosigner) } : null }
  })
  const errors = [
    { description: 'seller key equal to the co-signer', seller_x_only: PINNED_COSIGNER_XONLY_HEX },
    { description: '31-byte key', seller_x_only: bytesToHex(party(1).xOnly.slice(1)) },
    { description: '33-byte key', seller_x_only: bytesToHex(test.publicKey) },
  ].map((c) => ({ ...c, ...outcome(() => ({ script: bytesToHex(passthroughEscrow(hexToBytes(c.seller_x_only)).script) })) }))
  return {
    description:
      'Escrow scripts rebuilt locally. `offer`: tr(NUMS, {<buyer> CHECKSIG <OW> CHECKSIGADD 2 NUMEQUAL, <delay> CSV DROP <buyer> CHECKSIG}) for several buyer keys (compressed or x-only) and recovery delays (1-16 encode as OP_N). `protected`: passthrough v4 tr(NUMS, {multi_a(2,S,C), <144> CSV DROP <S> CHECKSIG}) with control blocks and the sale leaf hash.',
    generated_by: GENERATOR,
    cosigner_x_only: OW_COSIGNER_XONLY,
    nums_internal_key: NUMS_INTERNAL_KEY,
    market_fee_address: OW_MARKET_FEE_ADDRESS,
    offer,
    protected: protectedEscrows,
    protected_errors: errors,
    passthrough_leaf_parse: parseCases,
  }
}

// ─── offers ─────────────────────────────────────────────────────────

const F = readJson('../fixtures/offers-server-psbts.json')

function offerProblems(fn: () => string[]): { problems: string[] } | { error: string } {
  try {
    return { problems: fn() }
  } catch (err) {
    return { error: (err as Error).message }
  }
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

function signOutcome(fn: () => string): Record<string, unknown> {
  try {
    const psbt = fn()
    return { signed: { psbt, inputs: signedInputs(psbt) } }
  } catch (err) {
    if (err instanceof OfferVerificationError) return { sign_problems: err.problems }
    return { sign_error: (err as Error).message }
  }
}

function mutate(hex: string, fn: (tx: btc.Transaction) => void): string {
  const tx = parse(hex)
  fn(tx)
  return bytesToHex(tx.toPSBT())
}
const scriptOf = (a: string) => btc.OutScript.encode(btc.Address(btc.NETWORK).decode(a))

function offerHeader() {
  return {
    buyer_wif: F.buyer_wif,
    seller_wif: F.seller_wif,
    buyer_address: F.buyer_address,
    seller_address: F.seller_address,
    delay: F.delay,
    escrow_value: F.escrow_value,
    price_sats: F.price_sats,
    market_fee_sats: F.market_fee_sats,
    item_outpoint: F.item_outpoint,
  }
}

function offerFundingVectors() {
  const buyer = keypairFromWIF(F.buyer_wif)
  const tr = publicKeyToP2TR(buyer.publicKey)
  const wpkh = btc.p2wpkh(buyer.publicKey)
  const escrow = offerEscrow(buyer.publicKey, F.delay)
  const psbt = (outputs: Array<{ script: Uint8Array; amount: bigint }>, o: { segwit?: boolean; foreignInput?: boolean; inputs?: number } = {}) => {
    const tx = new btc.Transaction({ allowUnknownOutputs: true })
    for (let i = 0; i < (o.inputs ?? 1); i++) {
      tx.addInput({
        txid: `${i + 1}${i + 1}`.repeat(32),
        index: i,
        witnessUtxo: { script: o.foreignInput && i === 0 ? scriptOf(F.seller_address) : o.segwit ? wpkh.script : tr.script, amount: 400_000n },
        ...(o.segwit ? {} : { tapInternalKey: buyer.xOnlyPublicKey }),
      })
    }
    for (const out of outputs) tx.addOutput(out)
    return bytesToHex(tx.toPSBT())
  }
  const E = BigInt(F.escrow_value)
  const base = { buyer_public_key: bytesToHex(buyer.publicKey), payment_address: tr.address, escrow_value: F.escrow_value, recovery_delay_blocks: F.delay }
  const cases = [
    { description: 'escrow plus change', psbt: psbt([{ script: escrow.script, amount: E }, { script: tr.script, amount: 400_000n - E - 500n }]), expect: base },
    { description: 'two inputs, escrow plus change', psbt: psbt([{ script: escrow.script, amount: E }, { script: tr.script, amount: 800_000n - E - 700n }], { inputs: 2 }), expect: base },
    { description: 'P2WPKH funding (ECDSA)', psbt: psbt([{ script: escrow.script, amount: E }, { script: wpkh.script, amount: 400_000n - E - 500n }], { segwit: true }), expect: { ...base, payment_address: wpkh.address } },
    { description: 'within a miner fee cap', psbt: psbt([{ script: escrow.script, amount: E }, { script: tr.script, amount: 400_000n - E - 500n }]), expect: { ...base, max_miner_fee_sats: 500 } },
    { description: 'above the miner fee cap', psbt: psbt([{ script: escrow.script, amount: E }]), expect: { ...base, max_miner_fee_sats: 1000 } },
    { description: 'a foreign output', psbt: psbt([{ script: escrow.script, amount: E }, { script: scriptOf(F.seller_address), amount: 1000n }]), expect: base },
    { description: 'wrong escrow amount', psbt: psbt([{ script: escrow.script, amount: E + 1n }]), expect: base },
    { description: 'no escrow output', psbt: psbt([{ script: tr.script, amount: 1000n }]), expect: base },
    { description: 'two escrow outputs', psbt: psbt([{ script: escrow.script, amount: E }, { script: escrow.script, amount: E }]), expect: base },
    { description: 'an input from another address', psbt: psbt([{ script: escrow.script, amount: E }, { script: tr.script, amount: 400_000n }], { inputs: 2, foreignInput: true }), expect: base },
    { description: 'outputs exceed inputs', psbt: psbt([{ script: escrow.script, amount: E }, { script: tr.script, amount: 400_000n }]), expect: base },
    { description: 'escrow for another recovery delay', psbt: psbt([{ script: escrow.script, amount: E }]), expect: { ...base, recovery_delay_blocks: F.delay + 1 } },
    { description: 'garbage instead of a PSBT', psbt: 'not a psbt', expect: base },
  ]
  return {
    description:
      'Offer funding PSBTs: verifyFundingPsbt problems (exact strings) and, when there are none, signOfferFunding output (every input signed with SIGHASH_DEFAULT on the key path or SIGHASH_ALL for P2WPKH, then finalized). Buyer = buyer_wif.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    ...offerHeader(),
    cases: cases.map((c) => {
      const expect = { ...c.expect, buyerPublicKey: c.expect.buyer_public_key, paymentAddress: c.expect.payment_address, escrowValue: c.expect.escrow_value, recoveryDelayBlocks: c.expect.recovery_delay_blocks, maxMinerFeeSats: (c.expect as any).max_miner_fee_sats }
      return {
        ...c,
        ...offerProblems(() => verifyFundingPsbt(c.psbt, expect)),
        ...signOutcome(() => signOfferFunding(c.psbt, buyer.privateKey, expect)),
      }
    }),
  }
}

interface PresignJson {
  scope: OfferScopeKind
  sign_input_index: number
  sighash: number
  recovery_delay_blocks: number
  escrow_value: number
  buyer_address?: string
  price_sats?: number
  market_fee_sats?: number
}

function offerPresignVectors() {
  const buyer = keypairFromWIF(F.buyer_wif)
  const item: PresignJson = { scope: 'item', sign_input_index: 1, sighash: 0x01, recovery_delay_blocks: F.delay, escrow_value: F.escrow_value, buyer_address: F.buyer_address, price_sats: F.price_sats, market_fee_sats: F.market_fee_sats }
  const scope: PresignJson = { scope: 'collection', sign_input_index: 0, sighash: 0x82, recovery_delay_blocks: F.delay, escrow_value: F.escrow_value }
  const cases: Array<{ description: string; psbt: string; params: PresignJson }> = [
    { description: 'item offer, SIGHASH_ALL', psbt: F.accept_psbt, params: item },
    { description: 'collection offer, NONE|ANYONECANPAY', psbt: F.scope_psbt, params: scope },
    { description: 'trait offer, NONE|ANYONECANPAY', psbt: F.scope_psbt, params: { ...scope, scope: 'trait' } },
    { description: 'sighash 0x83', psbt: F.accept_psbt, params: { ...item, sighash: 0x83 } },
    { description: 'ANYONECANPAY on an item offer', psbt: F.accept_psbt, params: { ...item, sighash: 0x82 } },
    { description: 'SIGHASH_ALL on a trait offer', psbt: F.scope_psbt, params: { ...scope, scope: 'trait', sighash: 0x01 } },
    { description: 'escrow built with another co-signer', psbt: F.bad_cosigner_accept_psbt, params: item },
    { description: 'seller paid more than agreed', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(1, { amount: BigInt(F.price_sats + 1) })), params: item },
    { description: 'item delivered elsewhere', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(0, { script: scriptOf(F.seller_address) })), params: item },
    { description: 'item output short', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(0, { amount: 330n })), params: item },
    { description: 'fee to another address', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(2, { script: scriptOf(F.buyer_address) })), params: item },
    { description: 'fee amount changed', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(2, { amount: BigInt(F.market_fee_sats - 1) })), params: item },
    { description: 'wrong input index', psbt: F.accept_psbt, params: { ...item, sign_input_index: 0 } },
    { description: 'input index out of range', psbt: F.accept_psbt, params: { ...item, sign_input_index: 5 } },
    { description: 'item offer without the sale terms', psbt: F.accept_psbt, params: { ...item, buyer_address: undefined } },
    { description: 'escrow value differs', psbt: F.accept_psbt, params: { ...item, escrow_value: F.escrow_value + 1 } },
    { description: 'recovery delay differs', psbt: F.accept_psbt, params: { ...item, recovery_delay_blocks: F.delay + 1 } },
    { description: 'collection template given as an item', psbt: F.scope_psbt, params: item },
    { description: 'escrow input asks for 0x82 on an item template', psbt: mutate(F.accept_psbt, (tx) => tx.updateInput(1, { sighashType: 0x82 }, true)), params: item },
    { description: 'extra leaf on the escrow input', psbt: mutate(F.accept_psbt, (tx) => {
      const e = offerEscrow(buyer.publicKey, F.delay)
      const p = btc.p2tr(hexToBytes(NUMS_INTERNAL_KEY), [{ script: e.saleLeaf }, { script: e.recoveryLeaf }], btc.NETWORK, true)
      tx.updateInput(1, { tapLeafScript: p.tapLeafScript }, true)
    }), params: item },
    { description: 'garbage instead of a PSBT', psbt: 'zz', params: item },
  ]
  const toTs = (p: PresignJson) => ({
    privateKey: buyer.privateKey,
    scope: p.scope,
    signInputIndex: p.sign_input_index,
    sighash: p.sighash,
    recoveryDelayBlocks: p.recovery_delay_blocks,
    escrowValue: p.escrow_value,
    buyerAddress: p.buyer_address,
    priceSats: p.price_sats,
    marketFeeSats: p.market_fee_sats,
  })
  return {
    description:
      'Offer acceptance templates the buyer pre-signs: verifyPresignPsbt problems (exact strings) and, when there are none, signOfferPresign output (the escrow input only, on the sale leaf, with the scope sighash). Buyer = buyer_wif. PSBTs from a harness mirroring ow-api offers.rs.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    ...offerHeader(),
    cases: cases.map((c) => ({
      ...c,
      ...offerProblems(() => verifyPresignPsbt(c.psbt, toTs(c.params))),
      ...signOutcome(() => signOfferPresign(c.psbt, toTs(c.params))),
    })),
  }
}

function offerAcceptVectors() {
  const seller = keypairFromWIF(F.seller_wif)
  const base = { my_address: F.seller_address, inscription_outpoint: F.item_outpoint, price_sats: F.price_sats, buyer_address: F.buyer_address }
  const other = 'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l'
  const withChange = mutate(F.accept_psbt, (tx) => tx.addOutput({ script: scriptOf(F.buyer_address), amount: 5000n }))
  const cases = [
    { description: 'server template', psbt: F.accept_psbt, expect: base },
    { description: 'without optional buyer checks', psbt: F.accept_psbt, expect: { ...base, buyer_address: undefined } },
    { description: 'not my item', psbt: F.accept_psbt, expect: { ...base, inscription_outpoint: `${'00'.repeat(32)}:0` } },
    { description: 'paid less than the price', psbt: F.accept_psbt, expect: { ...base, price_sats: F.price_sats + 1 } },
    { description: 'payment goes elsewhere', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(1, { script: scriptOf(F.buyer_address) })), expect: base },
    { description: 'item output short', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(0, { amount: 330n })), expect: base },
    { description: 'item returned to me', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(0, { script: scriptOf(F.seller_address) })), expect: base },
    { description: 'item to a non-buyer', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(0, { script: scriptOf(other) })), expect: base },
    { description: 'no marketplace fee', psbt: mutate(F.accept_psbt, (tx) => tx.updateOutput(2, { script: scriptOf(F.buyer_address) })), expect: base },
    { description: 'two marketplace fees', psbt: mutate(F.accept_psbt, (tx) => tx.addOutput({ script: scriptOf(OW_MARKET_FEE_ADDRESS), amount: 1000n })), expect: base },
    { description: 'one buyer change output', psbt: withChange, expect: { ...base, buyer_payment_address: F.buyer_address } },
    { description: 'change to someone other than the buyer payment address', psbt: withChange, expect: { ...base, buyer_payment_address: other } },
    { description: 'two extra outputs', psbt: mutate(withChange, (tx) => tx.addOutput({ script: scriptOf(other), amount: 5000n })), expect: base },
    { description: 'two outputs pay me', psbt: mutate(F.accept_psbt, (tx) => tx.addOutput({ script: scriptOf(F.seller_address), amount: 1000n })), expect: base },
    { description: 'input 0 asks for SINGLE|ANYONECANPAY', psbt: mutate(F.accept_psbt, (tx) => tx.updateInput(0, { sighashType: 0x83 }, true)), expect: base },
    { description: 'input 0 asks for SIGHASH_DEFAULT', psbt: mutate(F.accept_psbt, (tx) => tx.updateInput(0, { sighashType: 0x00 }, true)), expect: base },
    { description: 'a second input of mine', psbt: mutate(F.accept_psbt, (tx) => tx.addInput({ txid: '77'.repeat(32), index: 0, witnessUtxo: { script: scriptOf(F.seller_address), amount: 1000n } })), expect: base },
    { description: 'segwit seller address (cannot sign)', psbt: F.accept_psbt, expect: { ...base, my_address: other } },
    { description: 'garbage instead of a PSBT', psbt: '00', expect: base },
  ]
  const toTs = (e: any) => ({ myAddress: e.my_address, inscriptionOutpoint: e.inscription_outpoint, priceSats: e.price_sats, buyerAddress: e.buyer_address, buyerPaymentAddress: e.buyer_payment_address })
  return {
    description:
      'Seller accept/fill PSBTs: verifyAcceptPsbt problems (exact strings) and signAcceptPsbt output (input 0 only, key path, SIGHASH_ALL, final witness set) or its refusal. Seller = seller_wif.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    ...offerHeader(),
    cases: cases.map((c) => ({
      ...c,
      ...offerProblems(() => verifyAcceptPsbt(c.psbt, toTs(c.expect))),
      ...signOutcome(() => signAcceptPsbt(c.psbt, seller.privateKey, toTs(c.expect))),
    })),
  }
}

function offerCancelVectors() {
  const buyer = keypairFromWIF(F.buyer_wif)
  const base = { buyer_payment_address: F.buyer_address, escrow_value: F.escrow_value, recovery_delay_blocks: F.delay }
  const cases = [
    { description: 'server refund', psbt: F.cancel_psbt, params: base },
    { description: 'within a fee cap', psbt: F.cancel_psbt, params: { ...base, max_miner_fee_sats: 5000 } },
    { description: 'refund to another address', psbt: F.cancel_psbt, params: { ...base, buyer_payment_address: F.seller_address } },
    { description: 'fee above the cap', psbt: F.cancel_psbt, params: { ...base, max_miner_fee_sats: 100 } },
    { description: 'escrow value differs', psbt: F.cancel_psbt, params: { ...base, escrow_value: F.escrow_value - 1 } },
    { description: 'refund above the escrow', psbt: mutate(F.cancel_psbt, (tx) => tx.updateOutput(0, { amount: BigInt(F.escrow_value + 1) })), params: base },
    { description: 'recovery delay differs', psbt: F.cancel_psbt, params: { ...base, recovery_delay_blocks: 144 } },
    { description: 'refund asks for SIGHASH_DEFAULT', psbt: mutate(F.cancel_psbt, (tx) => tx.updateInput(0, { sighashType: 0x00 }, true)), params: base },
    { description: 'second output', psbt: mutate(F.cancel_psbt, (tx) => tx.addOutput({ script: scriptOf(F.seller_address), amount: 1000n })), params: base },
    { description: 'second input', psbt: mutate(F.cancel_psbt, (tx) => tx.addInput({ txid: '66'.repeat(32), index: 0, witnessUtxo: { script: scriptOf(F.buyer_address), amount: 1000n } })), params: base },
    { description: 'accept template given as a refund', psbt: F.accept_psbt, params: base },
  ]
  const toTs = (p: any) => ({ privateKey: buyer.privateKey, buyerPaymentAddress: p.buyer_payment_address, escrowValue: p.escrow_value, recoveryDelayBlocks: p.recovery_delay_blocks, maxMinerFeeSats: p.max_miner_fee_sats })
  return {
    description:
      'Offer refunds (build-cancel): verifyCancelPsbt problems (exact strings) and signOfferCancel output (escrow sale leaf, SIGHASH_ALL). Buyer = buyer_wif.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    ...offerHeader(),
    refund_value: F.refund_value,
    cases: cases.map((c) => ({
      ...c,
      ...offerProblems(() => verifyCancelPsbt(c.psbt, toTs(c.params))),
      ...signOutcome(() => signOfferCancel(c.psbt, toTs(c.params))),
    })),
  }
}

// ─── protected listing ──────────────────────────────────────────────

function listingVectors() {
  const check = (t: ReturnType<typeof templates>, o: { assetAddress?: string; price?: number; outpoint?: string; sellerAddr?: string } = {}) => ({
    passthrough_psbt: t.passthroughPsbtHex,
    sale_psbt: t.salePsbtHex,
    expected_outpoint: o.outpoint ?? ITEM,
    seller_address: o.sellerAddr ?? sellerAddress,
    expected_seller_sats: o.price ?? PRICE,
    asset_address: o.assetAddress ?? sellerAddress,
  })
  const tamper = (o: TemplateOptions) => templates(o)
  const prefilled = (() => {
    const t = templates()
    const pt = parse(t.passthroughPsbtHex)
    pt.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0x09) }, true)
    return { ...t, passthroughPsbtHex: bytesToHex(pt.toPSBT()) }
  })()
  const salePrefilled = (() => {
    const t = templates()
    const s = parse(t.salePsbtHex)
    s.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0x09) }, true)
    return { ...t, salePsbtHex: bytesToHex(s.toPSBT()) }
  })()
  const internalKeyOther = (() => {
    const t = templates()
    const pt = parse(t.passthroughPsbtHex)
    pt.updateInput(0, { tapInternalKey: attacker.xOnly }, true)
    return { ...t, passthroughPsbtHex: bytesToHex(pt.toPSBT()) }
  })()
  const twoInputs = (() => {
    const t = templates()
    const pt = parse(t.passthroughPsbtHex)
    pt.addInput({ txid: 'ee'.repeat(32), index: 0, witnessUtxo: { script: script(sellerAddress), amount: 1000n } })
    return { ...t, passthroughPsbtHex: bytesToHex(pt.toPSBT()) }
  })()
  const cases: Array<{ description: string; check: ReturnType<typeof check> }> = [
    { description: 'honest templates', check: check(templates()) },
    { description: 'without the asset address check', check: { ...check(templates()), asset_address: undefined as unknown as string } },
    { description: 'a passthrough that shaves exactly the 12-sat relay fee', check: check(tamper({ postage: 1_000, escrowValue: 988 })) },
    { description: 'passthrough asks for SIGHASH_ALL', check: check(tamper({ passthroughSighash: 0x01 })) },
    { description: 'an escrow co-signed by a key other than the pinned one', check: check(tamper({ cosigner: attacker.xOnly })) },
    { description: 'a passthrough of a different item', check: check(tamper({ passthroughSpends: `${'cd'.repeat(32)}:0` })) },
    { description: 'a passthrough with an extra output', check: check(tamper({ extraPassthroughOutput: true })) },
    { description: 'a passthrough that takes more than the 12-sat fee', check: check(tamper({ postage: 1_000, escrowValue: 987 })) },
    { description: 'an escrow below the 330-sat dust floor', check: check(tamper({ postage: 329 })) },
    { description: 'a passthrough asking for SIGHASH_SINGLE|ANYONECANPAY', check: check(tamper({ passthroughSighash: 0x83 })) },
    { description: 'a passthrough asking for a script-path signature', check: check(tamper({ passthroughLeaf: true })) },
    { description: 'a passthrough naming another internal key', check: check(internalKeyOther) },
    { description: 'a passthrough that already carries a signature', check: check(prefilled) },
    { description: 'a passthrough with two inputs', check: check(twoInputs) },
    { description: 'a sale template paying someone else', check: check(tamper({ salePayTo: attacker.address })) },
    { description: 'a sale template paying less than the price', check: check(tamper({ salePrice: PRICE - 1 })) },
    { description: 'a sale template with an extra output', check: check(tamper({ saleExtraOutput: true })) },
    { description: 'a sale template asking for SIGHASH_ALL', check: check(tamper({ saleSighash: 0x01 })) },
    { description: 'a sale template with a spendable internal key', check: check(tamper({ saleInternalKey: sellerXOnly })) },
    { description: 'a sale template that also carries the recovery leaf', check: check(tamper({ saleExtraLeaf: true })) },
    { description: 'a sale template spending another output', check: check(tamper({ saleSpendsVout: 1 })) },
    { description: 'a sale template that already carries a signature', check: check(salePrefilled) },
    { description: 'an item that is not at our address', check: check(templates(), { assetAddress: attacker.address }) },
    { description: 'a price below dust', check: check(tamper({ salePrice: 329 }), { price: 329 }) },
    { description: 'expected outpoint in upper case', check: check(templates(), { outpoint: ITEM.toUpperCase() }) },
    { description: 'garbage instead of the passthrough', check: { ...check(templates()), passthrough_psbt: 'nope' } },
    { description: 'garbage instead of the sale template', check: { ...check(templates()), sale_psbt: 'nope' } },
  ]
  const toTs = (c: ReturnType<typeof check>) => ({
    passthroughPsbtHex: c.passthrough_psbt,
    salePsbtHex: c.sale_psbt,
    expectedOutpoint: c.expected_outpoint,
    sellerAddress: c.seller_address,
    expectedSellerSats: c.expected_seller_sats,
    assetAddress: c.asset_address,
  })
  const templateCases = cases.map((c) => {
    const verify = outcome(() => {
      const r = assertListingTemplates({ ...toTs(c.check), sellerXOnly })
      return { escrow_value: r.escrowValue, passthrough_txid: r.passthroughTxid, escrow_script: bytesToHex(r.escrow.script) }
    })
    const sign = outcome(() => {
      const r = signListingTemplates({ ...toTs(c.check), privateKey: listingSeller.privateKey })
      return {
        psbt: r.psbt,
        sale_psbt: r.salePsbt,
        passthrough_txid: r.passthroughTxid,
        escrow_value: r.escrowValue,
        passthrough_inputs: signedInputs(r.psbt),
        sale_inputs: signedInputs(r.salePsbt),
      }
    })
    return { ...c, expect: verify, sign }
  })

  // Signed sale templates.
  const honest = templates()
  const signed = signListingTemplates({ ...toTs(check(honest)), privateKey: listingSeller.privateKey })
  const expectation = { passthrough_txid: honest.passthroughTxid, escrow_value: honest.escrowValue, seller_address: sellerAddress, price_sats: PRICE }
  const withSale = (fn: (tx: btc.Transaction) => void) => mutate(signed.salePsbt, fn)
  const [[saleKey, saleSig]] = parse(signed.salePsbt).getInput(0).tapScriptSig!
  const forged = saleSig.slice()
  forged[3] ^= 0x01
  const wrongByte = saleSig.slice()
  wrongByte[64] = 0x01
  const replaceSig = (sig: Uint8Array) => withSale((tx) => {
    tx.updateInput(0, { tapScriptSig: undefined }, true)
    tx.updateInput(0, { tapScriptSig: [[saleKey, sig]] }, true)
  })
  const signedCases = [
    { description: 'honest signed template', psbt: signed.salePsbt, expectation },
    { description: 'a stray key-path signature is stripped', psbt: withSale((tx) => tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0x09) }, true)), expectation },
    { description: 'unsigned template', psbt: honest.salePsbtHex, expectation },
    { description: 'only a key-path signature', psbt: mutate(honest.salePsbtHex, (tx) => tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0x09) }, true)), expectation },
    { description: 'forged signature', psbt: replaceSig(forged), expectation },
    { description: 'wrong sighash byte', psbt: replaceSig(wrongByte), expectation },
    { description: 'a second signature from another key', psbt: withSale((tx) => tx.updateInput(0, { tapScriptSig: [[{ pubKey: attacker.xOnly, leafHash: saleKey.leafHash }, saleSig]] }, true)), expectation },
    { description: 'finalized template', psbt: withSale((tx) => tx.updateInput(0, { finalScriptWitness: [saleSig] }, true)), expectation },
    { description: 'price changed', psbt: signed.salePsbt, expectation: { ...expectation, price_sats: PRICE + 1 } },
    { description: 'passthrough txid in upper case', psbt: signed.salePsbt, expectation: { ...expectation, passthrough_txid: honest.passthroughTxid.toUpperCase() } },
  ].map((c) => ({
    ...c,
    expect: outcome(() => {
      const out = assertSignedSaleTemplate(c.psbt, {
        sellerXOnly,
        passthroughTxid: c.expectation.passthrough_txid,
        escrowValue: c.expectation.escrow_value,
        sellerAddress: c.expectation.seller_address,
        priceSats: c.expectation.price_sats,
      })
      const input = parse(out).getInput(0)
      return { unchanged: out === c.psbt, has_key_sig: !!input.tapKeySig, inputs: signedInputs(out) }
    }),
  }))
  return {
    description:
      'Protected (passthrough v4) listing templates: assertListingTemplates outcome (escrow value, passthrough txid, escrow script, or the refusal code) and signListingTemplates output (passthrough key-path signature, sale script-path 0x83 pre-signature; nothing finalized). `signed_sale` covers assertSignedSaleTemplate. Seller = the "abandon … about" key.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    seller: { mnemonic: ABANDON, private_key: bytesToHex(listingSeller.privateKey), x_only_public_key: bytesToHex(sellerXOnly), address: sellerAddress },
    item: ITEM,
    price: PRICE,
    templates: templateCases,
    signed_sale: signedCases,
  }
}

function recoveryVectors() {
  const PASSTHROUGH_TXID = 'ef'.repeat(32)
  const build = (o: { sequence?: number; to?: string; fee?: number; cosigner?: Uint8Array; vout?: number; version?: number; value?: number; sighash?: number; extraOutput?: boolean } = {}) => {
    const escrow = escrowWith(o.cosigner ?? hexToBytes(PINNED_COSIGNER_XONLY_HEX))
    const value = BigInt(o.value ?? 1_000)
    const tx = new btc.Transaction({ ...OPTS, allowUnknownInputs: true, version: o.version ?? 2 })
    tx.addInput({
      txid: PASSTHROUGH_TXID,
      index: o.vout ?? 0,
      sequence: o.sequence ?? RECOVERY_DELAY_BLOCKS,
      witnessUtxo: { script: escrow.script, amount: value },
      tapInternalKey: hexToBytes(NUMS_INTERNAL_KEY_HEX),
      tapLeafScript: [escrow.recoveryEntry],
      sighashType: o.sighash ?? 0x00,
    })
    tx.addOutput({ script: script(o.to ?? sellerAddress), amount: value - BigInt(o.fee ?? 141 * 2) })
    if (o.extraOutput) tx.addOutput({ script: script(attacker.address), amount: 1n })
    return bytesToHex(tx.toPSBT())
  }
  const cases = [
    { description: 'honest recovery', psbt: build() },
    { description: 'SIGHASH_ALL field', psbt: build({ sighash: 0x01 }) },
    { description: 'fee at the cap', psbt: build({ fee: 283 }) },
    { description: 'fee one above the cap', psbt: build({ fee: 284 }) },
    { description: 'zero fee', psbt: build({ fee: 0 }) },
    { description: 'no timelock wait', psbt: build({ sequence: 1 }) },
    { description: 'pays someone else', psbt: build({ to: attacker.address }) },
    { description: 'fee above the rate', psbt: build({ fee: 200 * 2 }) },
    { description: 'fee far above the rate', psbt: build({ fee: 141 * 2 + 400 }) },
    { description: 'escrow with another co-signer', psbt: build({ cosigner: attacker.xOnly }) },
    { description: 'spends another output', psbt: build({ vout: 1 }) },
    { description: 'version 1', psbt: build({ version: 1 }) },
    { description: 'two outputs', psbt: build({ extraOutput: true }) },
    { description: 'SINGLE|ANYONECANPAY field', psbt: build({ sighash: 0x83 }) },
    { description: 'dust output', psbt: build({ value: 600 }) },
    { description: 'garbage', psbt: 'beef' },
  ].map((c) => ({ ...c, passthrough_txid: PASSTHROUGH_TXID, destination_address: sellerAddress, fee_rate: 2 }))
  cases.push({ description: 'passthrough txid in upper case', psbt: build(), passthrough_txid: PASSTHROUGH_TXID.toUpperCase(), destination_address: sellerAddress, fee_rate: 2 })
  cases.push({ description: 'fractional fee rate', psbt: build({ fee: 212 }), passthrough_txid: PASSTHROUGH_TXID, destination_address: sellerAddress, fee_rate: 1.5 })
  cases.push({ description: 'fee rate below 1 counts as 1', psbt: build({ fee: 142 }), passthrough_txid: PASSTHROUGH_TXID, destination_address: sellerAddress, fee_rate: 0.5 })
  return {
    description:
      'Seller recovery of a protected escrow through the <144> CSV leaf: assertRecoveryTemplate outcome and signRecovery output (finalized raw transaction and txid). Seller = the "abandon … about" key.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    seller: { private_key: bytesToHex(listingSeller.privateKey), x_only_public_key: bytesToHex(sellerXOnly), address: sellerAddress },
    cases: cases.map((c) => {
      const check = { psbtHex: c.psbt, passthroughTxid: c.passthrough_txid, destinationAddress: c.destination_address, feeRateSatVb: c.fee_rate }
      return {
        ...c,
        expect: outcome(() => {
          const r = assertRecoveryTemplate({ ...check, sellerXOnly })
          return { escrow_value: r.escrowValue, value_sat: r.valueSat, fee_sat: r.feeSat }
        }),
        sign: outcome(() => {
          const r = signRecovery({ ...check, privateKey: listingSeller.privateKey })
          return { rawtx: r.rawtx, txid: r.txid, value_sat: r.valueSat, fee_sat: r.feeSat }
        }),
      }
    }),
  }
}

// ─── protected purchase ─────────────────────────────────────────────

function saleJson(f: Fixture) {
  return {
    sale_txid: f.saleTxid,
    sale_psbt: f.salePsbt,
    parent: { txid: f.parent.txid, raw: f.parent.raw },
    listing: {
      outpoint: f.listing.outpoint,
      seller_address: f.listing.sellerAddress,
      creator_address: f.listing.creatorAddress ?? null,
      satoshi_price: f.listing.satoshiPrice,
      escrow_price_sat: f.listing.escrowPriceSat ?? null,
    },
  }
}

const verificationJson = (v: SaleVerification) => ({
  seller_proceeds_sat: v.sellerProceedsSat,
  market_fee_sat: v.marketFeeSat,
  creator_royalty_sat: v.creatorRoyaltySat,
  network_fee_sat: v.networkFeeSat,
  change_sat: v.changeSat,
  passthrough_input: v.passthroughInput,
  asset_output: v.assetOutput,
  buyer_inputs: v.buyerInputs,
  change_outputs: v.changeOutputs,
  sale_txid: v.saleTxid,
})

const toLink = (l: ReturnType<typeof saleJson>) => ({
  saleTxid: l.sale_txid,
  salePsbtHex: l.sale_psbt,
  parent: l.parent,
  listing: {
    outpoint: l.listing.outpoint,
    sellerAddress: l.listing.seller_address,
    creatorAddress: l.listing.creator_address,
    satoshiPrice: l.listing.satoshi_price,
    escrowPriceSat: l.listing.escrow_price_sat,
  },
})

function purchaseVectors() {
  const buyer = THROWAWAY.buyer.address
  const saleCase = (description: string, opts: FixtureOptions, extra: { fee_rate?: number; recipient_address?: string; market_fee_address?: string } = {}) => {
    const f = buildFixture(opts)
    const input = { ...saleJson(f), buyer_address: buyer, fee_rate: extra.fee_rate ?? 5, ...extra }
    return { description, input }
  }
  const sales = [
    saleCase('honest sale', {}),
    saleCase('escrow input already co-signed', { cosigned: true }),
    saleCase('seller-signed parent', { signedParent: true }),
    saleCase('unknown escrow price, lower payout', { payout: 49_000, listedEscrowPrice: null }),
    saleCase('no royalty', { royalty: 0 }),
    saleCase('fractional fee rate', {}, { fee_rate: 0.7 }),
    saleCase('payout above the escrow price', { payout: 50_001, networkFee: 999 }),
    saleCase('payout below the escrow price', { payout: 49_000 }),
    saleCase('payout to someone other than the seller', { payoutTo: THROWAWAY.attacker.address }),
    saleCase('item sent to someone else', { assetTo: THROWAWAY.attacker.address }),
    saleCase('item on the wrong sats', { assetValue: 600 }),
    saleCase('sat offsets shifted', { changeOneDelta: -546 }),
    saleCase('escrow co-signed by an unpinned key', { cosigner: THROWAWAY.attacker.xOnly }),
    saleCase('leaf that does not match the escrow prevout', { leafSeller: THROWAWAY.attacker.xOnly }),
    saleCase('escrow input with a spendable internal key', { internalKey: THROWAWAY.attacker.xOnly }),
    saleCase('escrow input with no leaf and no witness', { omitLeaf: true }),
    saleCase('co-signed witness whose seller signature is not 0x83', { cosigned: true, sellerSighash: 0x01 }),
    saleCase('passthrough moving a different item', { parentSpends: `${'cc'.repeat(32)}:0` }),
    saleCase('passthrough not hashing to its txid', { declaredParentTxid: 'dd'.repeat(32) }),
    saleCase('misstated escrow prevout value', { escrowPrevoutValue: 10_000 }),
    saleCase('extra output to an unknown party', { extraOutput: { to: THROWAWAY.attacker.address, value: 5_000 } }),
    saleCase('change sent to someone else', { changeTo: THROWAWAY.attacker.address }),
    saleCase('network fee far above the rate', { networkFee: 15_000 }),
    saleCase('outputs exceed inputs', { networkFee: -1 }),
    saleCase('funding input asking for NONE|ANYONECANPAY', { buyerSighash: 0x82 }),
    saleCase('funding input asking for SINGLE|ANYONECANPAY', { buyerSighash: 0x83 }),
    saleCase('funding input asking for SIGHASH_ALL', { buyerSighash: 0x01 }),
    saleCase('funding input that is not ours', { trailingOwner: THROWAWAY.attacker.address }),
    saleCase('funding input that already carries a witness', { prefilledWitness: true }),
    saleCase('no leading funding input', { noLeadingInput: true }),
    saleCase('no trailing fee input', { noTrailingInput: true }),
    saleCase('marketplace fee to another address', { marketTo: THROWAWAY.attacker.address }),
    saleCase('item delivered to the recipient', { assetTo: THROWAWAY.creator.address }, { recipient_address: THROWAWAY.creator.address }),
    saleCase('item not delivered to the recipient', {}, { recipient_address: THROWAWAY.attacker.address }),
  ]
  const f = buildFixture()
  sales.push({ description: 'garbage instead of a PSBT', input: { ...saleJson(f), sale_psbt: 'psbt_purchase_hex', buyer_address: buyer, fee_rate: 5 } })
  sales.push({ description: 'unparsable parent', input: { ...saleJson(f), parent: { txid: f.parent.txid, raw: 'zz' }, buyer_address: buyer, fee_rate: 5 } })
  const saleOut = sales.map((c) => ({
    ...c,
    expect: outcome(() => verificationJson(verifySale({
      salePsbtHex: c.input.sale_psbt,
      parent: c.input.parent,
      listing: toLink(c.input).listing,
      buyerAddress: c.input.buyer_address,
      feeRateSatVb: c.input.fee_rate,
      recipientAddress: (c.input as any).recipient_address,
    }))),
  }))

  const setupCase = (description: string, o: Parameters<typeof buildSetup>[0], fee_rate = 5) => {
    const s = buildSetup(o)
    return { description, psbt: s.psbt, txid: s.txid, buyer_address: buyer, fee_rate }
  }
  const setups = [
    setupCase('honest setup', {}),
    setupCase('second output to someone else', { secondOutputTo: THROWAWAY.attacker.address }),
    setupCase('fee far above the rate', { feeSat: 40_000 }),
    setupCase('three outputs', { thirdOutput: true }),
    setupCase('input that is not ours', { inputOwner: THROWAWAY.attacker.address }),
    setupCase('input asking for SINGLE|ANYONECANPAY', { sighash: 0x83 }),
    setupCase('zero fee', { feeSat: 0 }),
    setupCase('fee within a fractional rate', { feeSat: 300 }, 1.25),
    setupCase('fee above a fractional rate', { feeSat: 500 }, 1.25),
  ].map((c) => ({
    ...c,
    expect: outcome(() => {
      const v = verifySetup({ setupPsbtHex: c.psbt, buyerAddress: c.buyer_address, feeRateSatVb: c.fee_rate })
      return { txid: v.txid, fee_sat: v.feeSat, buyer_inputs: v.buyerInputs, change_outputs: v.changeOutputs }
    }),
  }))

  const now = Date.parse('2026-09-26T12:00:00Z')
  const one = saleJson(buildFixture())
  const setup = buildSetup()
  const onSetup = saleJson(buildFixture({ fundingTxid: setup.txid, fundingVouts: [0, 1] }))
  const first = buildFixture()
  const second = saleJson(buildFixture({ fundingTxid: first.saleTxid, item: 2, marketFee: 0, royalty: 0 }))
  const stray = saleJson(buildFixture({ item: 2, marketFee: 0, royalty: 0 }))
  const wrongVouts = (vouts: [number, number]) => saleJson(buildFixture({ fundingTxid: first.saleTxid, fundingVouts: vouts, item: 2, marketFee: 0, royalty: 0 }))
  const total = 50_000 + 1_350 + 500 + 1_000
  const purchase = (description: string, links: Array<ReturnType<typeof saleJson>>, extra: Record<string, unknown> = {}) => ({
    description,
    input: { links, buyer_address: buyer, fee_rate: 5, now, ...extra },
  })
  const purchases = [
    purchase('single item', [one]),
    purchase('with setup', [onSetup], { setup: { txid: setup.txid, psbt: setup.psbt } }),
    purchase('sale not funded by its setup', [one], { setup: { txid: setup.txid, psbt: setup.psbt } }),
    purchase('setup misdeclares its txid', [onSetup], { setup: { txid: 'ab'.repeat(32), psbt: setup.psbt } }),
    purchase('two chained items', [saleJson(first), second]),
    purchase('broken chain', [saleJson(first), stray]),
    purchase('same listing twice', [saleJson(first), saleJson(first)]),
    purchase('chain spends the previous item output', [saleJson(first), wrongVouts([0, 2])]),
    purchase('chain spends the previous payout output', [saleJson(first), wrongVouts([1, 5])]),
    purchase('charges more than the listed price', [saleJson(buildFixture({ payout: 60_000, listedEscrowPrice: null }))]),
    purchase('inflated marketplace fee', [saleJson(buildFixture({ marketFee: 9_000 }))]),
    purchase('royalties above the cap', [saleJson(buildFixture({ royalty: 9_000 }))]),
    purchase('sale not hashing to its declared txid', [{ ...one, sale_txid: 'ee'.repeat(32) }]),
    purchase('declared txid in upper case', [{ ...one, sale_txid: one.sale_txid.toUpperCase() }]),
    purchase('listing without a price', [{ ...one, listing: { ...one.listing, satoshi_price: 0 } }]),
    purchase('no items', []),
    purchase('fresh quote', [one], { expires_at: '2026-09-26T12:05:00Z' }),
    purchase('fresh quote with microseconds and an offset', [one], { expires_at: '2026-09-26T14:05:00.123456+02:00' }),
    purchase('fresh quote as epoch ms', [one], { expires_at: now + 1 }),
    purchase('expired quote', [one], { expires_at: '2026-09-26T11:59:59Z' }),
    purchase('quote expiring exactly now', [one], { expires_at: now }),
    purchase('unreadable expiry', [one], { expires_at: 'not a date' }),
    purchase('spend cap met exactly', [one], { max_total_sat: total }),
    purchase('over the spend cap', [one], { max_total_sat: total - 1 }),
    purchase('zero spend cap', [one], { max_total_sat: 0 }),
    purchase('zero fee rate', [one], { fee_rate: 0 }),
    purchase('item delivered to someone other than the recipient', [one], { recipient_address: THROWAWAY.attacker.address }),
    purchase('thirteen items', Array.from({ length: 13 }, () => one)),
  ].map((c) => ({
    ...c,
    expect: outcome(() => {
      const v = verifyPassthroughPurchase({
        links: c.input.links.map(toLink),
        setup: (c.input as any).setup,
        buyerAddress: c.input.buyer_address,
        feeRateSatVb: c.input.fee_rate as number,
        recipientAddress: (c.input as any).recipient_address,
        expiresAt: (c.input as any).expires_at,
        maxTotalSat: (c.input as any).max_total_sat,
        now: c.input.now,
      })
      return {
        seller_proceeds_sat: v.sellerProceedsSat,
        market_fee_sat: v.marketFeeSat,
        creator_royalty_sat: v.creatorRoyaltySat,
        network_fee_sat: v.networkFeeSat,
        setup_fee_sat: v.setupFeeSat,
        total_sat: v.totalSat,
        links: v.links.map(verificationJson),
        setup: v.setup ? { txid: v.setup.txid, fee_sat: v.setup.feeSat, buyer_inputs: v.setup.buyerInputs, change_outputs: v.setup.changeOutputs } : null,
      }
    }),
  }))

  const kp = keypairFromMnemonic(THROWAWAY.buyer.mnemonic)
  const signCase = (description: string, psbt: string, indexes: number[]) => ({ description, psbt, indexes })
  const signCases = [
    signCase('buyer inputs of a sale', f.salePsbt, [0, 2]),
    signCase('one buyer input', f.salePsbt, [2]),
    signCase('setup inputs', setup.psbt, [0]),
    signCase('buyer inputs asking for SIGHASH_ALL', buildFixture({ buyerSighash: 0x01 }).salePsbt, [0, 2]),
    signCase('the escrow input too', f.salePsbt, [0, 1, 2]),
    signCase('an input asking for SINGLE|ANYONECANPAY', buildFixture({ buyerSighash: 0x83 }).salePsbt, [0, 2]),
    signCase('nothing', f.salePsbt, []),
    signCase('an input of another wallet', buildFixture({ trailingOwner: THROWAWAY.attacker.address }).salePsbt, [0, 2]),
    signCase('an input asking for a script-path signature', mutate(f.salePsbt, (tx) => {
      const leafEntry = tx.getInput(1).tapLeafScript!
      tx.updateInput(0, { tapLeafScript: leafEntry }, true)
    }), [0]),
    signCase('garbage', 'feed', [0]),
  ].map((c) => ({
    ...c,
    expect: outcome(() => {
      const out = signOwnInputs({ psbt: c.psbt, indexes: c.indexes, privateKey: kp.privateKey, publicKey: kp.publicKey })
      return { psbt: out, inputs: signedInputs(out) }
    }),
  }))

  const fresh = [
    { expires_at: null, now },
    { expires_at: '2026-09-26T12:00:00.001Z', now },
    { expires_at: '2026-09-26T12:00:00Z', now },
    { expires_at: '2026-09-26T12:00:00.000Z', now: now - 1 },
    { expires_at: '2026-09-26T13:00:00+01:00', now },
    { expires_at: '2026-09-26T13:00:01+0100', now },
    { expires_at: '2026-09-26T06:30:01-05:30', now },
    { expires_at: '2026-09-26t12:00:01z', now },
    { expires_at: '2026-09-26 12:00:01Z', now },
    { expires_at: '2026-09-26T12:01Z', now },
    { expires_at: '2026-09-27', now },
    { expires_at: '2026-09-26', now },
    { expires_at: '2026-09-26T12:00:00.1234567Z', now: now + 122 },
    { expires_at: '2026-09-26T12:00:00.1Z', now: now + 99 },
    { expires_at: '2026-09-25T24:00:00Z', now: now - 12 * 3_600_000 - 1 },
    { expires_at: '2026-02-30T00:00:00Z', now: Date.parse('2026-03-01T00:00:00Z') },
    { expires_at: '2026-09-26T12:60:00Z', now },
    { expires_at: '2026-9-26T12:00:00Z', now },
    { expires_at: '2026-09-26T12:00:00.Z', now },
    { expires_at: '', now },
    { expires_at: 'tomorrow', now },
    { expires_at: now + 1, now },
    { expires_at: now, now },
  ].map((c) => ({ ...c, ...outcome(() => (assertQuoteFresh(c.expires_at, c.now), {})) }))

  return {
    description:
      'Protected (passthrough v4) purchase verification: verifySale / verifySetup / verifyPassthroughPurchase outcomes (derived amounts and indexes, or the refusal code), signOwnInputs output (buyer key-path signatures only, nothing finalized), and assertQuoteFresh. Buyer = the "abandon … about" key; every other key is a constant byte pattern. `now` is unix ms. Expiry text without a zone (local time in JavaScript) is deliberately absent: Rust refuses it as unreadable.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    buyer: { mnemonic: THROWAWAY.buyer.mnemonic, private_key: bytesToHex(kp.privateKey), address: buyer },
    market_fee_address: MARKET_FEE_ADDRESS,
    sales: saleOut,
    setups,
    purchases,
    sign_own_inputs: signCases,
    quote_fresh: fresh,
  }
}

// ─── cancel proof ───────────────────────────────────────────────────

function cancelProofVectors() {
  const owner = keypairFromMnemonic(ABANDON)
  const other = keypairFromMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')
  const TXID = 'ab'.repeat(16) + 'cd'.repeat(16)
  const c = (description: string, o: { outpoint?: string; value?: number; priv?: Uint8Array; pub?: Uint8Array } = {}) => ({
    description,
    outpoint: o.outpoint ?? `${TXID}:3`,
    value_sats: o.value ?? 546,
    private_key: bytesToHex(o.priv ?? owner.privateKey),
    public_key: bytesToHex(o.pub ?? owner.publicKey),
  })
  const cases = [
    c('listed outpoint'),
    c('x-only public key', { pub: owner.xOnlyPublicKey }),
    c('upper-case txid', { outpoint: `${TXID.toUpperCase()}:3` }),
    c('vout 0, large value', { outpoint: `${TXID}:0`, value: 2_099_999_999_999_999 }),
    c('vout at the u32 limit', { outpoint: `${TXID}:4294967295` }),
    c('another owner', { priv: other.privateKey, pub: other.publicKey }),
    c('mismatched key pair', { priv: other.privateKey }),
    c('not an outpoint', { outpoint: 'nope' }),
    c('short txid', { outpoint: `${TXID.slice(2)}:3` }),
    c('negative vout', { outpoint: `${TXID}:-1` }),
    c('vout above u32', { outpoint: `${TXID}:4294967296` }),
    c('zero value', { value: 0 }),
    c('value of 21M BTC', { value: 2_100_000_000_000_000 }),
  ].map((v) => ({
    ...v,
    expect: outcome(() => {
      const psbt = buildCancelProof({ outpoint: v.outpoint, valueSats: v.value_sats, privateKey: hexToBytes(v.private_key), publicKey: hexToBytes(v.public_key) })
      const s = inspectCancelProof(psbt)
      return {
        psbt,
        signature: bytesToHex(parse(psbt).getInput(0).finalScriptWitness![0]),
        shape: { inputs: s.inputs, outputs: s.outputs, sighash: s.sighash, signature_length: s.signatureLength, outpoint: s.outpoint, output_sats: Number(s.outputSats) },
      }
    }),
  }))
  // A seal-shaped proof (ALL|ANYONECANPAY, 65 bytes) must inspect as 0x81.
  const { script: ownerScript } = publicKeyToP2TR(owner.publicKey)
  const seal = new btc.Transaction({ allowUnknownOutputs: true })
  seal.addInput({ txid: hexToBytes(TXID), index: 3, witnessUtxo: { script: ownerScript, amount: 546n }, tapInternalKey: ownerScript.slice(2), sighashType: 0x81 })
  seal.addOutput({ script: ownerScript, amount: 1n })
  seal.updateInput(0, { finalScriptWitness: [new Uint8Array([...new Uint8Array(64).fill(1), 0x81])] }, true)
  const sealHex = bytesToHex(seal.toPSBT())
  const s = inspectCancelProof(sealHex)
  return {
    description:
      'Cancel proofs for POST /market/cancel-escrow: buildCancelProof output (one input spending the listed outpoint, one 21M BTC output to the owner, key-path SIGHASH_DEFAULT signature, finalized) or the refusal code, and inspectCancelProof shapes.',
    generated_by: GENERATOR,
    aux_rand: ZERO_AUX_HEX,
    output_sats: 2_100_000_000_000_000,
    cases,
    inspect: [{ description: 'ALL|ANYONECANPAY seal', psbt: sealHex, shape: { inputs: s.inputs, outputs: s.outputs, sighash: s.sighash, signature_length: s.signatureLength, outpoint: s.outpoint, output_sats: Number(s.outputSats) } }],
  }
}

/** Every vector file, keyed by its name in `fixtures/`. */
export async function buildSharedVectors(): Promise<Record<string, unknown>> {
  const restore = useZeroAuxRand()
  try {
    return {
      'bip39.json': bip39Vectors(),
      'derivation.json': derivationVectors(),
      'bip322.json': await bip322Vectors(),
      'escrow.json': escrowVectors(),
      'offer-funding.json': offerFundingVectors(),
      'offer-presign.json': offerPresignVectors(),
      'offer-accept.json': offerAcceptVectors(),
      'offer-cancel.json': offerCancelVectors(),
      'listing-templates.json': listingVectors(),
      'recovery.json': recoveryVectors(),
      'purchase-verify.json': purchaseVectors(),
      'cancel-proof.json': cancelProofVectors(),
    }
  } finally {
    restore()
  }
}
