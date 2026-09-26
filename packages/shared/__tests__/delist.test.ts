import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bytesToHex, verifyBip322Simple } from '@ow-cli/core'
import { seller, sellerAddress, attacker } from '../../core/__tests__/passthrough-listing-fixtures.js'

const api = vi.hoisted(() => ({
  market: { getListing: vi.fn(), cancelEscrow: vi.fn() },
  secureListing: { status: vi.fn() },
  wallet: { getInscriptionOutpoint: vi.fn(), getUtxos: vi.fn() },
  auth: { signIn: vi.fn() },
  outpointToTxidVout: (s: string) => {
    if (/^[0-9a-f]{64}:\d+$/i.test(s)) return s.toLowerCase()
    if (!/^[0-9a-f]{72}$/i.test(s)) throw new TypeError('bad outpoint')
    const txid = s.slice(0, 64).match(/../g)!.reverse().join('')
    const vout = parseInt(s.slice(64).match(/../g)!.reverse().join(''), 16)
    return `${txid}:${vout}`
  },
}))
vi.mock('@ow-cli/api', () => api)

import { delistListing, toDelistError } from '../src/delist.js'
import { ProtectedTradeError } from '../src/protected-errors.js'

const ID = 'c'.repeat(64) + 'i0'
const LISTED = `${'ab'.repeat(32)}:1`
const LIVE_ELSEWHERE = `${'ef'.repeat(32)}:0`
const PUBLIC_KEY = bytesToHex(seller.publicKey)
const serialized = (outpoint: string) => {
  const [txid, vout] = outpoint.split(':')
  const le = Number(vout).toString(16).padStart(8, '0').match(/../g)!.reverse().join('')
  return txid.match(/../g)!.reverse().join('') + le
}

const protectedListing = {
  inscription_id: ID,
  outpoint: serialized(LISTED),
  outpoint_sats: 546,
  outpoint_address: sellerAddress,
  seller_address: sellerAddress,
  satoshi_price: 60_000,
  secure_purchase_version: 2,
  secure_purchase_state: 'listed',
  protected: true,
}
const standardListing = {
  ...protectedListing,
  outpoint: serialized(LISTED),
  secure_purchase_version: null,
  secure_purchase_state: null,
  protected: false,
}
const activeStatus = { version: 2, state: 'listed', outpoint: LISTED, protocol: 'ordinal', policy: 'passthrough_v4' }

const delist = (over: Record<string, unknown> = {}) =>
  delistListing({ inscriptionId: ID, address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey, ...over })

function apiError(status: number, body: unknown) {
  return Object.assign(new Error(typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : 'err'), {
    name: 'OwApiError',
    status,
    body,
  })
}

const TOKEN = 'ows1.session-for-seller'

beforeEach(() => {
  vi.clearAllMocks()
  api.auth.signIn.mockImplementation(async ({ address, sign }: { address: string; sign: (m: string) => string }) => {
    // Like the API: the sign-in must be a valid BIP-322 signature by `address`.
    const message = `sign in ${address}`
    if (!(await verifyBip322Simple(address, message, await sign(message)))) throw new Error('bad signature')
    return { token: TOKEN, address, expires_at: 9e9 }
  })
  api.wallet.getInscriptionOutpoint.mockResolvedValue({
    inscription: { id: ID, sat_offset: 0, outpoint: serialized(LISTED), address: sellerAddress, sats: 546 },
    owner: sellerAddress,
    sats: 546,
  })
})

