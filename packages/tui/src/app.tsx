import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react'
import { Box, Text, useApp, useInput, Spacer } from 'ink'
import { listWallets, loadConfig, saveKeystore, saveConfig, renameWallet } from '@ow-cli/shared'
import { validateMnemonic, keypairFromMnemonic, keypairFromWIF, publicKeyToP2TR, bytesToHex } from '@ow-cli/core'
import type { WalletInfo } from '@ow-cli/shared'
import { useNavigation } from './hooks/useNavigation.js'
import type { Page } from './hooks/useNavigation.js'
import { useTerminalSize } from './hooks/useTerminalSize.js'
import { useNetworkStore } from './stores/networkStore.js'
import { SearchBar } from './components/SearchBar.js'
import { CommandPalette, filterTargets } from './components/CommandPalette.js'
import { Modal } from './components/Modal.js'
import type { CommandTarget } from './components/CommandPalette.js'
import { WalletsPage } from './pages/WalletsPage.js'
import { WalletDetailPage, categories } from './pages/WalletDetailPage.js'
import { InscriptionsPage } from './pages/InscriptionsPage.js'
import type { CollectionGroup } from './pages/InscriptionsPage.js'
import { CollectionDetailPage } from './pages/CollectionDetailPage.js'
import { RunesPage } from './pages/RunesPage.js'
import { Brc20Page } from './pages/Brc20Page.js'
import { UtxosPage } from './pages/UtxosPage.js'
import { AlkanesPage } from './pages/AlkanesPage.js'
import { TapPage } from './pages/TapPage.js'

// Page data types
interface WalletDetailData { wallet: WalletInfo }
interface CategoryPageData { wallet: WalletInfo }
interface CollectionDetailData { wallet: WalletInfo; collectionSlug: string; collectionName: string }

type InputMode = 'normal' | 'search' | 'command' | 'modal-import' | 'modal-rename'
type ImportStep = 'name' | 'seed' | 'password' | 'confirm'

function getCommandTargets(activeWallet: WalletInfo | null): CommandTarget[] {
  const targets: CommandTarget[] = [
    { id: 'wallets', label: 'Wallets', description: 'View all wallets' },
  ]
  if (activeWallet) {
    targets.push(
      { id: 'inscriptions', label: 'Inscriptions', description: `${activeWallet.name} inscriptions` },
      { id: 'runes', label: 'Runes', description: `${activeWallet.name} runes` },
      { id: 'brc20', label: 'BRC-20', description: `${activeWallet.name} BRC-20 tokens` },
      { id: 'utxos', label: 'UTXOs', description: `${activeWallet.name} UTXOs` },
      { id: 'alkanes', label: 'Alkanes', description: `${activeWallet.name} alkanes` },
      { id: 'tap', label: 'TAP', description: `${activeWallet.name} TAP tokens` },
    )
  }
  return targets
}

interface HintPair { key: string; action: string }

function getHintsForPage(pageId: string): { page: HintPair[]; general: HintPair[] } {
  const general: HintPair[] = [
    { key: 'j/k', action: 'Navigate' },
    { key: ':', action: 'Goto' },
    { key: 'q', action: 'Quit' },
  ]
  switch (pageId) {
    case 'wallets':
      return {
        page: [{ key: 'i', action: 'Import' }, { key: 'r', action: 'Rename' }],
        general: [{ key: 'enter', action: 'Select' }, { key: '/', action: 'Filter' }, ...general],
      }
    case 'wallet-detail':
    case 'inscriptions':
      return { page: [], general: [{ key: 'enter', action: 'Open' }, { key: 'esc', action: 'Back' }, ...general] }
    default:
      return { page: [], general: [{ key: 'esc', action: 'Back' }, ...general] }
  }
}

