import { describe, it, expect, vi } from 'vitest'
import * as btc from '@scure/btc-signer'
import type { WalletInscription } from '@ow-cli/api'
import { outpointToTxidVout } from '@ow-cli/api'
import { keypairFromMnemonic, publicKeyToP2TR, bytesToHex } from '@ow-cli/core'
import {
  buildInscriptionMap,
  decodePsbtPreview,
  lostToFeeWarning,
  printPsbtPreview,
} from '../src/utils/psbt-preview.js'
// Real, trimmed `/wallet/:address` response (see packages/api/__tests__/fixtures).
import walletFx from '../../api/__tests__/fixtures/wallet.json' with { type: 'json' }

const inscriptions = walletFx.inscriptions as unknown as WalletInscription[]
const punk = inscriptions[0] // 1324 sats, sat_offset 0
const puppet = inscriptions[1] // 10000 sats, sat_offset 0

const kp = keypairFromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
const me = publicKeyToP2TR(kp.publicKey)
const FUNDING_TXID = 'aa'.repeat(32)

function psbt(inputs: { outpoint: string; value: number }[], outputs: number[]): string {
  const tx = new btc.Transaction()
  for (const i of inputs) {
    const [txid, vout] = i.outpoint.split(':')
    tx.addInput({ txid, index: Number(vout), witnessUtxo: { script: me.script, amount: BigInt(i.value) } })
  }
  for (const v of outputs) tx.addOutputAddress(me.address, BigInt(v))
  return bytesToHex(tx.toPSBT())
}

const punkOutpoint = outpointToTxidVout(punk.outpoint!.outpoint)
const puppetOutpoint = outpointToTxidVout(puppet.outpoint!.outpoint)

describe('buildInscriptionMap', () => {
  it('keys the live serialized outpoint object by txid:vout', () => {
    const map = buildInscriptionMap(inscriptions)
    expect([...map.keys()]).toEqual([
      'a29e0b176529fb70aed4b2a33ac978db4bc72b5801bfe496093f7854899b1470:0',
      'f5c605b464aa837634f996fe8794fc2b314de112791374e569850379b35f2873:0',
    ])
    expect(map.get(puppetOutpoint)).toEqual([{ label: 'Bitcoin Puppet #7780 (#53149085)', satOffset: 0 }])
  })

  it('skips inscriptions without a location', () => {
    expect(buildInscriptionMap([{ ...punk, outpoint: null }]).size).toBe(0)
  })
})

describe('decodePsbtPreview', () => {
  const map = buildInscriptionMap(inscriptions)

  it('recognises inscription inputs and traces them to outputs', () => {
    const hex = psbt(
      [
        { outpoint: punkOutpoint, value: 1324 },
        { outpoint: `${FUNDING_TXID}:1`, value: 50000 },
      ],
      [330, 50000],
    )
    const preview = decodePsbtPreview(hex, map)
    expect(preview.inputs[0].outpoint).toBe(punkOutpoint)
    expect(preview.inputs[0].inscriptionId).toBe('Bitcoin Punk #0702 (#26318)')
    expect(preview.inputs[1].inscriptionId).toBeUndefined()
    expect(preview.outputs[0].inscriptions).toEqual(['Bitcoin Punk #0702 (#26318)'])
    expect(preview.lostToFee).toEqual([])
    expect(preview.fee).toBe(1324 + 50000 - 330 - 50000)
    expect(lostToFeeWarning(preview)).toBeNull()
  })

  it('fires LOST TO FEE when an inscription sat lands in the fee', () => {
    // Funding input first, inscription last, outputs smaller than the funding
    // input: the inscription's sat (offset 50000) is past every output.
    const hex = psbt(
      [
        { outpoint: `${FUNDING_TXID}:0`, value: 50000 },
        { outpoint: puppetOutpoint, value: 10000 },
      ],
      [49000],
    )
    const preview = decodePsbtPreview(hex, map)
    expect(preview.inputs[1].inscriptionId).toBe('Bitcoin Puppet #7780 (#53149085)')
    expect(preview.outputs[0].inscriptions).toEqual([])
    expect(preview.lostToFee).toEqual(['Bitcoin Puppet #7780 (#53149085)'])
    expect(lostToFeeWarning(preview)).toMatch(/LOST TO FEE!.*Bitcoin Puppet #7780/)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      printPsbtPreview(preview)
      expect(log.mock.calls.flat().join('\n')).toContain('LOST TO FEE!')
    } finally {
      log.mockRestore()
    }
  })

  it('honours sat_offset inside the inscription output', () => {
    const offsetMap = buildInscriptionMap([
      { ...puppet, outpoint: { ...puppet.outpoint!, sat_offset: 400 } },
    ])
    const hex = psbt([{ outpoint: puppetOutpoint, value: 10000 }], [330, 9000])
    const preview = decodePsbtPreview(hex, offsetMap)
    expect(preview.outputs[0].inscriptions).toEqual([])
    expect(preview.outputs[1].inscriptions).toEqual(['Bitcoin Puppet #7780 (#53149085)'])
  })

  it('shows input txids in display order', () => {
    const hex = psbt([{ outpoint: puppetOutpoint, value: 10000 }], [9000])
    expect(decodePsbtPreview(hex, map).inputs[0].txid).toBe(puppetOutpoint.split(':')[0])
  })
})
