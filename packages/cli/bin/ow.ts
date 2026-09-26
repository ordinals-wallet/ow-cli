#!/usr/bin/env node
import { program } from '../src/index.js'

// Strip bare '--' injected by pnpm so Commander doesn't treat it as end-of-options
const argv = process.argv.filter((arg, i) => !(arg === '--' && i === 2))

// No subcommand: show help instead of doing nothing.
if (argv.length <= 2) argv.push('--help')

program.parseAsync(argv).catch((err) => {
  console.error(err.message)
  process.exit(1)
})
