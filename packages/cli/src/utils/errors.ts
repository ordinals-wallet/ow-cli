function isDebug(): boolean {
  return process.argv.includes('--debug')
}

export class CliError extends Error {
  constructor(message: string, public exitCode = 1) {
    super(message)
    this.name = 'CliError'
  }
}

interface AxiosErrorLike extends Error {
  response?: {
    status: number
    statusText: string
    data: unknown
  }
  config?: {
    url?: string
    data?: string
  }
}

export function handleError(err: unknown): never {
  if (typeof err === 'object' && err !== null && 'cancelled' in err) {
    process.exit(0)
  }

  if (err instanceof CliError) {
    console.error(`Error: ${err.message}`)
    process.exit(err.exitCode)
  }

  if (err instanceof Error) {
    if (err.message.includes('Unsupported state or unable to authenticate')) {
      console.error('Error: Invalid password')
      process.exit(1)
    }

    if ('response' in err) {
      const axiosErr = err as AxiosErrorLike
      const responseData = axiosErr.response?.data
      const detail = typeof responseData === 'string'
        ? responseData
        : typeof responseData === 'object' && responseData !== null && 'message' in (responseData as Record<string, unknown>)
          ? (responseData as Record<string, unknown>).message
          : null
      console.error(`\nAPI Error: ${axiosErr.response?.status} ${axiosErr.response?.statusText}`)
      if (detail) console.error(`Message: ${detail}`)
      if (isDebug()) {
        console.error('URL:', axiosErr.config?.url)
        console.error('Request body:', JSON.stringify(axiosErr.config?.data ? JSON.parse(axiosErr.config.data) : null, null, 2))
        console.error('Response:', JSON.stringify(responseData, null, 2))
      }
      process.exit(1)
    }

    console.error(`Error: ${err.message}`)
    if (isDebug()) {
      console.error(err.stack)
    }
    process.exit(1)
  }

  console.error('An unexpected error occurred')
  process.exit(1)
}
