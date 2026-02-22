import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { keypairFromMnemonic, keypairFromWIF } from '@ow-cli/core'
import { getConfigDir } from './config.js'

interface KeystoreData {
  encrypted: string
  iv: string
  salt: string
  tag: string
  publicKey: string
  address: string
}

const KEYSTORE_FILE = join(getConfigDir(), 'keystore.json')
const PBKDF2_ITERATIONS = 100000
const KEY_LENGTH = 32
const ALGORITHM = 'aes-256-gcm'

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
}

export function hasKeystore(): boolean {
  return existsSync(KEYSTORE_FILE)
}

export function saveKeystore(
  seed: string,
  password: string,
  publicKey: string,
  address: string,
): void {
  mkdirSync(getConfigDir(), { recursive: true })

  const salt = randomBytes(32)
  const iv = randomBytes(16)
  const key = deriveKey(password, salt)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(seed, 'utf-8', 'hex')
  encrypted += cipher.final('hex')
  const tag = cipher.getAuthTag()

  const data: KeystoreData = {
    encrypted,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    tag: tag.toString('hex'),
    publicKey,
    address,
  }

  writeFileSync(KEYSTORE_FILE, JSON.stringify(data, null, 2))
}

export function loadKeystore(password: string): { seed: string; publicKey: string; address: string } {
  if (!hasKeystore()) {
    throw new Error('No wallet found. Run "ow wallet create" or "ow wallet import" first.')
  }

  const raw = readFileSync(KEYSTORE_FILE, 'utf-8')
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

export function getPublicInfo(): { publicKey: string; address: string } | null {
  if (!hasKeystore()) return null

  const raw = readFileSync(KEYSTORE_FILE, 'utf-8')
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
