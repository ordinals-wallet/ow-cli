import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Config {
  apiUrl: string
  network: string
}

const CONFIG_DIR = join(homedir(), '.ow-cli')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: Config = {
  apiUrl: 'https://turbo.ordinalswallet.com',
  network: 'mainnet',
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function loadConfig(): Config {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG }
    }
    const raw = readFileSync(CONFIG_FILE, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: Partial<Config>): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const current = loadConfig()
  const merged = { ...current, ...config }
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2))
}
