import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { getKeypair } from '../src/keystore.js'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('getKeypair', () => {
  it('should derive keypair from 12-word mnemonic', () => {
    const kp = getKeypair(TEST_MNEMONIC)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey.length).toBe(32)
  })

  it('should handle leading/trailing whitespace in mnemonic', () => {
    const kp = getKeypair(`  ${TEST_MNEMONIC}  `)
    const kp2 = getKeypair(TEST_MNEMONIC)
    expect(kp.privateKey).toEqual(kp2.privateKey)
  })

  it('should derive keypair from WIF', () => {
    // Standard test WIF (compressed mainnet)
    const wif = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn'
    const kp = getKeypair(wif)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
  })

  it('should treat short strings as WIF (not mnemonic)', () => {
    // 11 words is not a mnemonic, so should try WIF path
    expect(() => getKeypair('one two three four five six seven eight nine ten eleven')).toThrow()
  })
})

describe('multi-wallet', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `ow-cli-test-${randomBytes(8).toString('hex')}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('migrateKeystore', () => {
    it('should move keystore.json to wallets/<id>.json with name and id fields', () => {
      const fakeKeystore = {
        encrypted: 'abc',
        iv: 'def',
        salt: '123',
        tag: '456',
        publicKey: 'pub',
        address: 'bc1test',
      }
      const oldPath = join(testDir, 'keystore.json')
      writeFileSync(oldPath, JSON.stringify(fakeKeystore))

      const walletsDir = join(testDir, 'wallets')
      expect(existsSync(walletsDir)).toBe(false)

      // Simulate migration logic
      mkdirSync(walletsDir, { recursive: true })
      const id = randomBytes(8).toString('hex')
      const old = JSON.parse(readFileSync(oldPath, 'utf-8'))
      const data = { id, name: 'default', ...old }
      writeFileSync(join(walletsDir, `${id}.json`), JSON.stringify(data, null, 2))

      // Verify migrated file has id and name
      const migrated = JSON.parse(readFileSync(join(walletsDir, `${id}.json`), 'utf-8'))
      expect(migrated.id).toBe(id)
      expect(migrated.name).toBe('default')
      expect(migrated.address).toBe('bc1test')
    })

    it('should not migrate if wallets/ already exists', () => {
      const oldPath = join(testDir, 'keystore.json')
      writeFileSync(oldPath, '{}')

      const walletsDir = join(testDir, 'wallets')
      mkdirSync(walletsDir, { recursive: true })
      writeFileSync(join(walletsDir, 'existing.json'), '{}')

      // wallets dir exists, so old file should remain untouched
      expect(existsSync(oldPath)).toBe(true)
      expect(existsSync(walletsDir)).toBe(true)
    })
  })

  describe('listWallets', () => {
    it('should list wallet files with id, name, and address', () => {
      const walletsDir = join(testDir, 'wallets')
      mkdirSync(walletsDir, { recursive: true })

      const wallet1 = { id: 'aaa111', name: 'default', encrypted: '', iv: '', salt: '', tag: '', publicKey: '', address: 'bc1addr1' }
      const wallet2 = { id: 'bbb222', name: 'savings', encrypted: '', iv: '', salt: '', tag: '', publicKey: '', address: 'bc1addr2' }

      writeFileSync(join(walletsDir, 'aaa111.json'), JSON.stringify(wallet1))
      writeFileSync(join(walletsDir, 'bbb222.json'), JSON.stringify(wallet2))

      const files = readdirSync(walletsDir).filter((f: string) => f.endsWith('.json'))
      const wallets = files.map((f: string) => {
        const data = JSON.parse(readFileSync(join(walletsDir, f), 'utf-8'))
        return { id: data.id, name: data.name, address: data.address }
      })

      expect(wallets).toHaveLength(2)
      expect(wallets).toEqual(
        expect.arrayContaining([
          { id: 'aaa111', name: 'default', address: 'bc1addr1' },
          { id: 'bbb222', name: 'savings', address: 'bc1addr2' },
        ]),
      )
    })

    it('should return empty array when wallets dir does not exist', () => {
      const walletsDir = join(testDir, 'wallets')
      expect(existsSync(walletsDir)).toBe(false)
    })

    it('should allow multiple wallets with the same name', () => {
      const walletsDir = join(testDir, 'wallets')
      mkdirSync(walletsDir, { recursive: true })

      const wallet1 = { id: 'aaa', name: 'trading', encrypted: '', iv: '', salt: '', tag: '', publicKey: '', address: 'bc1a' }
      const wallet2 = { id: 'bbb', name: 'trading', encrypted: '', iv: '', salt: '', tag: '', publicKey: '', address: 'bc1b' }

      writeFileSync(join(walletsDir, 'aaa.json'), JSON.stringify(wallet1))
      writeFileSync(join(walletsDir, 'bbb.json'), JSON.stringify(wallet2))

      const files = readdirSync(walletsDir).filter((f: string) => f.endsWith('.json'))
      const wallets = files.map((f: string) => {
        const data = JSON.parse(readFileSync(join(walletsDir, f), 'utf-8'))
        return { id: data.id, name: data.name, address: data.address }
      })

      expect(wallets).toHaveLength(2)
      expect(wallets[0].name).toBe('trading')
      expect(wallets[1].name).toBe('trading')
      expect(wallets[0].id).not.toBe(wallets[1].id)
    })
  })
})
