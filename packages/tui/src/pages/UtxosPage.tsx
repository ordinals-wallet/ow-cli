import React, { useEffect } from 'react'
import { formatSats } from '@ow-cli/shared'
import { useUtxoStore } from '../stores/utxoStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface UtxosPageProps {
  address: string
  walletName: string
  cursor: number
  height?: number
}

const columns: Column[] = [
  { header: 'Outpoint', width: 40 },
  { header: 'Value', width: 18, align: 'right' },
  { header: 'Confirmed', width: 10 },
]

export function UtxosPage({ address, cursor, height }: UtxosPageProps) {
  const utxos = useUtxoStore((s) => s.data[address])
  const loading = useUtxoStore((s) => s.loading[address])

  useEffect(() => { useUtxoStore.getState().fetch(address) }, [address])

  const rows = !utxos && loading
    ? [['Loading...', '', '']]
    : (utxos || []).map((u) => [
        `${u.txid.slice(0, 12)}…${u.txid.slice(-8)}:${u.vout}`,
        formatSats(u.value),
        u.status.confirmed ? 'yes' : 'no',
      ])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title="UTXOs" />
}
