import { create } from 'zustand'
import * as api from '@ow-cli/api'

interface NetworkState {
  blockHeight: number | null
  btcPrice: number | null
  percentChange24h: number | null
  loading: boolean
  fetch: () => void
}

let fetching = false

export const useNetworkStore = create<NetworkState>((set, get) => ({
  blockHeight: null,
  btcPrice: null,
  percentChange24h: null,
  loading: false,
  fetch: () => {
    if (fetching || (get().blockHeight !== null && get().btcPrice !== null)) return
    fetching = true
    set({ loading: true })
    Promise.all([
      api.network.getBlockHeight().catch(() => null),
      api.network.getExchangeRate().catch(() => null),
    ]).then(([height, rate]) => {
      set({
        blockHeight: height,
        btcPrice: rate?.price ?? null,
        percentChange24h: rate?.percent_change_24h ?? null,
        loading: false,
      })
    }).finally(() => { fetching = false })
  },
}))
