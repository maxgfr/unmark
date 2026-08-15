// A static server over `dist`, so what the tests drive is what ships.
//
// Not the dev server, and the difference matters: the build injects the
// Content-Security-Policy, and a layout that only works because a blocked font
// quietly fell back is broken in production and fine in development. The same
// applies to the service worker, which is only emitted by a build.
//
// Extracted from scripts/shoot.mjs so the screenshot script, the Playwright
// web server and the specs all serve bytes one way rather than three.
//
// Plain ESM rather than TypeScript because Playwright starts it with bare
// `node`, and adding a loader to the toolchain to serve five hundred bytes of
// static files would be a poor trade.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

export const BASE = '/unmark/'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  // Served with the right type so the runtime uses streaming instantiation,
  // which is the path production takes.
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
}

/**
 * Serve `dist` on `port`.
 *
 * `sw.js` goes out with `Service-Worker-Allowed` so the worker may claim the
 * whole base path, which is what the offline test needs and what GitHub Pages
 * does by default.
 */
export async function serveDist(port, dist = 'dist') {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`)
    let path = url.pathname.startsWith(BASE)
      ? url.pathname.slice(BASE.length)
      : url.pathname.slice(1)
    if (path === '' || !extname(path)) path = 'index.html'

    try {
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
      const body = await readFile(join(dist, safe))
      response.writeHead(200, {
        'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
        'service-worker-allowed': BASE,
        // No caching, so a reload inside a test sees the file rather than a
        // copy the browser decided to keep.
        'cache-control': 'no-store',
      })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })

  await new Promise((resolve) => server.listen(port, resolve))

  return {
    url: `http://localhost:${port}${BASE}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
