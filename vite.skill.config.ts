import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// The same core, delivered twice.
//
// src/core is written without a single DOM or node: import so it can be bundled
// into the page *and* emitted here as one dependency-free ESM file that the
// Claude skill and the CLI run under Node. Two deliveries, one implementation —
// what the page reports and what the terminal reports cannot drift, because
// there is only one of them.
export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'skills/unmark/scripts',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/cli/unmark.ts'),
      formats: ['es'],
      fileName: () => 'unmark.mjs',
    },
    rollupOptions: {
      // Node builtins stay external; everything else must be inlined, which is
      // what makes the published skill installable with nothing to `npm i`.
      external: (id) => id.startsWith('node:'),
      output: { banner: '#!/usr/bin/env node' },
    },
  },
})
