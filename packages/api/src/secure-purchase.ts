import type { SecurePurchaseCapabilities } from './types.js'
import {
  getSecurePurchaseCapabilities,
  buildSecurePurchase,
  submitSecurePurchase,
} from './market.js'

/**
 * Passthrough v4 (snipe-protected) purchase endpoints. `build` returns sale
 * PSBTs to verify locally before signing; `submit` hands back sales with only
 * the buyer's inputs signed.
 */

/** What protection the marketplace offers right now, and its co-signer key. */
export function capabilities(): Promise<SecurePurchaseCapabilities> {
  return getSecurePurchaseCapabilities()
}

export { buildSecurePurchase as build, submitSecurePurchase as submit }
