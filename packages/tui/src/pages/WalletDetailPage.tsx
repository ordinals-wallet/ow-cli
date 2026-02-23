import React, { useEffect } from 'react'
import type { WalletInfo } from '@ow-cli/shared'
import { useWalletStore } from '../stores/walletStore.js'
import { useRuneStore } from '../stores/runeStore.js'
import { useBrc20Store } from '../stores/brc20Store.js'
import { useAlkaneStore } from '../stores/alkaneStore.js'
import { useTapStore } from '../stores/tapStore.js'
import { useUtxoStore } from '../stores/utxoStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

export const categories = [
  'Inscriptions',
  'Runes',
  'BRC-20',
  'UTXOs',
  'Alkanes',
  'TAP',
] as const

export type Category = typeof categories[number]

interface WalletDetailPageProps {
  wallet: WalletInfo
  cursor: number
  height?: number
}

const columns: Column[] = [
  { header: 'Category', width: 20 },
  { header: 'Count', width: 10, align: 'right' },
]

export function WalletDetailPage({ wallet, cursor, height }: WalletDetailPageProps) {
  const addr = wallet.address
  const wd = useWalletStore((s) => s.data[addr])
  const runes = useRuneStore((s) => s.data[addr])
  const brc20 = useBrc20Store((s) => s.data[addr])
  const alkanes = useAlkaneStore((s) => s.data[addr])
  const tap = useTapStore((s) => s.data[addr])
  const utxos = useUtxoStore((s) => s.data[addr])

  useEffect(() => {
    useWalletStore.getState().fetch(addr)
    useRuneStore.getState().fetch(addr)
    useBrc20Store.getState().fetch(addr)
    useAlkaneStore.getState().fetch(addr)
    useTapStore.getState().fetch(addr)
    useUtxoStore.getState().fetch(addr)
  }, [addr])

  const count = (val: unknown[] | undefined) => val ? String(val.length) : '...'

  const rows = categories.map((cat) => {
    switch (cat) {
      case 'Inscriptions': return [cat, wd ? String(wd.inscriptions.length) : '...']
      case 'Runes': return [cat, count(runes)]
      case 'BRC-20': return [cat, count(brc20)]
      case 'UTXOs': return [cat, utxos ? String(utxos.length) : (wd ? String(wd.utxoCount) : '...')]
      case 'Alkanes': return [cat, count(alkanes)]
      case 'TAP': return [cat, count(tap)]
    }
  })

  return <Table columns={columns} rows={rows} cursor={cursor} title={wallet.name} height={height} />
}
