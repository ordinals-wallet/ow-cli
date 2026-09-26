import axios, { type AxiosInstance } from 'axios'
import { VERSION } from './version.js'

const DEFAULT_BASE_URL = 'https://turbo.ordinalswallet.com'

/** Header used to identify SDK/CLI traffic to the Ordinals Wallet API. */
export const CLIENT_HEADER = 'x-ow-client'

/** This SDK's own product token, e.g. `ow-cli/0.1.0`. */
export const SDK_CLIENT_TOKEN = `ow-cli/${VERSION}`

export interface ClientConfig {
  baseUrl?: string
  timeout?: number
  /**
   * Identifies your application to the API. Sent ahead of the SDK token in
   * the `x-ow-client` header, e.g. `appName: 'my-bot/1.2'` sends
   * `x-ow-client: my-bot/1.2 ow-cli/0.1.0`.
   *
   * Format: one or more space-separated `<name>/<version>` product tokens.
   */
  appName?: string
}

/**
 * Builds the `x-ow-client` value: caller tokens first (most specific), then
 * the SDK token. Format is space-separated `<name>/<version>` tokens.
 */
export function buildClientHeader(appName?: string): string {
  const app = appName?.trim().replace(/\s+/g, ' ')
  return app ? `${app} ${SDK_CLIENT_TOKEN}` : SDK_CLIENT_TOKEN
}

function isNode(): boolean {
  return typeof window === 'undefined'
}

export function createClient(config?: ClientConfig): AxiosInstance {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [CLIENT_HEADER]: buildClientHeader(config?.appName),
  }
  // Browsers forbid setting User-Agent; only set it when running in Node.
  if (isNode()) {
    headers['User-Agent'] = SDK_CLIENT_TOKEN
  }

  return axios.create({
    baseURL: config?.baseUrl || DEFAULT_BASE_URL,
    timeout: config?.timeout || 30000,
    headers,
  })
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
