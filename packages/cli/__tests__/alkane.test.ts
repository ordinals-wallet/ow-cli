import { describe, it, expect } from 'vitest'
import type { AlkanesBalance } from '@ow-cli/api'
import { alkanesBalanceRows, ALKANES_COLUMNS } from '../src/commands/alkane.js'
// Real, trimmed `/wallet/:address/alkanes-balance` response.
import alkanesFx from '../../api/__tests__/fixtures/alkanes-balance.json' with { type: 'json' }

describe('alkanes balance rows', () => {
  it('prints ticker, id and whole-unit balances from the live shape', () => {
    const rows = alkanesBalanceRows(alkanesFx as AlkanesBalance[])
    expect(ALKANES_COLUMNS).toEqual(['Ticker', 'ID', 'Balance', 'Available'])
    expect(rows[0]).toEqual(['DIESEL', '2:0', '125', '125'])
    expect(rows[1]).toEqual(['METHANE', '2:16', '170000', '170000'])
  })

  it('handles the empty cold-wallet response', () => {
    expect(alkanesBalanceRows([])).toEqual([])
  })
})
