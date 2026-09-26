// Injected at build time by tsup (and at test time by vitest) from package.json
// via `define`, so no runtime fs/JSON reads are needed in browser bundles.
declare const __OW_CLI_VERSION__: string | undefined

export const VERSION: string =
  typeof __OW_CLI_VERSION__ !== 'undefined' ? __OW_CLI_VERSION__ : '0.0.0-dev'
