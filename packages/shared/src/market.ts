import { signPsbt, signPurchaseFlow } from '@ow-cli/core'
import * as api from '@ow-cli/api'
import { delistListing } from './delist.js'
import type { DelistResult } from './delist.js'

export interface PurchaseRuneParams {
  outpoint: string
  feeRate: number
  address: string
  publicKey: string
  privateKey: Uint8Array
  publicKeyBytes: Uint8Array
}

export async function executePurchaseRune(params: PurchaseRuneParams): Promise<{ result: unknown }> {
  const { setup, purchase } = await api.market.buildPurchaseRunes({
    outpoints: [params.outpoint],
    pay_address: params.address,
    receive_address: params.address,
    public_key: params.publicKey,
    fee_rate: params.feeRate,
    wallet_type: 'ow-cli',
  })

  const { signedSetup, signedPurchase } = signPurchaseFlow(
    params.privateKey,
    params.publicKeyBytes,
    setup,
    purchase,
  )

  const result = await api.market.submitPurchaseRune({
    rawtx: signedPurchase,
    wallet_type: 'ow-cli',
  })

  return { result }
}

export interface PurchaseAlkaneParams {
  outpoints: string[]
  feeRate: number
  address: string
  publicKey: string
  privateKey: Uint8Array
  publicKeyBytes: Uint8Array
}

export async function executePurchaseAlkane(params: PurchaseAlkaneParams): Promise<{ result: unknown }> {
  const { psbt } = await api.market.buildPurchaseAlkanes({
    outpoints: params.outpoints,
    pay_address: params.address,
    receive_address: params.address,
    public_key: params.publicKey,
    fee_rate: params.feeRate,
    wallet_type: 'ow-cli',
  })

  const rawtx = signPsbt({
    psbt,
    privateKey: params.privateKey,
    publicKey: params.publicKeyBytes,
    disableExtract: false,
  })

  const result = await api.market.submitPurchaseRune({
    rawtx,
    wallet_type: 'ow-cli',
  })

  return { result }
}

export interface ListInscriptionsParams {
  inscriptionIds: string[]
  prices: number[]
  address: string
  publicKey: string
  privateKey: Uint8Array
  publicKeyBytes: Uint8Array
}

export async function executeListInscriptions(params: ListInscriptionsParams): Promise<{ result: unknown }> {
  const { psbt } = await api.market.buildEscrowBulk({
    inscriptions: params.inscriptionIds,
    from: params.address,
    prices: params.prices,
    public_key: params.publicKey,
  })

  const signedPsbt = signPsbt({
    psbt,
    privateKey: params.privateKey,
    publicKey: params.publicKeyBytes,
    disableExtract: true,
  })

  const result = await api.market.submitEscrow({ psbt: signedPsbt })
  return { result }
}

/** @deprecated Use `delistListing`, which also cancels snipe-protected listings and reports what it cancelled. */
export async function executeDelist(params: {
  inscriptionId: string
  address: string
  publicKey: string
  privateKey: Uint8Array
  publicKeyBytes?: Uint8Array
}): Promise<{ result: DelistResult }> {
  const result = await delistListing({
    inscriptionId: params.inscriptionId,
    address: params.address,
    publicKey: params.publicKey,
    privateKey: params.privateKey,
  })
  return { result }
}
