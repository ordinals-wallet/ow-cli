import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts', 'bin/ow.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: {
    js: '',
  },
})
