/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// Timing budgets, one file at a time. In the main suite every test file runs
// in parallel, and a budget there measures the neighbours as much as the code:
// the same detector run took 0.75 s alone and 2.4 s beside forty other files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.perf.test.ts'],
    fileParallelism: false,
  },
})
