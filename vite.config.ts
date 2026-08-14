/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
// @ts-expect-error -- plain ESM shared with scripts/check-network.mjs, which is
// run by node and so cannot import a .ts module.
import { CSP } from './scripts/csp.mjs'

// Project pages live under https://maxgfr.github.io/unmark/, so every asset URL
// carries the prefix. Routing is tab state held in the URL hash, which keeps
// deep links working without a 404 fallback.
const BASE = '/unmark/'

// Asserted in the README, enforced by the browser. Injected at build time only:
// the dev server needs a websocket for HMR, and production is the artifact that
// has to hold. See scripts/csp.mjs for what each connect-src origin is for.
const contentSecurityPolicy = (): Plugin => ({
  name: 'unmark:csp',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html) =>
      html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  },
})

export default defineConfig({
  base: BASE,
  plugins: [
    contentSecurityPolicy(),
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt' rather than 'autoUpdate': reloading the page under someone who
      // has an 80 MB model resident in memory and a mask half-drawn is the one
      // thing this app must never do on its own.
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The models are megabytes and opt-in; precaching them would defeat the
        // point of making the download a deliberate choice. They live in the
        // Cache API instead, written only after the user says yes.
        globIgnores: ['**/vendor/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'unmark — watermark & provenance-mark remover',
        short_name: 'unmark',
        description:
          'Strip invisible Unicode, C2PA/EXIF/XMP metadata and visible image watermarks. Nothing leaves your device.',
        theme_color: '#0b0b0c',
        background_color: '#0b0b0c',
        display: 'standalone',
        scope: BASE,
        start_url: BASE,
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  build: {
    target: 'es2022',
    cssMinify: 'lightningcss',
  },
  test: {
    // Node by default: the core is the part under test, and it must run against
    // the real DecompressionStream and TextDecoder rather than jsdom's shims —
    // that is exactly the code path the CLI takes. UI files opt into jsdom with
    // a `// @vitest-environment jsdom` docblock.
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
