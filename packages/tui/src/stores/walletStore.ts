import { create } from 'zustand'
import * as api from '@ow-cli/api'
import type { WalletInscription } from '@ow-cli/api'

export interface WalletData {
  balance: number
  utxoCount: number
  inscriptions: WalletInscription[]
}

interface WalletState {
  data: Record<string, WalletData>
  loading: Record<string, boolean>
  fetch: (address: string) => void
  invalidate: (address: string) => void
}

const pending = new Set<string>()

export const useWalletStore = create<WalletState>((set, get) => ({
  data: {},
  loading: {},
  fetch: (address) => {
    if (get().data[address] || pending.has(address)) return
    pending.add(address)
    set((s) => ({ loading: { ...s.loading, [address]: true } }))
    api.wallet.getWallet(address).then((d) => {
      set((s) => ({
        data: {
          ...s.data,
          [address]: {
            balance: d.balance ?? 0,
            utxoCount: d.utxo_count ?? 0,
            inscriptions: Array.isArray(d.inscriptions) ? d.inscriptions : [],
          },
        },
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
