import axios from 'axios'

const MEMPOOL_URL = 'https://mempool.space'
const EXCHANGE_RATE_URL = 'https://cloud-functions.twetch.app/api/btc-exchange-rate'

export interface ExchangeRate {
  price: number
  percent_change_24h?: number
}

export async function getBlockHeight(): Promise<number> {
  const { data } = await axios.get(`${MEMPOOL_URL}/api/blocks/tip/height`, { timeout: 10000 })
  return Number(data)
}

export async function getExchangeRate(): Promise<ExchangeRate> {
  const { data } = await axios.get(EXCHANGE_RATE_URL, { timeout: 10000 })
  return data
}
