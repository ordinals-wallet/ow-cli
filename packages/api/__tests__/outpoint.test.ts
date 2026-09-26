import { describe, it, expect } from 'vitest'
import {
  outpointToTxidVout,
  parseSerializedOutpoint,
  isSerializedOutpoint,
  txidVoutToSerialized,
} from '../src/outpoint.js'
import inscriptionFx from '../../../fixtures/api/inscription.json' with { type: 'json' }
import outpointFx from '../../../fixtures/api/inscription-outpoint.json' with { type: 'json' }

describe('serialized outpoints', () => {
  it('matches the satpoint the API reports for the same inscription', () => {
    // /inscription/:id/outpoint (serialized) and /inscription/:id (satpoint) are
    // independent live responses for the same inscription.
    const [txid, vout] = inscriptionFx.satpoint.split(':')
    expect(outpointToTxidVout(outpointFx.inscription.outpoint)).toBe(`${txid}:${vout}`)
  })

  it('decodes vout as a little-endian u32', () => {
    const txid = 'ab'.repeat(32)
    expect(parseSerializedOutpoint(txid + '01000000')).toEqual({ txid, vout: 1 })
    expect(parseSerializedOutpoint(txid + '00010000').vout).toBe(256)
    expect(parseSerializedOutpoint(txid + 'ffffffff').vout).toBe(0xffffffff)
  })

  it('round-trips with txidVoutToSerialized', () => {
    const s = outpointFx.inscription.outpoint
    expect(txidVoutToSerialized(outpointToTxidVout(s))).toBe(s)
    const t = `${'0123456789abcdef'.repeat(4)}:4294967295`
    expect(outpointToTxidVout(txidVoutToSerialized(t))).toBe(t)
  })

  it('passes txid:vout through unchanged', () => {
    const t = '33d3057475e332a278ae0376408490c52a6cab506588b88d3690fabc974e11e9:0'
    expect(outpointToTxidVout(t)).toBe(t)
  })

  it('rejects malformed input', () => {
    expect(isSerializedOutpoint('abc')).toBe(false)
    expect(() => outpointToTxidVout('abc')).toThrow(TypeError)
    expect(() => parseSerializedOutpoint('zz'.repeat(36))).toThrow(TypeError)
    expect(() => txidVoutToSerialized('nope')).toThrow(TypeError)
  })
})
