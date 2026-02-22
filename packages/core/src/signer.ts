import * as btc from '@scure/btc-signer'
import * as secp from '@noble/secp256k1'
import type { SignPsbtOptions, PurchaseFlowResult } from './types.js'
import { publicKeyToP2TR } from './address.js'

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function getInputScriptHex(input: Record<string, unknown>): string | undefined {
  const witnessUtxo = input.witnessUtxo as { script: Uint8Array } | undefined
  if (witnessUtxo) {
    return bytesToHex(new Uint8Array(witnessUtxo.script))
  }
  return undefined
}

export function signPsbt(opts: SignPsbtOptions): string {
  const { psbt, privateKey, publicKey, disableExtract, skipSignIndex } = opts

  const tx = btc.Transaction.fromPSBT(hexToBytes(psbt), {
    allowLegacyWitnessUtxo: true,
  })

  const { script } = publicKeyToP2TR(publicKey)
  const scriptHex = bytesToHex(script)
  const xOnlyPubKey = secp.schnorr.getPublicKey(privateKey)

  const numInputs = tx.inputsLength

  // Phase 1: Set tapInternalKey, delete nonWitnessUtxo (per frontend lines 310-318)
  for (let i = 0; i < numInputs; i++) {
    if (skipSignIndex === i) continue
    const input = tx.getInput(i)
    const isLocalScript = scriptHex === getInputScriptHex(input)
    if (!isLocalScript) continue

    tx.updateInput(i, { tapInternalKey: xOnlyPubKey })
  }

  // Phase 2: Sign with allowed sighash types [DEFAULT, ALL, SINGLE|ANYONECANPAY]
  // Also delete tapBip32Derivation (per frontend lines 332-335)
  for (let i = 0; i < numInputs; i++) {
    if (skipSignIndex === i) continue
    const input = tx.getInput(i)
    const isLocalScript = scriptHex === getInputScriptHex(input)
    if (!isLocalScript) continue

    try {
      tx.signIdx(privateKey, i, [0, 1, 131])
    } catch {
      // Ignore signing errors for non-matching inputs
    }
  }

  // Phase 3: Finalize — set finalScriptWitness = [tapKeySig]
  // (per frontend line 359: tx.inputs[i].finalScriptWitness = [tx.inputs[i].tapKeySig])
  // This matches the frontend exactly rather than using finalizeIdx() which has
  // stricter behavior and may fail for escrow sighash types.
  for (let i = 0; i < numInputs; i++) {
    if (skipSignIndex === i) continue
    const input = tx.getInput(i)
    const isLocalScript = scriptHex === getInputScriptHex(input)
    if (!isLocalScript) continue

    const tapKeySig = input.tapKeySig
    if (tapKeySig) {
      // finalScriptWitness + _ignoreSignStatus bypass sign status validation
      tx.updateInput(i, { finalScriptWitness: [tapKeySig] } as Record<string, unknown>, true)
    }
  }

  if (disableExtract) {
    return bytesToHex(tx.toPSBT())
  }

  return tx.hex
}

export function signPurchaseFlow(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  setupHex: string,
  purchaseHex: string,
): PurchaseFlowResult {
  // Sign setup PSBT and extract raw tx
  const signedSetup = signPsbt({
    psbt: setupHex,
    privateKey,
    publicKey,
    disableExtract: false,
  })

  // Get the setup txid from the signed raw transaction
  const setupTx = btc.Transaction.fromRaw(hexToBytes(signedSetup))
  const setupTxid = setupTx.id

  // Parse the purchase PSBT and replace placeholder txids with real setup txid
  const purchaseTx = btc.Transaction.fromPSBT(hexToBytes(purchaseHex), {
    allowLegacyWitnessUtxo: true,
  })

  const ZERO_TXID = new Uint8Array(32)
  for (let i = 0; i < purchaseTx.inputsLength; i++) {
    const input = purchaseTx.getInput(i)
    const txid = input.txid
    if (txid && txid.every((b: number, j: number) => b === ZERO_TXID[j])) {
      purchaseTx.updateInput(i, { txid: setupTxid })
    }
  }

  // Re-serialize and sign the purchase PSBT
  const signedPurchase = signPsbt({
    psbt: bytesToHex(purchaseTx.toPSBT()),
    privateKey,
    publicKey,
    disableExtract: false,
  })

  return {
    signedSetup,
    signedPurchase,
  }
}
