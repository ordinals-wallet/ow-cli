import { getClient } from './client.js'
import type { InscribeEstimateRequest, InscribeEstimateResponse, InscribeUploadResponse } from './types.js'

export async function estimate(params: InscribeEstimateRequest): Promise<InscribeEstimateResponse> {
  return getClient().post<InscribeEstimateResponse>('/inscribe/estimate', params)
}

export async function upload(file: Uint8Array, params: { fee_rate: number; receive_address: string; content_type: string }): Promise<InscribeUploadResponse> {
  const formData = new FormData()
  formData.append('file', new Blob([file as BlobPart]), 'inscription')
  formData.append('fee_rate', String(params.fee_rate))
  formData.append('receive_address', params.receive_address)
  formData.append('content_type', params.content_type)

  // fetch sets the multipart Content-Type (with boundary) for FormData.
  return getClient().post<InscribeUploadResponse>('/inscribe/upload', formData)
}
