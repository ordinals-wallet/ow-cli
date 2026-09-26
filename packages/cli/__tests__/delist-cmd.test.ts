import { describe, it, expect } from 'vitest'
import type { DelistResult } from '@ow-cli/shared'
import { formatDelistResult } from '../src/commands/market.js'

const base: DelistResult = {
  kind: 'protected',
  inscriptionId: 'c'.repeat(64) + 'i0',
  outpoint: `${'ab'.repeat(32)}:1`,
  routedBy: 'outpoint',
  transition: 'cancelled',
  state: 'cancelled',
  escrowId: 'e1',
  response: { success: true },
  verification: { listingGone: true, protectionRetired: true },
}

describe('ow market delist output', () => {
  it('names the kind it cancelled', () => {
    expect(formatDelistResult(base)).toContain('Cancelled the snipe-protected listing.')
    expect(formatDelistResult({ ...base, kind: 'standard', routedBy: 'inscription_id' })).toContain('Cancelled the standard listing.')
  })

  it('says when it was already cancelled', () => {
    expect(formatDelistResult({ ...base, transition: 'already_cancelled' })).toContain('already cancelled')
  })

  it('surfaces a listing that still shows after the cancel', () => {
    const out = formatDelistResult({ ...base, verification: { listingGone: false, protectionRetired: false } })
    expect(out).toMatch(/still shows the listing/)
    expect(out).toMatch(/still shows as active/)
  })
})
