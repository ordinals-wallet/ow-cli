import React, { useEffect } from 'react'
import { loadConfig, formatSats } from '@ow-cli/shared'
import type { WalletInfo } from '@ow-cli/shared'
import { useWalletStore } from '../stores/walletStore.js'
import { useRuneStore } from '../stores/runeStore.js'
import { useBrc20Store } from '../stores/brc20Store.js'
import { useAlkaneStore } from '../stores/alkaneStore.js'
import { useTapStore } from '../stores/tapStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface WalletsPageProps {
  wallets: WalletInfo[]
  cursor: number
  onSelect: (wallet: WalletInfo) => void
  height?: number
}

const columns: Column[] = [
  { header: 'Name', width: 14 },
  { header: 'Balance', width: 16, align: 'right' },
  { header: 'UTXOs', width: 6, align: 'right' },
  { header: 'Inscriptions', width: 12, align: 'right' },
  { header: 'Runes', width: 6, align: 'right' },
  { header: 'BRC-20', width: 6, align: 'right' },
  { header: 'TAP', width: 6, align: 'right' },
  { header: 'Alkanes', width: 7, align: 'right' },
]

export function WalletsPage({ wallets, cursor, height }: WalletsPageProps) {
  const activeId = loadConfig().activeWallet
  const walletData = useWalletStore((s) => s.data)
  const runeData = useRuneStore((s) => s.data)
  const brc20Data = useBrc20Store((s) => s.data)
  const alkaneData = useAlkaneStore((s) => s.data)
  const tapData = useTapStore((s) => s.data)

  useEffect(() => {
    for (const w of wallets) {
      useWalletStore.getState().fetch(w.address)
      useRuneStore.getState().fetch(w.address)
      useBrc20Store.getState().fetch(w.address)
      useAlkaneStore.getState().fetch(w.address)
      useTapStore.getState().fetch(w.address)
    }
  }, [wallets])

  const rows = wallets.map((w) => {
    const name = w.id === activeId ? `${w.name} *` : w.name
    const wd = walletData[w.address]
    const runes = runeData[w.address]
    const brc20 = brc20Data[w.address]
    const alkanes = alkaneData[w.address]
    const tap = tapData[w.address]

    return [
      name,
      wd ? formatSats(wd.balance) : '...',
      wd ? String(wd.utxoCount) : '...',
      wd ? String(wd.inscriptions.length) : '...',
      runes ? String(runes.length) : '...',
      brc20 ? String(brc20.length) : '...',
      tap ? String(tap.length) : '...',
      alkanes ? String(alkanes.length) : '...',
    ]
  })

  return <Table columns={columns} rows={rows} cursor={cursor} title="Wallets" height={height} />
}
