/** Body of `POST /auth/session`. */
export interface CreateSessionRequest {
  address: string
  /** 16 to 64 hex characters; burned on first use. */
  nonce: string
  /** Unix milliseconds; must be within the last 5 minutes. */
  issued_at: number
  /** Base64 BIP-322 simple signature over `signInMessage(address, nonce, issued_at)`. */
  signature: string
}

/** A wallet session. `token` goes in `signature` / `creator_signature` fields. */
export interface AuthSession {
  /** `ows1.…` HMAC session token. Treat like a password. */
  token: string
  address: string
  /** Unix seconds. Tokens last 24 hours. */
  expires_at: number
}

/** Signs a message with BIP-322 for the address being signed in; returns base64. */
export type MessageSigner = (message: string) => Promise<string> | string