describe('delistListing: snipe-protected', () => {
  beforeEach(() => {
    api.market.getListing.mockResolvedValueOnce(protectedListing).mockResolvedValue(null)
    api.secureListing.status.mockResolvedValueOnce(activeStatus).mockResolvedValue(null)
    api.market.cancelEscrow.mockResolvedValue({
      success: true,
      transition: 'cancelled',
      listing: { escrow_id: 'e1', secure_v2: true, previous_state: 'listed', state: 'cancelled' },
    })
  })

  it('routes by outpoint, never by inscription id', async () => {
    await delist()
    expect(api.market.cancelEscrow).toHaveBeenCalledTimes(1)
    const body = api.market.cancelEscrow.mock.calls[0][0]
    expect(body.outpoint).toBe(LISTED)
    expect(body.inscription_id).toBeUndefined()
  })

  it('authorizes with a session token for the seller address, not a signed transaction', async () => {
    await delist()
    expect(api.auth.signIn).toHaveBeenCalledTimes(1)
    expect(api.auth.signIn.mock.calls[0][0].address).toBe(sellerAddress)
    expect(api.market.cancelEscrow.mock.calls[0][0].signature).toBe(TOKEN)
  })

  it('reuses a caller-supplied session token without signing in again', async () => {
    await delist({ sessionToken: 'ows1.batch' })
    expect(api.auth.signIn).not.toHaveBeenCalled()
    expect(api.market.cancelEscrow.mock.calls[0][0].signature).toBe('ows1.batch')
  })

  it('reports a failed sign-in without calling cancel', async () => {
    api.auth.signIn.mockRejectedValue(new Error('nonce reused'))
    const err = await delist().catch((e) => e)
    expect(err).toBeInstanceOf(ProtectedTradeError)
    expect(err.code).toBe('sign_in_failed')
    expect(api.market.cancelEscrow).not.toHaveBeenCalled()
  })

  it('reports the kind and confirms by reading both lookups back', async () => {
    const res = await delist()
    expect(res).toMatchObject({ kind: 'protected', routedBy: 'outpoint', transition: 'cancelled', state: 'cancelled', escrowId: 'e1' })
    expect(res.verification).toEqual({ listingGone: true, protectionRetired: true })
    expect(api.secureListing.status).toHaveBeenLastCalledWith(LISTED)
  })

  it('uses the listing outpoint even when the lookup lacks its value', async () => {
    api.market.getListing.mockReset().mockResolvedValueOnce({ ...protectedListing, outpoint_sats: undefined }).mockResolvedValue(null)
    const res = await delist()
    expect(api.market.cancelEscrow.mock.calls[0][0].outpoint).toBe(LISTED)
    expect(res.outpoint).toBe(LISTED)
  })

  it('is protected when only the secure-listing status says so', async () => {
    api.market.getListing.mockReset().mockResolvedValueOnce(standardListing).mockResolvedValue(null)
    await delist()
    expect(api.market.cancelEscrow.mock.calls[0][0].outpoint).toBe(LISTED)
  })

  it('reports already_cancelled as such', async () => {
    api.market.cancelEscrow.mockResolvedValue({ success: true, transition: 'already_cancelled', listing: { escrow_id: 'e1', secure_v2: true, state: 'cancelled' } })
    const res = await delist()
    expect(res.transition).toBe('already_cancelled')
  })

  it('refuses a listing made by another key before signing anything', async () => {
    api.market.getListing.mockReset().mockResolvedValue({ ...protectedListing, seller_address: attacker.address })
    const err = await delist().catch((e) => e)
    expect(err).toBeInstanceOf(ProtectedTradeError)
    expect(err.code).toBe('not_owner_protected')
    expect(err.message).toMatch(/delist it from the wallet that listed it/)
    expect(api.market.cancelEscrow).not.toHaveBeenCalled()
  })

  it('a failed read-back does not turn a successful cancel into an error', async () => {
    api.secureListing.status.mockReset().mockResolvedValueOnce(activeStatus).mockRejectedValue(new Error('offline'))
    const res = await delist()
    expect(res.kind).toBe('protected')
    expect(res.verification.protectionRetired).toBeNull()
    expect(res.verification.error).toMatch(/offline/)
  })
})

describe('delistListing: standard', () => {
  beforeEach(() => {
    api.market.getListing.mockResolvedValueOnce(standardListing).mockResolvedValue(null)
    api.secureListing.status.mockResolvedValue(null)
    api.market.cancelEscrow.mockResolvedValue({ success: true })
    api.wallet.getInscriptionOutpoint.mockResolvedValue({
      inscription: { id: ID, sat_offset: 0, outpoint: serialized(LIVE_ELSEWHERE), address: sellerAddress, sats: 10_000 },
      owner: sellerAddress,
      sats: 10_000,
    })
  })

  it('routes by inscription id, checked against the inscription\'s current outpoint', async () => {
    const res = await delist()
    const body = api.market.cancelEscrow.mock.calls[0][0]
    expect(body.inscription_id).toBe(ID)
    expect(body.outpoint).toBeUndefined()
    expect(body.signature).toBe(TOKEN)
    expect(res.outpoint).toBe(LIVE_ELSEWHERE)
    expect(res).toMatchObject({ kind: 'standard', routedBy: 'inscription_id', transition: 'cancelled' })
    expect(res.verification).toEqual({ listingGone: true, protectionRetired: null })
  })

  it('refuses when the item is not listed', async () => {
    api.market.getListing.mockReset().mockResolvedValue(null)
    const err = await delist().catch((e) => e)
    expect(err.code).toBe('not_listed')
    expect(api.market.cancelEscrow).not.toHaveBeenCalled()
  })

  it('refuses when the inscription has left this wallet', async () => {
    api.wallet.getInscriptionOutpoint.mockResolvedValue({
      inscription: { id: ID, sat_offset: 0, outpoint: serialized(LIVE_ELSEWHERE), address: attacker.address, sats: 546 },
      owner: attacker.address,
      sats: 546,
    })
    const err = await delist().catch((e) => e)
    expect(err.code).toBe('not_owner')
  })
})