export function App() {
  const { exit } = useApp()
  const { columns, rows } = useTerminalSize()
  const nav = useNavigation({ id: 'wallets', title: 'Wallets' })

  const [inputMode, setInputMode] = useState<InputMode>('normal')
  const [searchQuery, setSearchQuery] = useState('')
  const [commandQuery, setCommandQuery] = useState('')
  const [commandCursor, setCommandCursor] = useState(0)

  // Modal state
  const [importStep, setImportStep] = useState<ImportStep>('name')
  const [importData, setImportData] = useState({ name: '', seed: '', password: '' })
  const [modalInput, setModalInput] = useState('')
  const [modalError, setModalError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => { useNetworkStore.getState().fetch() }, [])

  const wallets = useMemo(() => listWallets(), [nav.current.id, refreshKey])
  const inscriptionGroupsRef = useRef<CollectionGroup[]>([])

  const onGroupsLoaded = useCallback((groups: CollectionGroup[]) => {
    inscriptionGroupsRef.current = groups
  }, [])

  // Active wallet: from page context if drilled in, otherwise from config
  const activeWallet = useMemo((): WalletInfo | null => {
    for (let i = nav.stack.length - 1; i >= 0; i--) {
      const page = nav.stack[i]
      if (page.data && typeof page.data === 'object' && 'wallet' in page.data) {
        return (page.data as { wallet: WalletInfo }).wallet
      }
    }
    // Fallback: config's active wallet
    const activeId = loadConfig().activeWallet
    return wallets.find((w) => w.id === activeId) ?? wallets[0] ?? null
  }, [nav.stack, wallets])

  const commandTargets = useMemo(() => getCommandTargets(activeWallet), [activeWallet])
  const filteredCommands = useMemo(() => filterTargets(commandTargets, commandQuery), [commandTargets, commandQuery])

  const filteredWallets = useMemo(() => {
    if (!searchQuery || nav.current.id !== 'wallets') return wallets
    return wallets.filter(
      (w) =>
        w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        w.address.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [wallets, searchQuery, nav.current.id])

  function getMaxCursor(): number {
    const page = nav.current
    switch (page.id) {
      case 'wallets': return Math.max(0, filteredWallets.length - 1)
      case 'wallet-detail': return categories.length - 1
      case 'inscriptions': return Math.max(0, inscriptionGroupsRef.current.length - 1)
      default: return 999
    }
  }

  function executeCommand(target: CommandTarget) {
    const wallet = activeWallet
    if (target.id === 'wallets') {
      while (nav.stack.length > 1) nav.pop()
      return
    }
    if (!wallet) return
    const d: CategoryPageData = { wallet }
    while (nav.stack.length > 1) nav.pop()
    nav.push({ id: 'wallet-detail', title: wallet.name, data: { wallet } satisfies WalletDetailData })
    switch (target.id) {
      case 'inscriptions':
        inscriptionGroupsRef.current = []
        nav.push({ id: 'inscriptions', title: 'Inscriptions', data: d }); break
      case 'runes': nav.push({ id: 'runes', title: 'Runes', data: d }); break
      case 'brc20': nav.push({ id: 'brc20', title: 'BRC-20', data: d }); break
      case 'utxos': nav.push({ id: 'utxos', title: 'UTXOs', data: d }); break
      case 'alkanes': nav.push({ id: 'alkanes', title: 'Alkanes', data: d }); break
      case 'tap': nav.push({ id: 'tap', title: 'TAP', data: d }); break
    }
  }

  useInput((input, key) => {
    // Modal modes
    if (inputMode === 'modal-import' || inputMode === 'modal-rename') {
      if (key.escape) {
        setInputMode('normal')
        setModalInput('')
        setModalError('')
        setImportStep('name')
        setImportData({ name: '', seed: '', password: '' })
        return
      }
      if (key.backspace || key.delete) {
        setModalInput((v) => v.slice(0, -1))
        setModalError('')
        return
      }
      if (key.return) {
        if (inputMode === 'modal-rename') {
          const trimmed = modalInput.trim()
          if (!trimmed) { setModalError('Name cannot be empty'); return }
          const wallet = filteredWallets[nav.cursor]
          if (wallet) {
            try {
              renameWallet(wallet.id, trimmed)
              setRefreshKey((k) => k + 1)
            } catch (e: any) {
              setModalError(e.message ?? 'Failed to rename')
              return
            }
          }
          setInputMode('normal')
          setModalInput('')
          setModalError('')
          return
        }

        // modal-import
        if (importStep === 'name') {
          const trimmed = modalInput.trim()
          if (!trimmed) { setModalError('Name cannot be empty'); return }
          setImportData((d) => ({ ...d, name: trimmed }))
          setModalInput('')
          setModalError('')
          setImportStep('seed')
          return
        }
        if (importStep === 'seed') {
          const trimmed = modalInput.trim()
          if (!trimmed) { setModalError('Mnemonic or WIF cannot be empty'); return }
          const words = trimmed.split(/\s+/)
          const isMnemonic = words.length >= 12
          if (isMnemonic && !validateMnemonic(trimmed)) {
            setModalError('Invalid mnemonic phrase')
            return
          }
          if (!isMnemonic) {
            try { keypairFromWIF(trimmed) } catch {
              setModalError('Invalid WIF key')
              return
            }
          }
          setImportData((d) => ({ ...d, seed: trimmed }))
          setModalInput('')
          setModalError('')
          setImportStep('password')
          return
        }
        if (importStep === 'password') {
          const val = modalInput
          if (val.length < 4) { setModalError('Password must be at least 4 characters'); return }
          setImportData((d) => ({ ...d, password: val }))
          setModalInput('')
          setModalError('')
          setImportStep('confirm')
          return
        }
        if (importStep === 'confirm') {
          if (modalInput !== importData.password) { setModalError('Passwords do not match'); return }
          try {
            const seed = importData.seed
            const words = seed.split(/\s+/)
            const kp = words.length >= 12 ? keypairFromMnemonic(seed) : keypairFromWIF(seed)
            const { address } = publicKeyToP2TR(kp.publicKey)
            const pubHex = bytesToHex(kp.publicKey)
            const id = saveKeystore(seed, importData.password, pubHex, address, importData.name)
            saveConfig({ activeWallet: id })
            setRefreshKey((k) => k + 1)
          } catch (e: any) {
            setModalError(e.message ?? 'Failed to import')
            return
          }
          setInputMode('normal')
          setModalInput('')
          setModalError('')
          setImportStep('name')
          setImportData({ name: '', seed: '', password: '' })
          return
        }
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setModalInput((v) => v + input)
        setModalError('')
        return
      }
      return
    }

    // Command mode
    if (inputMode === 'command') {
      if (key.escape) { setInputMode('normal'); setCommandQuery(''); setCommandCursor(0); return }
      if (key.return) {
        const target = filteredCommands[commandCursor]
        if (target) executeCommand(target)
        setInputMode('normal'); setCommandQuery(''); setCommandCursor(0)
        return
      }
      if (key.backspace || key.delete) { setCommandQuery((q) => q.slice(0, -1)); setCommandCursor(0); return }
      if (key.downArrow) { setCommandCursor((c) => Math.min(c + 1, filteredCommands.length - 1)); return }
      if (key.upArrow) { setCommandCursor((c) => Math.max(c - 1, 0)); return }
      if (input && !key.ctrl && !key.meta) { setCommandQuery((q) => q + input); setCommandCursor(0); return }
      return
    }

    // Search mode
    if (inputMode === 'search') {
      if (key.escape) { setInputMode('normal'); setSearchQuery(''); nav.resetCursor(); return }
      if (key.return) { setInputMode('normal'); return }
      if (key.backspace || key.delete) { setSearchQuery((q) => q.slice(0, -1)); nav.resetCursor(); return }
      if (input && !key.ctrl && !key.meta) { setSearchQuery((q) => q + input); nav.resetCursor(); return }
      return
    }

    // Normal mode
    if (nav.current.id === 'wallets' && input === 'i') {
      setInputMode('modal-import')
      setImportStep('name')
      setImportData({ name: '', seed: '', password: '' })
      setModalInput('')
      setModalError('')
      return
    }
    if (nav.current.id === 'wallets' && input === 'r') {
      const wallet = filteredWallets[nav.cursor]
      if (wallet) {
        setInputMode('modal-rename')
        setModalInput(wallet.name)
        setModalError('')
      }
      return
    }
    if (input === 'q' && !key.ctrl) { exit(); return }
    if (input === '/') { setInputMode('search'); setSearchQuery(''); return }
    if (input === ':') { setInputMode('command'); setCommandQuery(''); setCommandCursor(0); return }
    if (input === 'j' || key.downArrow) { nav.moveCursor(1, getMaxCursor()); return }
    if (input === 'k' || key.upArrow) { nav.moveCursor(-1, getMaxCursor()); return }
    if (key.escape) { nav.pop(); return }
    if (key.return) { handleEnter(); return }
  })

  function handleEnter() {
    const page = nav.current

    if (page.id === 'wallets') {
      const wallet = filteredWallets[nav.cursor]
      if (wallet) {
        setSearchQuery('')
        saveConfig({ activeWallet: wallet.id })
        setRefreshKey((k) => k + 1)
        nav.push({ id: 'wallet-detail', title: wallet.name, data: { wallet } satisfies WalletDetailData })
      }
      return
    }

    if (page.id === 'wallet-detail') {
      const { wallet } = page.data as WalletDetailData
      const category = categories[nav.cursor]
      if (!category) return
      const d: CategoryPageData = { wallet }
      switch (category) {
        case 'Inscriptions':
          inscriptionGroupsRef.current = []
          nav.push({ id: 'inscriptions', title: 'Inscriptions', data: d }); break
        case 'Runes': nav.push({ id: 'runes', title: 'Runes', data: d }); break
        case 'BRC-20': nav.push({ id: 'brc20', title: 'BRC-20', data: d }); break
        case 'UTXOs': nav.push({ id: 'utxos', title: 'UTXOs', data: d }); break
        case 'Alkanes': nav.push({ id: 'alkanes', title: 'Alkanes', data: d }); break
        case 'TAP': nav.push({ id: 'tap', title: 'TAP', data: d }); break
      }
      return
    }

    if (page.id === 'inscriptions') {
      const { wallet } = page.data as CategoryPageData
      const group = inscriptionGroupsRef.current[nav.cursor]
      if (group) {
        nav.push({
          id: 'collection-detail',
          title: group.name,
          data: { wallet, collectionSlug: group.slug, collectionName: group.name } satisfies CollectionDetailData,
        })
      }
      return
    }
  }

  const { page: pageHints, general: hints } = getHintsForPage(nav.current.id)
  const page = nav.current

  // Header is max(logo, hints) lines tall, bordered search bar adds 3
  const headerHeight = Math.max(OW_LOGO.length, hints.length, pageHints.length)
  const searchBarHeight = inputMode === 'search' ? 3 : 0
  const contentHeight = rows - headerHeight - searchBarHeight

  // ── Modal overlay data ──
  const isModal = inputMode === 'modal-import' || inputMode === 'modal-rename'
  let modalNode: React.ReactNode = null
  if (isModal) {
    const title = inputMode === 'modal-import' ? 'Import Wallet' : 'Rename Wallet'
    const promptMap: Record<ImportStep, string> = {
      name: 'Wallet name:',
      seed: 'Mnemonic or WIF:',
      password: 'Password:',
      confirm: 'Confirm password:',
    }
    const prompt = inputMode === 'modal-import' ? promptMap[importStep] : 'New name:'
    const masked = inputMode === 'modal-import' && (importStep === 'seed' || importStep === 'password' || importStep === 'confirm')
    modalNode = (
      <Box position="absolute" width={columns} height={rows - headerHeight} justifyContent="center" alignItems="center">
        <Modal title={title} prompt={prompt} value={modalInput} masked={masked} error={modalError} termWidth={columns} termHeight={rows} />
      </Box>
    )
  }

  // ── Render: fullscreen layout ──
  if (inputMode === 'command') {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <FixedHeader columns={columns} pageHints={pageHints} hints={hints} activeWallet={activeWallet} />
        <SearchBar mode="command" query={commandQuery} />
        <CommandPalette query={commandQuery} targets={commandTargets} cursor={commandCursor} />
        <Spacer />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <FixedHeader columns={columns} pageHints={pageHints} hints={hints} activeWallet={activeWallet} />

      {inputMode === 'search' && (
        <SearchBar mode="search" query={searchQuery} />
      )}

      {/* Page content */}
      <Box flexDirection="column" flexGrow={1}>
        <PageContent
          page={page}
          cursor={nav.cursor}
          filteredWallets={filteredWallets}
          onGroupsLoaded={onGroupsLoaded}
          contentHeight={contentHeight}
        />
        {modalNode}
      </Box>
    </Box>
  )
}

// ── Fixed Header ──

const highlight = '#956EFE'
const basePurple = '#673BFE'

const OW_LOGO = [
  ' ██████  ██   ██ ',
  '██    ██ ██   ██ ',
  '██    ██ ██ █ ██ ',
  '██    ██ ██ █ ██ ',
  ' ██████   ██ ██  ',
]
const LOGO_WIDTH = 19

function FixedHeader({ columns: termCols, pageHints, hints, activeWallet }: {
  columns: number
  pageHints: HintPair[]
  hints: HintPair[]
  activeWallet: WalletInfo | null
}) {
  const logoW = LOGO_WIDTH + 2
  const leftWidth = Math.max(0, termCols - logoW)

  const blockHeight = useNetworkStore((s) => s.blockHeight)
  const btcPrice = useNetworkStore((s) => s.btcPrice)

  const statsLines: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: 'Block', value: blockHeight != null ? blockHeight.toLocaleString() : '...' },
    { label: 'BTC/USD', value: btcPrice != null ? `$${btcPrice.toLocaleString()}` : '...', bold: true },
  ]
  if (activeWallet) {
    statsLines.push({ label: 'Wallet', value: activeWallet.name, bold: true })
    statsLines.push({ label: 'Address', value: `${activeWallet.address.slice(0, 10)}…${activeWallet.address.slice(-6)}` })
  }

  return (
    <Box flexDirection="column">
      <Box>
        {/* Left side: stats | keybindings */}
        <Box width={leftWidth} paddingX={1}>
          <Box flexDirection="column" marginRight={4}>
            {statsLines.map((s, i) => (
              <Box key={i}>
                <Text dimColor>{s.label}:</Text>
                <Text color={s.bold ? highlight : undefined} bold={s.bold}> {s.value}</Text>
              </Box>
            ))}
          </Box>

          {pageHints.length > 0 && (
            <Box flexDirection="column" marginRight={4}>
              {pageHints.map((h, i) => (
                <Box key={i}>
                  <Text color={highlight}>&lt;{h.key}&gt;</Text>
                  <Text dimColor> {h.action}</Text>
                </Box>
              ))}
            </Box>
          )}

          <Box flexDirection="column">
            {hints.map((h, i) => (
              <Box key={i}>
                <Text color={highlight}>&lt;{h.key}&gt;</Text>
                <Text dimColor> {h.action}</Text>
              </Box>
            ))}
          </Box>
        </Box>

        {/* Right side: Logo */}
        <Box flexDirection="column" width={logoW} alignItems="flex-end" paddingRight={1}>
          {OW_LOGO.map((line, i) => (
            <Text key={i} color={i < 2 ? highlight : basePurple} bold>{line}</Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

// ── Page Content Router ──

function PageContent({ page, cursor, filteredWallets, onGroupsLoaded, contentHeight }: {
  page: Page
  cursor: number
  filteredWallets: WalletInfo[]
  onGroupsLoaded: (groups: CollectionGroup[]) => void
  contentHeight: number
}) {
  const h = contentHeight

  if (page.id === 'wallets') {
    return <WalletsPage cursor={cursor} wallets={filteredWallets} onSelect={() => {}} height={h} />
  }

  if (page.id === 'wallet-detail') {
    const { wallet } = page.data as WalletDetailData
    return <WalletDetailPage wallet={wallet} cursor={cursor} height={h} />
  }

  if (page.id === 'inscriptions') {
    const { wallet } = page.data as CategoryPageData
    return (
      <InscriptionsPage
        address={wallet.address}
        walletName={wallet.name}
        cursor={cursor}
        onGroupsLoaded={onGroupsLoaded}
        height={h}
      />
    )
  }

  if (page.id === 'collection-detail') {
    const { wallet, collectionSlug, collectionName } = page.data as CollectionDetailData
    return (
      <CollectionDetailPage
        address={wallet.address}
        walletName={wallet.name}
        collectionSlug={collectionSlug}
        collectionName={collectionName}
        cursor={cursor}
        height={h}
      />
    )
  }

  if (page.id === 'runes') {
    const { wallet } = page.data as CategoryPageData
    return <RunesPage address={wallet.address} walletName={wallet.name} cursor={cursor} height={h} />
  }

  if (page.id === 'brc20') {
    const { wallet } = page.data as CategoryPageData
    return <Brc20Page address={wallet.address} walletName={wallet.name} cursor={cursor} height={h} />
  }

  if (page.id === 'utxos') {
    const { wallet } = page.data as CategoryPageData
    return <UtxosPage address={wallet.address} walletName={wallet.name} cursor={cursor} height={h} />
  }

  if (page.id === 'alkanes') {
    const { wallet } = page.data as CategoryPageData
    return <AlkanesPage address={wallet.address} walletName={wallet.name} cursor={cursor} height={h} />
  }

  if (page.id === 'tap') {
    const { wallet } = page.data as CategoryPageData
    return <TapPage address={wallet.address} walletName={wallet.name} cursor={cursor} height={h} />
  }

  return <Box />
}
