import { isOwApiError } from '@ow-cli/api'
import { PassthroughError } from '@ow-cli/core'

function isDebug(): boolean {
  return process.argv.includes('--debug')
}

export class CliError extends Error {
  constructor(message: string, public exitCode = 1) {
    super(message)
    this.name = 'CliError'
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

    // Protected-trading refusals (local verification or a mapped API code):
    // the code is stable and the message is already user-facing.
    if (err instanceof PassthroughError) {
      console.error(`Error [${err.code}]: ${err.message}`)
      if (isDebug()) console.error(err.stack)
      process.exit(1)
    }

    if (isOwApiError(err)) {
      const where = [err.method, err.url].filter(Boolean).join(' ')
      if (err.status === 0) {
        console.error(`\nNetwork Error${err.code ? ` (${err.code})` : ''}: ${err.message}`)
      } else {
        console.error(`\nAPI Error: ${err.status}${err.statusText ? ` ${err.statusText}` : ''}`)
        console.error(`Message: ${err.message}`)
      }
      if (err.retries > 0) console.error(`(after ${err.retries} retr${err.retries === 1 ? 'y' : 'ies'})`)
      if (isDebug()) {
        if (where) console.error('Request:', where)
        console.error('Response:', JSON.stringify(err.body ?? null, null, 2))
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
