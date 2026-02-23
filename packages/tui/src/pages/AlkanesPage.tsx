import React, { useEffect } from 'react'
import { useAlkaneStore } from '../stores/alkaneStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface AlkanesPageProps {
  address: string
  walletName: string
  cursor: number
  height?: number
}

const columns: Column[] = [
  { header: 'ID', width: 16 },
  { header: 'Balance', width: 18, align: 'right' },
]

export function AlkanesPage({ address, cursor, height }: AlkanesPageProps) {
  const alkanes = useAlkaneStore((s) => s.data[address])
  const loading = useAlkaneStore((s) => s.loading[address])

  useEffect(() => { useAlkaneStore.getState().fetch(address) }, [address])

  const rows = !alkanes && loading
    ? [['Loading...', '']]
    : (alkanes || []).map((a) => [a.id || '', a.balance || ''])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title="Alkanes" />
}
