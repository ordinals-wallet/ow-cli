import { create } from 'zustand'
import * as api from '@ow-cli/api'
import type { RuneBalance } from '@ow-cli/api'

interface RuneState {
  data: Record<string, RuneBalance[]>
  loading: Record<string, boolean>
  fetch: (address: string) => void
  invalidate: (address: string) => void
}

const pending = new Set<string>()

export const useRuneStore = create<RuneState>((set, get) => ({
  data: {},
  loading: {},
  fetch: (address) => {
    if (get().data[address] || pending.has(address)) return
    pending.add(address)
    set((s) => ({ loading: { ...s.loading, [address]: true } }))
    api.wallet.getRuneBalance(address).then((d) => {
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
