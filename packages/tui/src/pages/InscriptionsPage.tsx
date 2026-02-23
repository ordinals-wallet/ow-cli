import React, { useEffect, useMemo } from 'react'
import { useWalletStore } from '../stores/walletStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

export interface CollectionGroup {
  slug: string
  name: string
  count: number
}

interface InscriptionsPageProps {
  address: string
  walletName: string
  cursor: number
  onGroupsLoaded?: (groups: CollectionGroup[]) => void
  height?: number
}

const columns: Column[] = [
  { header: 'Collection', width: 30 },
  { header: 'Count', width: 8, align: 'right' },
]

export function InscriptionsPage({ address, cursor, onGroupsLoaded, height }: InscriptionsPageProps) {
  const wd = useWalletStore((s) => s.data[address])
  const loading = useWalletStore((s) => s.loading[address])

  useEffect(() => { useWalletStore.getState().fetch(address) }, [address])

  const groups = useMemo(() => {
    if (!wd) return []
    const map = new Map<string, CollectionGroup>()
    for (const ins of wd.inscriptions) {
      const slug = ins.collection?.slug ?? '_uncategorized'
      const name = ins.collection?.name ?? 'Uncategorized'
      const existing = map.get(slug)
      if (existing) existing.count++
      else map.set(slug, { slug, name, count: 1 })
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count)
  }, [wd])

  useEffect(() => {
    if (groups.length > 0) onGroupsLoaded?.(groups)
  }, [groups])

  const rows = !wd && loading
    ? [['Loading...', '']]
    : groups.map((g) => [g.name, String(g.count)])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title="Inscriptions" />
}
