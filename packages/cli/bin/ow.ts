#!/usr/bin/env node
import { program } from '../src/index.js'

// Strip bare '--' injected by pnpm so Commander doesn't treat it as end-of-options
const argv = process.argv.filter((arg, i) => !(arg === '--' && i === 2))

program.parseAsync(argv).catch((err) => {
  console.error(err.message)
  process.exit(1)
})
