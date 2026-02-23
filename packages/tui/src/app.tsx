import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react'
import { Box, Text, useApp, useInput, Spacer } from 'ink'
import { listWallets, loadConfig, saveKeystore, saveConfig, renameWallet, unlockKeypair, getPublicInfo, signAndBroadcast, executeListInscriptions, executeDelist, buildSplitEdicts, buildBrc20Payload, buildTapPayload, splitAmount, validateAddress, validateFeeRate, validateAmount, validateSplits, validateSats, formatSats } from '@ow-cli/shared'
import { validateMnemonic, keypairFromMnemonic, keypairFromWIF, publicKeyToP2TR, bytesToHex } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import type { WalletInfo } from '@ow-cli/shared'
import { useNavigation } from './hooks/useNavigation.js'
import type { Page } from './hooks/useNavigation.js'
import { useTerminalSize } from './hooks/useTerminalSize.js'
import { useNetworkStore } from './stores/networkStore.js'
import { useRuneStore } from './stores/runeStore.js'
import { useBrc20Store } from './stores/brc20Store.js'
import { useUtxoStore } from './stores/utxoStore.js'
import { useAlkaneStore } from './stores/alkaneStore.js'
import { useTapStore } from './stores/tapStore.js'
import { useWalletStore } from './stores/walletStore.js'
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
import { unlockWallet } from './helpers/signAndSend.js'

// Page data types
interface WalletDetailData { wallet: WalletInfo }
interface CategoryPageData { wallet: WalletInfo }
interface CollectionDetailData { wallet: WalletInfo; collectionSlug: string; collectionName: string }

type InputMode = 'normal' | 'search' | 'command' | 'modal'

// ── Generic modal system ──

interface ModalStep {
  prompt: string
  masked?: boolean
  defaultValue?: string
  validate?: (value: string) => string | null  // returns error message or null
}

interface ModalFlow {
  title: string
  steps: ModalStep[]
  onSubmit: (values: string[]) => void | Promise<void>
}

const confirmStep: ModalStep = {
  prompt: 'Confirm? (y/n):',
  validate: (v) => v.trim().toLowerCase() === 'y' ? null : 'Type "y" to confirm',
}

const passwordStep: ModalStep = { prompt: 'Password:', masked: true }

function withConfirmAndPassword(steps: ModalStep[]): ModalStep[] {
  return [...steps, confirmStep, passwordStep]
}

