import React, { useEffect } from 'react'
import { useRuneStore } from '../stores/runeStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface RunesPageProps {
  address: string
  walletName: string
  cursor: number
  height?: number
}

const columns: Column[] = [
  { header: 'Rune', width: 28 },
  { header: 'Balance', width: 18, align: 'right' },
  { header: 'Symbol', width: 8 },
  { header: 'ID', width: 12 },
]

export function RunesPage({ address, cursor, height }: RunesPageProps) {
  const runes = useRuneStore((s) => s.data[address])
  const loading = useRuneStore((s) => s.loading[address])

  useEffect(() => { useRuneStore.getState().fetch(address) }, [address])

  const rows = !runes && loading
    ? [['Loading...', '', '', '']]
    : (runes || []).map((r) => [r.name || '', r.amount || '', r.symbol || '', r.rune_id || ''])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title="Runes" />
}
