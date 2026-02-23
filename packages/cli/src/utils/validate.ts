import type { RuneOutpoint } from '@ow-cli/api'
import { CliError } from './errors.js'
import {
  validateInscriptionId as _validateInscriptionId,
  validateOutpoint as _validateOutpoint,
  validateAddress as _validateAddress,
  validateFeeRate as _validateFeeRate,
  validatePrice as _validatePrice,
  validateSats as _validateSats,
  validateRuneId as _validateRuneId,
  validateAmount as _validateAmount,
  validateSplits as _validateSplits,
  validateOutpointWithSats as _validateOutpointWithSats,
  validateOutpointWithSatsShort as _validateOutpointWithSatsShort,
  validateOutputPair as _validateOutputPair,
  parseOutpoints as _parseOutpoints,
  ValidationError,
} from '@ow-cli/shared'

function wrapValidation<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
  return (...args: any[]) => {
    try {
      return fn(...args)
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new CliError(err.message)
      }
      throw err
    }
  }
}

export const validateInscriptionId = wrapValidation(_validateInscriptionId) as (value: string) => string
export const validateOutpoint = wrapValidation(_validateOutpoint) as (value: string) => string
export const validateAddress = wrapValidation(_validateAddress) as (value: string) => string
export const validateFeeRate = wrapValidation(_validateFeeRate) as (value: string) => number
export const validatePrice = wrapValidation(_validatePrice) as (value: string) => number
export const validateSats = wrapValidation(_validateSats) as (value: string) => number
export const validateRuneId = wrapValidation(_validateRuneId) as (value: string) => string
export const validateAmount = wrapValidation(_validateAmount) as (value: string) => string
export const validateSplits = wrapValidation(_validateSplits) as (value: string) => number
export const validateOutpointWithSats = wrapValidation(_validateOutpointWithSats) as (value: string) => { txid: string; vout: number; sats: number }
export const validateOutpointWithSatsShort = wrapValidation(_validateOutpointWithSatsShort) as (value: string) => { outpoint: string; sats: number }
export const validateOutputPair = wrapValidation(_validateOutputPair) as (value: string) => { address: string; sats: number }
export const parseOutpoints = wrapValidation(_parseOutpoints) as (raw: string) => RuneOutpoint[]
