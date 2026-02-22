import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'

const DEFAULT_BASE_URL = 'https://turbo.ordinalswallet.com'

export interface ClientConfig {
  baseUrl?: string
  timeout?: number
}

export function createClient(config?: ClientConfig): AxiosInstance {
  const client = axios.create({
    baseURL: config?.baseUrl || DEFAULT_BASE_URL,
    timeout: config?.timeout || 30000,
    headers: {
      'Content-Type': 'application/json',
    },
  })

  return client
}

let defaultClient: AxiosInstance | null = null

export function getClient(): AxiosInstance {
  if (!defaultClient) {
    defaultClient = createClient()
  }
  return defaultClient
}

export function setClient(config: ClientConfig): void {
  defaultClient = createClient(config)
}
