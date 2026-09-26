import { getClient } from './client.js'
import { OwApiError, toOwApiError } from './errors.js'
import type { AuthSession, CreateSessionRequest, MessageSigner } from './types-auth.js'

/**
 * The exact sign-in message the API rebuilds and verifies. Must match
 * byte for byte, so never reformat it.
 */
export function signInMessage(address: string, nonce: string, issuedAtMs: number): string {
  return (
    'Sign in to Ordinals Wallet\n\n' +
    'This proves you own this address. It does not move funds or cost a fee.\n\n' +
    `Address: ${address}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAtMs}`
  )
}

/** A random 32-hex-character nonce (16 bytes from the platform CSPRNG). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Sign-in failed: bad, expired or reused signature, or no signer. Extends
 * `OwApiError`; `status` is 0 when no request was made.
 */
export class AuthError extends OwApiError {
  constructor(message: string, status = 0, from?: OwApiError) {
    super({
      status,
      message,
      code: from?.code,
      body: from?.body,
      method: from?.method,
      url: from?.url,
      retries: from?.retries,
      response: from?.response,
      config: from?.config,
      cause: from,
    })
    Object.defineProperty(this, 'name', { value: 'AuthError', configurable: true })
  }
}

function toAuthError(err: unknown): unknown {
  const api = toOwApiError(err)
  if (api.status === 0) return api
  return new AuthError(api.message || `Sign-in failed (HTTP ${api.status})`, api.status, api)
}

/** Raw `POST /auth/session`. Prefer `signIn`. */
export async function createSession(params: CreateSessionRequest): Promise<AuthSession> {
  try {
    const { data } = await getClient().post('/auth/session', params)
    return data
  } catch (err) {
    throw toAuthError(err)
  }
}

export interface SignInParams {
  address: string
  /** BIP-322 simple signer for `address` (base64). */
  sign: MessageSigner
  /** Override for tests; defaults to a fresh random nonce. */
  nonce?: string
  /** Override for tests; defaults to `Date.now()`. */
  issuedAt?: number
}

/**
 * Wallet sign-in: builds the sign-in message with a fresh nonce, asks `sign`
 * for a BIP-322 signature and exchanges it for a 24-hour session token.
 */
export async function signIn(params: SignInParams): Promise<AuthSession> {
  const nonce = params.nonce ?? generateNonce()
  const issuedAt = params.issuedAt ?? Date.now()
  const signature = await params.sign(signInMessage(params.address, nonce, issuedAt))
  return createSession({ address: params.address, nonce, issued_at: issuedAt, signature })
}

export interface SessionManagerOptions {
  /** Default signer used when `getToken` is called without one. */
  sign?: (address: string, message: string) => Promise<string> | string
  /** Refresh when this close to `expires_at`. Default 300 (5 minutes). */
  refreshBeforeSecs?: number
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number
}

/**
 * Caches one session token per address in memory and signs in again when a
 * token is within `refreshBeforeSecs` of expiry. Concurrent callers for the
 * same address share one sign-in.
 */
export class SessionManager {
  private readonly sessions = new Map<string, AuthSession>()
  private readonly inflight = new Map<string, Promise<AuthSession>>()
  private readonly refreshBeforeSecs: number
  private readonly now: () => number

  constructor(private readonly opts: SessionManagerOptions = {}) {
    this.refreshBeforeSecs = opts.refreshBeforeSecs ?? 300
    this.now = opts.now ?? Date.now
  }

  /** The cached session if it is still comfortably valid. */
  peek(address: string): AuthSession | undefined {
    const s = this.sessions.get(address)
    if (!s) return undefined
    return s.expires_at - this.refreshBeforeSecs > this.now() / 1000 ? s : undefined
  }

  /** A valid session for `address`, signing in if needed. */
  async getSession(address: string, sign?: MessageSigner): Promise<AuthSession> {
    const cached = this.peek(address)
    if (cached) return cached
    const pending = this.inflight.get(address)
    if (pending) return pending

    const signer: MessageSigner | undefined =
      sign ?? (this.opts.sign ? (m: string) => this.opts.sign!(address, m) : undefined)
    if (!signer) throw new AuthError(`No signer available to sign in ${address}`)

    const p = signIn({ address, sign: signer, issuedAt: this.now() })
      .then((s) => {
        this.sessions.set(address, s)
        return s
      })
      .finally(() => this.inflight.delete(address))
    this.inflight.set(address, p)
    return p
  }

  /** The session token for `address`, for `signature` / `creator_signature` fields. */
  async getToken(address: string, sign?: MessageSigner): Promise<string> {
    return (await this.getSession(address, sign)).token
  }

  /** Store a session obtained elsewhere. */
  set(session: AuthSession): void {
    this.sessions.set(session.address, session)
  }

  /** Forget a token, e.g. after the API rejects it. */
  invalidate(address: string): void {
    this.sessions.delete(address)
  }

  clear(): void {
    this.sessions.clear()
  }
}