function withConfirm(steps: ModalStep[]): ModalStep[] {
  return [...steps, confirmStep]
}

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
        page: [{ key: 'i', action: 'Import' }, { key: 'r', action: 'Rename' }, { key: 's', action: 'Send' }],
        general: [{ key: 'enter', action: 'Select' }, { key: '/', action: 'Filter' }, ...general],
      }
    case 'wallet-detail':
      return { page: [], general: [{ key: 'enter', action: 'Open' }, { key: 'esc', action: 'Back' }, ...general] }
    case 'collection-detail':
      return {
        page: [{ key: 's', action: 'Send' }, { key: 'l', action: 'List' }, { key: 'd', action: 'Delist' }],
        general: [{ key: 'esc', action: 'Back' }, ...general],
      }
    case 'runes':
      return {
        page: [{ key: 's', action: 'Send' }, { key: 'p', action: 'Split' }],
        general: [{ key: 'esc', action: 'Back' }, ...general],
      }
    case 'brc20':
      return {
        page: [{ key: 't', action: 'Transfer' }, { key: 's', action: 'Send' }],
        general: [{ key: 'esc', action: 'Back' }, ...general],
      }
    case 'utxos':
      return {
        page: [{ key: 'c', action: 'Consolidate' }, { key: 'p', action: 'Split' }],
        general: [{ key: 'esc', action: 'Back' }, ...general],
      }
    case 'alkanes':
      return {
        page: [{ key: 's', action: 'Send' }, { key: 'p', action: 'Split' }],
        general: [{ key: 'esc', action: 'Back' }, ...general],
      }
    case 'tap':
      return {
        page: [{ key: 't', action: 'Transfer' }, { key: 's', action: 'Send' }],
        general: [{ key: 'esc', action: 'Back' }, ...general],
      }
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

  // Generic modal state
  const [modalFlow, setModalFlow] = useState<ModalFlow | null>(null)
  const [modalStepIndex, setModalStepIndex] = useState(0)
  const [modalValues, setModalValues] = useState<string[]>([])
  const [modalInput, setModalInput] = useState('')
  const [modalError, setModalError] = useState('')

  // Status feedback
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => { useNetworkStore.getState().fetch() }, [])

  // Status message auto-clear
  useEffect(() => {
    if (statusMessage) {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
      statusTimerRef.current = setTimeout(() => setStatusMessage(null), 8000)
      return () => { if (statusTimerRef.current) clearTimeout(statusTimerRef.current) }
    }
  }, [statusMessage])

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

  // ── Modal helpers ──

  function openModal(flow: ModalFlow) {
    setModalFlow(flow)
    setModalStepIndex(0)
    setModalValues([])
    setModalInput(flow.steps[0]?.defaultValue ?? '')
    setModalError('')
    setInputMode('modal')
  }

  function closeModal() {
    setInputMode('normal')
    setModalFlow(null)
    setModalStepIndex(0)
    setModalValues([])
    setModalInput('')
    setModalError('')
  }

  function showStatus(text: string, type: 'success' | 'error') {
    setStatusMessage({ text, type })
  }

  function refreshStores(address: string) {
    // Invalidate all stores so next fetch() re-requests from API
    useWalletStore.getState().invalidate(address)
    useUtxoStore.getState().invalidate(address)
    useRuneStore.getState().invalidate(address)
    useBrc20Store.getState().invalidate(address)
    useAlkaneStore.getState().invalidate(address)
    useTapStore.getState().invalidate(address)
    // Re-trigger fetches for stores the current page uses
    useWalletStore.getState().fetch(address)
    useUtxoStore.getState().fetch(address)
    const pageId = nav.current.id
    if (pageId === 'runes') useRuneStore.getState().fetch(address)
    if (pageId === 'brc20') useBrc20Store.getState().fetch(address)
    if (pageId === 'alkanes') useAlkaneStore.getState().fetch(address)
    if (pageId === 'tap') useTapStore.getState().fetch(address)
    if (pageId === 'collection-detail' || pageId === 'inscriptions') useWalletStore.getState().fetch(address)
  }

  function actionSuccess(message: string, address: string) {
    showStatus(message, 'success')
    refreshStores(address)
  }

  // ── Per-page keybinding handlers ──

  function handleWalletsKey(input: string) {
    if (input === 'i') {
      // Import wallet flow — multi-step with internal validation
      let importData = { name: '', seed: '', password: '' }
      openModal({
        title: 'Import Wallet',
        steps: [
          { prompt: 'Wallet name:', validate: (v) => v.trim() ? null : 'Name cannot be empty' },
          {
            prompt: 'Mnemonic or WIF:',
            masked: true,
            validate: (v) => {
              const trimmed = v.trim()
              if (!trimmed) return 'Mnemonic or WIF cannot be empty'
              const words = trimmed.split(/\s+/)
              if (words.length >= 12) {
                return validateMnemonic(trimmed) ? null : 'Invalid mnemonic phrase'
              }
              try { keypairFromWIF(trimmed); return null } catch { return 'Invalid WIF key' }
            },
          },
          { prompt: 'Password:', masked: true, validate: (v) => v.length >= 4 ? null : 'Password must be at least 4 characters' },
          { prompt: 'Confirm password:', masked: true },
        ],
        onSubmit: async ([name, seed, password, confirm]) => {
          if (confirm !== password) throw new Error('Passwords do not match')
          const trimmedSeed = seed.trim()
          const words = trimmedSeed.split(/\s+/)
          const kp = words.length >= 12 ? keypairFromMnemonic(trimmedSeed) : keypairFromWIF(trimmedSeed)
          const { address } = publicKeyToP2TR(kp.publicKey)
          const pubHex = bytesToHex(kp.publicKey)
          const id = saveKeystore(trimmedSeed, password, pubHex, address, name.trim())
          saveConfig({ activeWallet: id })
          setRefreshKey((k) => k + 1)
          showStatus('Wallet imported successfully', 'success')
        },
      })
      return true
    }
    if (input === 'r') {
      const wallet = filteredWallets[nav.cursor]
      if (!wallet) return true
      openModal({
        title: 'Rename Wallet',
        steps: [{ prompt: 'New name:', defaultValue: wallet.name, validate: (v) => v.trim() ? null : 'Name cannot be empty' }],
        onSubmit: async ([newName]) => {
          renameWallet(wallet.id, newName.trim())
          setRefreshKey((k) => k + 1)
          showStatus(`Renamed to "${newName.trim()}"`, 'success')
        },
      })
      return true
    }
    if (input === 's') {
      const wallet = filteredWallets[nav.cursor]
      if (!wallet) return true
      openModal({
        title: `Send BTC`,
        steps: withConfirmAndPassword([
          { prompt: 'To address:', validate: (v) => { try { validateAddress(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Amount (sats):', validate: (v) => { try { validateSats(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([to, amount, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const { psbt } = await api.transfer.buildSend({
            from: w.address,
            to: to.trim(),
            amount: parseInt(amount.trim(), 10),
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Sent! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    return false
  }

  function handleCollectionDetailKey(input: string) {
    const wallet = activeWallet
    if (!wallet) return false
    const pageData = nav.current.data as CollectionDetailData
    const walletData = useWalletStore.getState().data[wallet.address]
    if (!walletData) return false

    // Get inscription at cursor
    const inscriptions = walletData.inscriptions.filter((ins) => {
      if (pageData.collectionSlug === '_uncategorized') return !ins.collection
      return ins.collection?.slug === pageData.collectionSlug
    })
    const inscription = inscriptions[nav.cursor]
    if (!inscription) return false

    if (input === 's') {
      openModal({
        title: `Send Inscription`,
        steps: withConfirmAndPassword([
          { prompt: 'To address:', validate: (v) => { try { validateAddress(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([to, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const { psbt } = await api.transfer.buildInscriptionSend({
            inscription_id: inscription.id,
            from: w.address,
            to: to.trim(),
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Sent! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    if (input === 'l') {
      const doOpen = (floorPrice: number | null) => {
        const floorLabel = floorPrice ? ` [floor: ${formatSats(floorPrice)}]` : ''
        const confirmPrompt = floorPrice
          ? `Confirm? Floor is ${formatSats(floorPrice)} (y/n):`
          : 'Confirm? (y/n):'
        openModal({
          title: `List Inscription`,
          steps: [
            { prompt: `Price (sats)${floorLabel}:`, validate: (v) => { try { validateSats(v.trim()); return null } catch (e: any) { return e.message } } },
            { prompt: confirmPrompt, validate: (v) => v.trim().toLowerCase() === 'y' ? null : 'Type "y" to confirm' },
            passwordStep,
          ],
          onSubmit: async ([price, _confirm, password]) => {
            const w = unlockWallet(password, wallet.id)
            const { result } = await executeListInscriptions({
              inscriptionIds: [inscription.id],
              prices: [parseInt(price.trim(), 10)],
              address: w.address,
              publicKey: w.publicKey,
              privateKey: w.privateKey,
              publicKeyBytes: w.publicKeyBytes,
            })
            actionSuccess(`Listed for ${price.trim()} sats`, wallet.address)
          },
        })
      }

      if (pageData.collectionSlug !== '_uncategorized') {
        api.collection.getStats(pageData.collectionSlug)
          .then((stats) => doOpen(stats.floor_price))
          .catch(() => doOpen(null))
      } else {
        doOpen(null)
      }
      return true
    }
    if (input === 'd') {
      if (!inscription.escrow) return true
      openModal({
        title: `Delist Inscription`,
        steps: [confirmStep, passwordStep],
        onSubmit: async ([_confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          await executeDelist({
            inscriptionId: inscription.id,
            address: w.address,
            publicKey: w.publicKey,
            privateKey: w.privateKey,
            publicKeyBytes: w.publicKeyBytes,
          })
          actionSuccess('Inscription delisted', wallet.address)
        },
      })
      return true
    }
    return false
  }

  function handleRunesKey(input: string) {
    const wallet = activeWallet
    if (!wallet) return false
    const runes = useRuneStore.getState().data[wallet.address]
    const rune = runes?.[nav.cursor]
    if (!rune) return false

    if (input === 's') {
      openModal({
        title: `Send ${rune.name}`,
        steps: withConfirmAndPassword([
          { prompt: 'Amount:', validate: (v) => { try { validateAmount(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'To address:', validate: (v) => { try { validateAddress(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([amount, to, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const { psbt } = await api.transfer.buildRuneTransfer({
            from: w.address,
            to: to.trim(),
            rune: rune.rune_id,
            amount: amount.trim(),
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Sent ${amount.trim()} ${rune.name}! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    if (input === 'p') {
      openModal({
        title: `Split ${rune.name}`,
        steps: withConfirmAndPassword([
          { prompt: 'Amount:', validate: (v) => { try { validateAmount(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Splits (2-25):', validate: (v) => { try { validateSplits(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([amount, splits, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const edicts = buildSplitEdicts(rune.rune_id, amount.trim(), parseInt(splits.trim(), 10), rune.divisibility, w.address)
          const { psbt } = await api.transfer.buildRuneEdictTransfer({
            from: w.address,
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
            edicts,
            outpoints: [],
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Split ${rune.name} into ${splits.trim()}! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    return false
  }

  function handleBrc20Key(input: string) {
    const wallet = activeWallet
    if (!wallet) return false
    const tokens = useBrc20Store.getState().data[wallet.address]
    const token = tokens?.[nav.cursor]
    if (!token) return false

    if (input === 't') {
      // inscribe-transfer
      openModal({
        title: `Transfer ${token.ticker}`,
        steps: withConfirm([
          { prompt: 'Amount:', validate: (v) => { try { validateAmount(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([amount, feeRate, _confirm]) => {
          const payload = buildBrc20Payload(token.ticker, amount.trim())
          const payloadBytes = new TextEncoder().encode(payload)
          const result = await api.inscribe.upload(payloadBytes, {
            fee_rate: parseInt(feeRate.trim(), 10),
            receive_address: wallet.address,
            content_type: 'text/plain;charset=utf-8',
          })
          actionSuccess(`Transfer inscribed! ${result.txid ?? result.inscription_id ?? 'success'}`, wallet.address)
        },
      })
      return true
    }
    if (input === 's') {
      // Send an existing transfer inscription
      openModal({
        title: `Send ${token.ticker}`,
        steps: withConfirmAndPassword([
          { prompt: 'To address:', validate: (v) => { try { validateAddress(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([to, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          // Send the most recent transferable inscription for this ticker
          const walletData = useWalletStore.getState().data[wallet.address]
          const transferIns = walletData?.inscriptions.find((ins) =>
            ins.content_type === 'text/plain' && ins.meta?.tick === token.ticker
          )
          if (!transferIns) throw new Error('No transferable inscription found for this token')
          const { psbt } = await api.transfer.buildInscriptionSend({
            inscription_id: transferIns.id,
            from: w.address,
            to: to.trim(),
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Sent ${token.ticker}! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    return false
  }

  function handleUtxosKey(input: string) {
    const wallet = activeWallet
    if (!wallet) return false

    if (input === 'c') {
      openModal({
        title: 'Consolidate UTXOs',
        steps: withConfirmAndPassword([
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const utxos = useUtxoStore.getState().data[wallet.address] ?? []
          if (utxos.length < 2) throw new Error('Need at least 2 UTXOs to consolidate')
          const totalValue = utxos.reduce((sum, u) => sum + u.value, 0)
          const { psbt } = await api.wallet.buildConsolidate({
            outputs: [[w.address, totalValue]],
            public_key: w.publicKey,
            from: w.address,
            fee_rate: parseInt(feeRate.trim(), 10),
            utxos: utxos.map((u) => [`${u.txid}:${u.vout}`, u.value, u.vout]),
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Consolidated ${utxos.length} UTXOs! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    if (input === 'p') {
      openModal({
        title: 'Split UTXOs',
        steps: withConfirmAndPassword([
          { prompt: 'Splits (2-25):', validate: (v) => { try { validateSplits(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([splits, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const utxos = useUtxoStore.getState().data[wallet.address] ?? []
          const totalValue = utxos.reduce((sum, u) => sum + u.value, 0)
          const numSplits = parseInt(splits.trim(), 10)
          const perSplit = Math.floor(totalValue / numSplits)
          const outputs: [string, number][] = Array.from({ length: numSplits }, () => [w.address, perSplit])
          const { psbt } = await api.wallet.buildConsolidate({
            outputs,
            public_key: w.publicKey,
            from: w.address,
            fee_rate: parseInt(feeRate.trim(), 10),
            utxos: utxos.map((u) => [`${u.txid}:${u.vout}`, u.value, u.vout]),
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Split into ${numSplits} UTXOs! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    return false
  }

  function handleAlkanesKey(input: string) {
    const wallet = activeWallet
    if (!wallet) return false
    const alkanes = useAlkaneStore.getState().data[wallet.address]
    const alkane = alkanes?.[nav.cursor]
    if (!alkane) return false

    if (input === 's') {
      openModal({
        title: `Send Alkane ${alkane.rune_id}`,
        steps: withConfirmAndPassword([
          { prompt: 'Amount:', validate: (v) => { try { validateAmount(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'To address:', validate: (v) => { try { validateAddress(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([amount, to, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const edicts = [{
            rune_id: alkane.rune_id,
            amount: amount.trim(),
            divisibility: 0,
            destination: to.trim(),
          }]
          const { psbt } = await api.transfer.buildAlkaneTransfer({
            from: w.address,
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
            edicts,
            outpoints: [{ outpoint: alkane.outpoint, sats: alkane.sats }],
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Sent alkane! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    if (input === 'p') {
      openModal({
        title: `Split Alkane ${alkane.rune_id}`,
        steps: withConfirmAndPassword([
          { prompt: 'Amount:', validate: (v) => { try { validateAmount(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Splits (2-25):', validate: (v) => { try { validateSplits(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([amount, splits, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const numSplits = parseInt(splits.trim(), 10)
          const edicts = buildSplitEdicts(alkane.rune_id, amount.trim(), numSplits, 0, w.address)
          const { psbt } = await api.transfer.buildAlkaneTransfer({
            from: w.address,
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
            edicts,
            outpoints: [{ outpoint: alkane.outpoint, sats: alkane.sats }],
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Split alkane into ${numSplits}! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    return false
  }

  function handleTapKey(input: string) {
    const wallet = activeWallet
    if (!wallet) return false
    const tokens = useTapStore.getState().data[wallet.address]
    const token = tokens?.[nav.cursor]
    if (!token) return false

    if (input === 't') {
      openModal({
        title: `Transfer ${token.ticker}`,
        steps: withConfirm([
          { prompt: 'Amount:', validate: (v) => { try { validateAmount(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([amount, feeRate, _confirm]) => {
          const payload = buildTapPayload(token.ticker, amount.trim())
          const payloadBytes = new TextEncoder().encode(payload)
          const result = await api.inscribe.upload(payloadBytes, {
            fee_rate: parseInt(feeRate.trim(), 10),
            receive_address: wallet.address,
            content_type: 'text/plain;charset=utf-8',
          })
          actionSuccess(`Transfer inscribed! ${result.txid ?? result.inscription_id ?? 'success'}`, wallet.address)
        },
      })
      return true
    }
    if (input === 's') {
      openModal({
        title: `Send ${token.ticker}`,
        steps: withConfirmAndPassword([
          { prompt: 'To address:', validate: (v) => { try { validateAddress(v.trim()); return null } catch (e: any) { return e.message } } },
          { prompt: 'Fee rate (sat/vB):', validate: (v) => { try { validateFeeRate(v.trim()); return null } catch (e: any) { return e.message } } },
        ]),
        onSubmit: async ([to, feeRate, _confirm, password]) => {
          const w = unlockWallet(password, wallet.id)
          const walletData = useWalletStore.getState().data[wallet.address]
          const transferIns = walletData?.inscriptions.find((ins) =>
            ins.content_type === 'text/plain' && ins.meta?.tick === token.ticker
          )
          if (!transferIns) throw new Error('No transferable inscription found for this token')
          const { psbt } = await api.transfer.buildInscriptionSend({
            inscription_id: transferIns.id,
            from: w.address,
            to: to.trim(),
            fee_rate: parseInt(feeRate.trim(), 10),
            public_key: w.publicKey,
          })
          const { txid } = await signAndBroadcast(psbt, w.kp)
          actionSuccess(`Sent ${token.ticker}! txid: ${txid}`, wallet.address)
        },
      })
      return true
    }
    return false
  }

  // ── Input handler ──

  useInput((input, key) => {
    // Modal mode
    if (inputMode === 'modal' && modalFlow) {
      if (key.escape) {
        closeModal()
        return
      }
      if (key.backspace || key.delete) {
        setModalInput((v) => v.slice(0, -1))
        setModalError('')
        return
      }
      if (key.return) {
        const step = modalFlow.steps[modalStepIndex]
        const value = modalInput

        // Validate current step
        if (step.validate) {
          const err = step.validate(value)
          if (err) { setModalError(err); return }
        }

        const newValues = [...modalValues, value]

        if (modalStepIndex < modalFlow.steps.length - 1) {
          // Advance to next step
          const nextStep = modalFlow.steps[modalStepIndex + 1]
          setModalValues(newValues)
          setModalStepIndex(modalStepIndex + 1)
          setModalInput(nextStep.defaultValue ?? '')
          setModalError('')
        } else {
          // Final step — execute onSubmit
          const flow = modalFlow
          closeModal()
          Promise.resolve(flow.onSubmit(newValues)).catch((e: any) => {
            showStatus(e.message ?? 'Action failed', 'error')
          })
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

    // Normal mode — per-page keybindings
    const pageId = nav.current.id
    if (pageId === 'wallets' && handleWalletsKey(input)) return
    if (pageId === 'collection-detail' && handleCollectionDetailKey(input)) return
    if (pageId === 'runes' && handleRunesKey(input)) return
    if (pageId === 'brc20' && handleBrc20Key(input)) return
    if (pageId === 'utxos' && handleUtxosKey(input)) return
    if (pageId === 'alkanes' && handleAlkanesKey(input)) return
    if (pageId === 'tap' && handleTapKey(input)) return

    // Global keybindings
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
  const statusHeight = statusMessage ? 1 : 0
  const contentHeight = rows - headerHeight - searchBarHeight - statusHeight

  // ── Modal overlay data ──
  let modalNode: React.ReactNode = null
  if (inputMode === 'modal' && modalFlow) {
    const step = modalFlow.steps[modalStepIndex]
    modalNode = (
      <Box position="absolute" width={columns} height={rows - headerHeight} justifyContent="center" alignItems="center">
        <Modal
          title={modalFlow.title}
          prompt={step.prompt}
          value={modalInput}
          masked={step.masked}
          error={modalError}
          termWidth={columns}
          termHeight={rows}
        />
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

      {/* Status bar */}
      {statusMessage && (
        <Box paddingX={1}>
          <Text color={statusMessage.type === 'success' ? 'green' : 'red'}>{statusMessage.text}</Text>
        </Box>
      )}
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
