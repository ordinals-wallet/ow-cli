import React from 'react'
import { render } from 'ink'
import { App } from './app.js'

export async function launch() {
  // Enter alternate screen buffer (like vim/k9s)
  process.stdout.write('\x1b[?1049h')
  process.stdout.write('\x1b[?25l') // hide cursor

  const { waitUntilExit } = render(<App />)

  try {
    await waitUntilExit()
  } finally {
    // Restore main screen buffer
    process.stdout.write('\x1b[?25h') // show cursor
    process.stdout.write('\x1b[?1049l')
  }
}
