import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.jsx = 'automatic'
  },
})
