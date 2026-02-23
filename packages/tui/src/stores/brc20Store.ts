import { create } from 'zustand'
import * as api from '@ow-cli/api'
import type { Brc20Balance } from '@ow-cli/api'

interface Brc20State {
  data: Record<string, Brc20Balance[]>
  loading: Record<string, boolean>
  fetch: (address: string) => void
  invalidate: (address: string) => void
}

const pending = new Set<string>()

export const useBrc20Store = create<Brc20State>((set, get) => ({
  data: {},
  loading: {},
  fetch: (address) => {
    if (get().data[address] || pending.has(address)) return
    pending.add(address)
    set((s) => ({ loading: { ...s.loading, [address]: true } }))
    api.wallet.getBrc20Balance(address).then((d) => {
      set((s) => ({
        data: { ...s.data, [address]: d },
        loading: { ...s.loading, [address]: false },
      }))
    }).catch(() => {
      set((s) => ({ loading: { ...s.loading, [address]: false } }))
    }).finally(() => pending.delete(address))
  },
  invalidate: (address) => {
    pending.delete(address)
    set((s) => {
      const { [address]: _, ...rest } = s.data
      return { data: rest }
    })
  },
}))
