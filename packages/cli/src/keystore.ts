import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import { getConfigDir, getWalletsDir, loadConfig, saveConfig } from './config.js'

interface KeystoreData {
  id: string
  name: string
  encrypted: string
  iv: string
  salt: string
  tag: string
  publicKey: string
  address: string
}

export interface WalletInfo {
  id: string
  name: string
  address: string
}

const PBKDF2_ITERATIONS = 100000
const KEY_LENGTH = 32
const ALGORITHM = 'aes-256-gcm'

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
}

function generateId(): string {
  return randomBytes(8).toString('hex')
}

export function getKeystorePath(id?: string): string {
  const walletId = id ?? loadConfig().activeWallet
  return join(getWalletsDir(), `${walletId}.json`)
}

export function migrateKeystore(): void {
  const oldPath = join(getConfigDir(), 'keystore.json')
  const walletsDir = getWalletsDir()

  if (existsSync(oldPath) && !existsSync(walletsDir)) {
    mkdirSync(walletsDir, { recursive: true })
    const id = generateId()
    const raw = readFileSync(oldPath, 'utf-8')
    const old = JSON.parse(raw)
    const data: KeystoreData = { id, name: 'default', ...old }
    writeFileSync(join(walletsDir, `${id}.json`), JSON.stringify(data, null, 2))
    renameSync(oldPath, join(getConfigDir(), 'keystore.json.bak'))
    saveConfig({ activeWallet: id })
  }
}

export function hasKeystore(id?: string): boolean {
  return existsSync(getKeystorePath(id))
}

export function saveKeystore(
  seed: string,
  password: string,
  publicKey: string,
  address: string,
  name: string,
  id?: string,
): string {
  mkdirSync(getWalletsDir(), { recursive: true })

  const walletId = id ?? generateId()

  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const key = deriveKey(password, salt)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(seed, 'utf-8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag()

  const data: KeystoreData = {
    id: walletId,
    name,
    encrypted,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    tag: tag.toString('hex'),
    publicKey,
    address,
  }

  writeFileSync(join(getWalletsDir(), `${walletId}.json`), JSON.stringify(data, null, 2))
  return walletId
}

export function loadKeystore(password: string, id?: string): { seed: string; publicKey: string; address: string } {
  const path = getKeystorePath(id)
  if (!existsSync(path)) {
    throw new Error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
  }

  const raw = readFileSync(path, 'utf-8')
  const data: KeystoreData = JSON.parse(raw)

  const salt = Buffer.from(data.salt, 'hex')
  const iv = Buffer.from(data.iv, 'hex')
  const tag = Buffer.from(data.tag, 'hex')
  const key = deriveKey(password, salt)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  let seed = decipher.update(data.encrypted, 'hex', 'utf-8')
  seed += decipher.final('utf-8')

  return { seed, publicKey: data.publicKey, address: data.address }
}

export function getKeypair(seed: string) {
  const words = seed.trim().split(/\s+/)
  if (words.length >= 12) {
    return keypairFromMnemonic(seed.trim())
  }
  return keypairFromWIF(seed.trim())
}

export function getPublicInfo(id?: string): { publicKey: string; address: string } | null {
  const path = getKeystorePath(id)
  if (!existsSync(path)) return null

  const raw = readFileSync(path, 'utf-8')
  const data: KeystoreData = JSON.parse(raw)
  return { publicKey: data.publicKey, address: data.address }
}

export function requirePublicInfo(): { publicKey: string; address: string } {
  const info = getPublicInfo()
  if (!info) {
    console.error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
    process.exit(1)
  }
  return info
}

export function unlockKeypair(password: string) {
  const ks = loadKeystore(password)
  return getKeypair(ks.seed)
}

export function listWallets(): WalletInfo[] {
  const walletsDir = getWalletsDir()
  if (!existsSync(walletsDir)) return []

  const files = readdirSync(walletsDir).filter((f) => f.endsWith('.json'))
  return files.map((f) => {
    const raw = readFileSync(join(walletsDir, f), 'utf-8')
    const data: KeystoreData = JSON.parse(raw)
    return { id: data.id, name: data.name, address: data.address }
  })
}
