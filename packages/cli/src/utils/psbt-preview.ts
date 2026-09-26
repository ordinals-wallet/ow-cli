import * as btc from '@scure/btc-signer'
import { outpointToTxidVout } from '@ow-cli/api'
import type { WalletInscription } from '@ow-cli/api'
import { hexToBytes, bytesToHex } from '@ow-cli/core'
import { formatTable, formatSats } from '../output.js'

/** An inscription known to sit in a given input, at a sat offset inside it. */
export interface KnownInscription {
  label: string
  satOffset: number
}

/** `txid:vout` → inscriptions in that output. */
export type InscriptionMap = Map<string, KnownInscription[]>

export interface PsbtPreview {
  inputs: { txid: string; vout: number; value: number; outpoint: string; inscriptionId?: string }[]
  outputs: { address: string; value: number; inscriptions: string[] }[]
  fee: number
  /** Labels of inscriptions whose sat falls into the fee. Non-empty = do not sign. */
  lostToFee: string[]
}

function labelFor(ins: WalletInscription): string {
  return ins.meta?.name || ins.collection?.name
    ? `${ins.meta?.name ?? ins.collection?.name} (#${ins.num})`
    : ins.id
}

/**
 * Keys wallet inscriptions by `txid:vout`. Wallet endpoints return
 * `outpoint: { outpoint: <72-hex serialized>, sat_offset, sats }`.
 */
export function buildInscriptionMap(inscriptions: WalletInscription[]): InscriptionMap {
  const map: InscriptionMap = new Map()
  for (const ins of inscriptions) {
    const loc = ins.outpoint
    if (!loc?.outpoint) continue
    let key: string
    try {
      key = outpointToTxidVout(loc.outpoint)
    } catch {
      continue
    }
    const list = map.get(key) ?? []
    list.push({ label: labelFor(ins), satOffset: loc.sat_offset ?? 0 })
    map.set(key, list)
  }
  return map
}

export function decodePsbtPreview(psbtHex: string, inscriptionMap: InscriptionMap): PsbtPreview {
  const tx = btc.Transaction.fromPSBT(hexToBytes(psbtHex), { allowLegacyWitnessUtxo: true })

  const inputs: PsbtPreview['inputs'] = []
  const located: { label: string; absOffset: bigint }[] = []
  let globalOffset = 0n
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i)
    const txid = inp.txid ? bytesToHex(inp.txid) : 'unknown' // scure returns display (big-endian) order
    const vout = inp.index ?? 0
    const value = Number(inp.witnessUtxo?.amount ?? 0n)
    const outpoint = `${txid}:${vout}`
    const known = inscriptionMap.get(outpoint) ?? []
    inputs.push({
      txid,
      vout,
      value,
      outpoint,
      inscriptionId: known.length > 0 ? known.map((k) => k.label).join(', ') : undefined,
    })
    for (const k of known) located.push({ label: k.label, absOffset: globalOffset + BigInt(k.satOffset) })
    globalOffset += BigInt(value)
  }

  const outputs: PsbtPreview['outputs'] = []
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i)
    outputs.push({
      address: tx.getOutputAddress(i) ?? 'unknown',
      value: Number(out.amount ?? 0n),
      inscriptions: [],
    })
  }

  // Ordinal theory FIFO: the n-th input sat becomes the n-th output sat;
  // sats past the last output are paid to the miner as fee.
  const lostToFee: string[] = []
  for (const { label, absOffset } of located) {
    let cumulative = 0n
    let found = false
    for (const out of outputs) {
      if (absOffset >= cumulative && absOffset < cumulative + BigInt(out.value)) {
        out.inscriptions.push(label)
        found = true
        break
      }
      cumulative += BigInt(out.value)
    }
    if (!found) lostToFee.push(label)
  }

  const fee = Number(globalOffset) - outputs.reduce((s, o) => s + o.value, 0)
  return { inputs, outputs, fee, lostToFee }
}

export function lostToFeeWarning(preview: PsbtPreview): string | null {
  if (preview.lostToFee.length === 0) return null
  return `⚠ ${preview.lostToFee.length} inscription(s) LOST TO FEE! ${preview.lostToFee.join(', ')}`
}

export function printPsbtPreview(preview: PsbtPreview, title = 'Transaction Preview'): void {
  console.log(`\n${title}`)
  console.log('─'.repeat(40))

  console.log(`\nInputs (${preview.inputs.length}):`)
  const inputRows = preview.inputs.map((inp, i) => {
    const shortTxid = inp.txid === 'unknown' ? 'unknown' : `${inp.txid.slice(0, 8)}…${inp.txid.slice(-4)}:${inp.vout}`
    const label = inp.inscriptionId ?? '(fee input)'
    return [String(i), shortTxid, formatSats(inp.value), label]
  })
  console.log(formatTable(['#', 'Outpoint', 'Value', 'Inscription'], inputRows))

  console.log(`\nOutputs (${preview.outputs.length}):`)
  const outputRows = preview.outputs.map((out, i) => {
    const shortAddr = out.address === 'unknown' ? 'unknown' : `${out.address.slice(0, 8)}…${out.address.slice(-4)}`
    const label = out.inscriptions.length > 0 ? out.inscriptions.map((id) => `${id} ✓`).join(', ') : '(change)'
    return [String(i), shortAddr, formatSats(out.value), label]
  })
  console.log(formatTable(['#', 'Address', 'Value', 'Inscription'], outputRows))

  const changeValue = preview.outputs
    .filter((o) => o.inscriptions.length === 0)
    .reduce((s, o) => s + o.value, 0)
  console.log(`\nFee: ${formatSats(preview.fee)}`)
  if (changeValue > 0) {
    console.log(`Change: ${formatSats(changeValue)}`)
  }
  const warning = lostToFeeWarning(preview)
  if (warning) console.log(`\n${warning}`)
}
