import { getClient } from './client.js'
import { OwApiError, extractErrorMessage } from './errors.js'
import type {
  SecureListingBuildBulkRequest,
  SecureListingBuildBulkResponse,
  SecureListingAuthorizeItem,
  SecureListingAuthorizeBulkResponse,
  SecureListingStatus,
  SecureListingRecoverRequest,
  SecureListingRecoverResponse,
} from './types.js'

/**
 * Passthrough v4 (snipe-protected) listing endpoints. These return templates
 * and store signatures; they never move funds. Verify every template locally
 * (`@ow-cli/core` `assertListingTemplates`) before signing it.
 *
 * None of the POSTs here are retried by the client: a repeated authorize or
 * build is not something to do behind the caller's back.
 */

const NO_STORE = { 'Cache-Control': 'no-store' }

/** Build both templates for up to 100 items. Per-item refusals come back as rows with `error: true`. */
export async function buildBulk(params: SecureListingBuildBulkRequest): Promise<SecureListingBuildBulkResponse> {
  return getClient().post<SecureListingBuildBulkResponse>('/market/secure-listing/build-bulk', params, { headers: NO_STORE })
}

/**
 * Publish signed templates. Always resolves to `{ items }`, one row per item
 * in request order; a single-item call (which the API answers with the bare
 * item, HTTP 400 on refusal) is normalized to the same shape.
 */
export async function authorizeBulk(items: SecureListingAuthorizeItem[]): Promise<SecureListingAuthorizeBulkResponse> {
  const res = await getClient().request<any>('/market/secure-listing/authorize-bulk', {
    method: 'POST',
    body: { items },
    headers: NO_STORE,
    acceptStatus: (status) => status === 400 && items.length === 1,
  })
  const data = res.data
  if (items.length === 1 && data && !Array.isArray(data.items) && typeof data.outpoint === 'string') {
    return { items: [data] }
  }
  if (res.status === 400) {
    // A request-level refusal of a one-item call: surface it like any other HTTP error.
    throw new OwApiError({
      status: res.status,
      code: typeof data?.code === 'string' ? data.code : undefined,
      message: extractErrorMessage(data) ?? 'secure listing rejected',
      statusText: res.statusText,
      body: data,
      headers: res.headers,
      method: 'POST',
      url: '/market/secure-listing/authorize-bulk',
    })
  }
  return data
}

/** The protected listing at this outpoint, or null when there is none. */
export async function status(outpoint: string): Promise<SecureListingStatus | null> {
  const res = await getClient().request<{ error?: unknown; secure_listing?: SecureListingStatus } | undefined>(
    `/market/secure-listing/${encodeURIComponent(outpoint)}`,
    { headers: NO_STORE, acceptStatus: (s) => s === 404 },
  )
  if (res.status === 404 || !res.data || res.data.error) return null
  return res.data.secure_listing ?? null
}

/** Build (never sign) the seller's recovery of an escrow that confirmed without its sale. */
export async function recover(params: SecureListingRecoverRequest): Promise<SecureListingRecoverResponse> {
  return getClient().post<SecureListingRecoverResponse>('/market/secure-listing/recover', params, { headers: NO_STORE })
}
