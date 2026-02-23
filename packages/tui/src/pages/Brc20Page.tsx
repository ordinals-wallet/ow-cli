import React, { useEffect } from 'react'
import { useBrc20Store } from '../stores/brc20Store.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface Brc20PageProps {
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

export function Brc20Page({ address, cursor, height }: Brc20PageProps) {
  const tokens = useBrc20Store((s) => s.data[address])
  const loading = useBrc20Store((s) => s.loading[address])

  useEffect(() => { useBrc20Store.getState().fetch(address) }, [address])

  const rows = !tokens && loading
    ? [['Loading...', '', '', '']]
    : (tokens || []).map((t) => [t.ticker || '', t.overall_balance || '', t.available_balance || '', t.transferable_balance || ''])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title="BRC-20" />
}
