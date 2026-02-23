import React, { useEffect, useMemo } from 'react'
import { formatSats } from '@ow-cli/shared'
import { useWalletStore } from '../stores/walletStore.js'
import { Table } from '../components/Table.js'
import type { Column } from '../components/Table.js'

interface CollectionDetailPageProps {
  address: string
  walletName: string
  collectionSlug: string
  collectionName: string
  cursor: number
  height?: number
}

const columns: Column[] = [
  { header: '#', width: 8 },
  { header: 'ID', width: 28 },
  { header: 'Type', width: 20 },
  { header: 'Name', width: 20 },
  { header: 'Listed', width: 14, align: 'right' },
]

export function CollectionDetailPage({ address, collectionSlug, cursor, height }: CollectionDetailPageProps) {
  const wd = useWalletStore((s) => s.data[address])
  const loading = useWalletStore((s) => s.loading[address])

  useEffect(() => { useWalletStore.getState().fetch(address) }, [address])

  const inscriptions = useMemo(() => {
    if (!wd) return []
    return collectionSlug === '_uncategorized'
      ? wd.inscriptions.filter((i) => !i.collection?.slug)
      : wd.inscriptions.filter((i) => i.collection?.slug === collectionSlug)
  }, [wd, collectionSlug])

  const rows = !wd && loading
    ? [['...', '', '', '', '']]
    : inscriptions.map((ins) => [
        String(ins.num ?? '?'),
        ins.id.length > 26 ? ins.id.slice(0, 12) + '…' + ins.id.slice(-12) : ins.id,
        ins.content_type || '',
        ins.meta?.name || '',
        ins.escrow ? formatSats(ins.escrow.satoshi_price) : '',
      ])

  return <Table columns={columns} rows={rows} cursor={cursor} height={height} title={collectionSlug === '_uncategorized' ? 'Uncategorized' : collectionSlug} />
}
