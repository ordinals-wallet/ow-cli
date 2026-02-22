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
  if (err instanceof CliError) {
    console.error(`Error: ${err.message}`)
    process.exit(err.exitCode)
  }

  if (err instanceof Error) {
    if (err.message.includes('Unsupported state or unable to authenticate')) {
      console.error('Error: Invalid password')
      process.exit(1)
    }

    // Show full API error details in debug mode
    if (isDebug() && 'response' in err) {
      const axiosErr = err as AxiosErrorLike
      console.error(`\nAPI Error: ${axiosErr.response?.status} ${axiosErr.response?.statusText}`)
      console.error('URL:', axiosErr.config?.url)
      console.error('Request body:', JSON.stringify(axiosErr.config?.data ? JSON.parse(axiosErr.config.data) : null, null, 2))
      console.error('Response:', JSON.stringify(axiosErr.response?.data, null, 2))
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
