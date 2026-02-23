import React, { useEffect } from 'react'
import { useTapStore } from '../stores/tapStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface TapPageProps {
  address: string
  walletName: string
  cursor: number
  height?: number
}

const columns: Column[] = [
  { header: 'Ticker', width: 12 },
  { header: 'Balance', width: 18, align: 'right' },
  { header: 'Available', width: 18, align: 'right' },
  { header: 'Transferable', width: 18, align: 'right' },
]

export function TapPage({ address, cursor, height }: TapPageProps) {
  const tokens = useTapStore((s) => s.data[address])
  const loading = useTapStore((s) => s.loading[address])

  useEffect(() => { useTapStore.getState().fetch(address) }, [address])

  const rows = !tokens && loading
    ? [['Loading...', '', '', '']]
    : (tokens || []).map((t) => [
        t.ticker || '',
        String(t.overall_balance ?? ''),
        String(t.available_balance ?? ''),
        String(t.transferable_balance ?? ''),
      ])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title="TAP" />
}
