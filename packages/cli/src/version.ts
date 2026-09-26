// Injected at build/test time from package.json via tsup/vitest `define`.
declare const __OW_CLI_VERSION__: string | undefined

export const CLI_VERSION: string =
  typeof __OW_CLI_VERSION__ !== 'undefined' ? __OW_CLI_VERSION__ : '0.0.0-dev'

/** Product token the CLI sends ahead of the SDK token in `x-ow-client`. */
export const CLI_APP_NAME = `ow-cli-cli/${CLI_VERSION}`
