import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CliError, handleError } from '../src/utils/errors.js'

describe('CliError', () => {
  it('should create error with message and default exit code', () => {
    const err = new CliError('something went wrong')
    expect(err.message).toBe('something went wrong')
    expect(err.exitCode).toBe(1)
    expect(err.name).toBe('CliError')
  })

  it('should create error with custom exit code', () => {
    const err = new CliError('bad input', 2)
    expect(err.exitCode).toBe(2)
  })

  it('should be instanceof Error', () => {
    const err = new CliError('test')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('handleError', () => {
  const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  const mockError = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    mockExit.mockClear()
    mockError.mockClear()
  })

  it('should handle CliError with custom exit code', () => {
    handleError(new CliError('custom error', 2))
    expect(mockError).toHaveBeenCalledWith('Error: custom error')
    expect(mockExit).toHaveBeenCalledWith(2)
  })

  it('should handle CliError with default exit code', () => {
    handleError(new CliError('default error'))
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('should detect invalid password error', () => {
    handleError(new Error('Unsupported state or unable to authenticate data'))
    expect(mockError).toHaveBeenCalledWith('Error: Invalid password')
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('should handle generic Error', () => {
    handleError(new Error('something broke'))
    expect(mockError).toHaveBeenCalledWith('Error: something broke')
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('should handle non-Error values', () => {
    handleError('string error')
    expect(mockError).toHaveBeenCalledWith('An unexpected error occurred')
    expect(mockExit).toHaveBeenCalledWith(1)
  })

  it('should handle null', () => {
    handleError(null)
    expect(mockError).toHaveBeenCalledWith('An unexpected error occurred')
    expect(mockExit).toHaveBeenCalledWith(1)
  })
})
