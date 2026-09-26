import { describe, it, expect } from 'vitest'
import { getClient, SDK_CLIENT_TOKEN } from '@ow-cli/api'
import { program } from '../src/index.js'
import { CLI_APP_NAME } from '../src/version.js'
import pkg from '../package.json' with { type: 'json' }

describe('CLI client identification', () => {
  it('tags API traffic as the CLI ahead of the SDK token', () => {
    expect(program.version()).toBe(pkg.version)
    expect(CLI_APP_NAME).toBe(`ow-cli-cli/${pkg.version}`)
    expect(getClient().defaults.headers['x-ow-client']).toBe(`ow-cli-cli/${pkg.version} ${SDK_CLIENT_TOKEN}`)
  })
})