describe('delistListing: by outpoint', () => {
  it('uses the protected route when a protected listing is active there', async () => {
    api.secureListing.status.mockResolvedValueOnce(activeStatus).mockResolvedValue(null)
    api.market.cancelEscrow.mockResolvedValue({ success: true, transition: 'cancelled', listing: { escrow_id: 'e1', secure_v2: true, state: 'cancelled' } })
    const res = await delistListing({ outpoint: LISTED, address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey })
    expect(api.market.cancelEscrow.mock.calls[0][0]).toMatchObject({ outpoint: LISTED })
    expect(res.kind).toBe('protected')
    expect(res.verification).toEqual({ listingGone: null, protectionRetired: true })
  })

  it('does not need the outpoint value: the API reads it from the chain', async () => {
    api.secureListing.status.mockResolvedValue(null)
    api.market.cancelEscrow.mockResolvedValue({ success: true })
    const res = await delistListing({ outpoint: LISTED, address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey })
    expect(api.wallet.getUtxos).not.toHaveBeenCalled()
    expect(api.market.cancelEscrow.mock.calls[0][0]).toEqual({ outpoint: LISTED, signature: TOKEN })
    expect(res.kind).toBe('standard')
  })

  it('wants exactly one identifier', async () => {
    const err = await delistListing({ address: sellerAddress, publicKey: PUBLIC_KEY, privateKey: seller.privateKey }).catch((e) => e)
    expect(err.code).toBe('listing_identifier_required')
  })
})

describe('server refusals', () => {
  beforeEach(() => {
    api.market.getListing.mockResolvedValue(protectedListing)
    api.secureListing.status.mockResolvedValue(activeStatus)
  })

  const refuse = async (status: number, body: unknown) => {
    api.market.cancelEscrow.mockRejectedValue(apiError(status, body))
    return delist().catch((e) => e)
  }

  it('secure_purchase_in_flight keeps the API wording and the sale txid', async () => {
    const err = await refuse(409, {
      error: true,
      code: 'secure_purchase_in_flight',
      message: 'This protected sale is already processing and cannot be cancelled safely.',
      protection: { sale_txid: 'ff'.repeat(32), state: 'broadcast', recovery_available: false },
    })
    expect(err).toBeInstanceOf(ProtectedTradeError)
    expect(err.code).toBe('secure_purchase_in_flight')
    expect(err.stage).toBe('delist')
    expect(err.status).toBe(409)
    expect(err.message).toMatch(/already processing/)
    expect(err.message).toContain('ff'.repeat(32))
    expect(err.retryable).toBe(false)
  })

  it('maps every documented code to user-facing copy', async () => {
    const cases: Array<[number, Record<string, unknown>, string, RegExp]> = [
      [409, { error: true, code: 'listing_cancellation_not_applied', message: 'listing state changed or requires protected lifecycle recovery' }, 'listing_cancellation_not_applied', /Refresh and try again/],
      [503, { error: true, code: 'listing_cancellation_unavailable', message: 'x' }, 'listing_cancellation_unavailable', /temporarily unavailable/],
      [400, { error: true, code: 'seal_not_a_cancel_proof', message: 'Invalid Signature' }, 'seal_not_a_cancel_proof', /seal/],
      [400, { error: true, message: 'Invalid Signature' }, 'invalid_cancel_proof', /wallet that listed it/],
      [401, { error: true, code: 'not_the_owner', message: 'Sign in with the wallet that holds this listing.' }, 'not_the_owner', /wallet that listed it/],
      [404, { error: true, message: 'not found' }, 'listing_not_found', /no longer listed/],
      [400, { error: true, message: 'failed to deserialize tx' }, 'http_400', /failed to deserialize tx/],
    ]
    for (const [status, body, code, copy] of cases) {
      const err = await refuse(status, body)
      expect(err, code).toBeInstanceOf(ProtectedTradeError)
      expect(err.code).toBe(code)
      expect(err.message).toMatch(copy)
    }
  })

  it('only the 503 is retryable', async () => {
    expect((await refuse(503, { code: 'listing_cancellation_unavailable' })).retryable).toBe(true)
    expect((await refuse(409, { code: 'listing_cancellation_not_applied' })).retryable).toBe(false)
  })

  it('passes network failures through untouched', () => {
    const net = Object.assign(new Error('socket hang up'), { status: 0 })
    expect(toDelistError(net)).toBe(net)
  })
})
