#!/usr/bin/env node
// Screenshots the built page at the sizes it actually gets read at.
//
// Serves `dist` rather than the dev server so what is inspected is what ships,
// including the Content-Security-Policy that the build injects — a layout that
// only works because a blocked font silently fell back is a layout that is
// broken in production and fine in development.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

// Screenshots are taken one viewport at a time on purpose: three headless
// Chromium pages racing each other produce flaky layout timings, and a failure
// should name the viewport that failed.
// oxlint-disable no-await-in-loop

const DIST = 'dist'
const BASE = '/unmark/'
const PORT = 4178

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  let path = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname.slice(1)
  if (path === '' || !extname(path)) path = 'index.html'

  try {
    const body = await readFile(join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, '')))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})

await new Promise((resolve) => server.listen(PORT, resolve))

const browser = await chromium.launch()
const shots = [
  { name: 'desktop-text', width: 1440, height: 1000, tab: 'text', example: true },
  { name: 'desktop-files', width: 1440, height: 1000, tab: 'files', example: false },
  { name: 'mobile-text', width: 390, height: 844, tab: 'text', example: true },
]

const problems = []

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${shot.name}: console ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`${shot.name}: ${error.message}`))
  page.on('requestfailed', (request) =>
    problems.push(`${shot.name}: request failed ${request.url()}`),
  )

  await page.goto(`http://localhost:${PORT}${BASE}#${shot.tab}`, { waitUntil: 'networkidle' })
  if (shot.example) {
    await page.getByRole('button', { name: 'Load a marked example' }).click()
    await page.waitForTimeout(300)
  }

  await page.screenshot({ path: `/tmp/unmark-${shot.name}.png`, fullPage: true })

  // A page whose body scrolls sideways is broken, not merely tight.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  if (overflow) problems.push(`${shot.name}: body scrolls horizontally`)

  await page.close()
  console.log(`  /tmp/unmark-${shot.name}.png`)
}

await browser.close()
server.close()

if (problems.length > 0) {
  console.error(`\n  ${problems.length} problem(s):`)
  for (const problem of new Set(problems)) console.error(`   x ${problem}`)
  process.exit(1)
}

console.log('  No console errors, failed requests or horizontal overflow.')
