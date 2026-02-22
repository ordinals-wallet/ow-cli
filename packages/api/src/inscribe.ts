import { getClient } from './client.js'
import type { InscribeEstimateRequest, InscribeEstimateResponse } from './types.js'

export async function estimate(params: InscribeEstimateRequest): Promise<InscribeEstimateResponse> {
  const { data } = await getClient().post('/inscribe/estimate', params)
  return data
}

export async function upload(file: Uint8Array, params: { fee_rate: number; receive_address: string; content_type: string }): Promise<any> {
  const formData = new FormData()
  formData.append('file', new Blob([file as any]), 'inscription')
  formData.append('fee_rate', String(params.fee_rate))
  formData.append('receive_address', params.receive_address)
  formData.append('content_type', params.content_type)

  const { data } = await getClient().post('/inscribe/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data
}
