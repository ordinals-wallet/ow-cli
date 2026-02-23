#!/usr/bin/env node
import { program } from '../src/index.js'

// Strip bare '--' injected by pnpm so Commander doesn't treat it as end-of-options
const argv = process.argv.filter((arg, i) => !(arg === '--' && i === 2))

// If no subcommand and no help/version flags, launch TUI
const args = argv.slice(2)
const hasCommand = args.length > 0 && !args.every((a) => a.startsWith('-'))

if (!hasCommand && !args.includes('--help') && !args.includes('-h') && !args.includes('--version') && !args.includes('-V')) {
  import('@ow-cli/tui').then(({ launch }) => launch()).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
} else {
  program.parseAsync(argv).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
