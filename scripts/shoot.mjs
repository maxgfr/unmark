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
import { Buffer } from 'node:buffer'
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

/**
 * A textured picture with a flat white badge composited into a corner, encoded
 * as a real PNG by the browser itself.
 *
 * Built here rather than committed because a fixture you cannot read in a diff
 * tells you nothing about what it contains — and this one has to state exactly
 * which alpha was used, so the assertion below can check the recovery.
 */
async function markedPng(page, alpha) {
  return page.evaluate(async (a) => {
    const size = 320
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')

    const image = context.createImageData(size, size)
    let seed = 12345
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4
        image.data[i] = 40 + (x / size) * 140 + random() * 70
        image.data[i + 1] = 80 + (y / size) * 110 + random() * 70
        image.data[i + 2] = 170 - (x / size) * 90 + random() * 70
        image.data[i + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)

    context.globalAlpha = a
    context.fillStyle = '#ffffff'
    context.fillRect(size - 70, size - 70, 55, 55)

    const url = canvas.toDataURL('image/png')
    return url.slice(url.indexOf(',') + 1)
  }, alpha)
}

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

// The Image tab, driven for real: load a picture with a known 45% white badge
// composited into the corner, let the corner scan find it, and unblend.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => problems.push(`image: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`image: console ${message.text()}`)
  })

  await page.goto(`http://localhost:${PORT}${BASE}#image`, { waitUntil: 'networkidle' })

  const base64 = await markedPng(page, 0.45)
  await page.setInputFiles('input[type=file]', {
    name: 'marked.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  })
  await page.waitForSelector('canvas', { timeout: 5000 })

  const candidates = page.locator('button', { hasText: /α \d+%/ })
  const found = await candidates.count()
  if (found === 0) problems.push('image: the corner scan found no overlay in a marked picture')

  if (found > 0) {
    await candidates.first().click()
    await page.waitForTimeout(200)

    // The estimate on the confirmed region should land near the real 45%.
    const readout = await page.locator('text=/\\d+% opaque/').first().textContent()
    const estimated = Number(/(\d+)% opaque/.exec(readout ?? '')?.[1] ?? '0')
    if (estimated < 20) problems.push(`image: estimated only ${estimated}% for a 45% overlay`)

    await page.getByRole('button', { name: 'Unblend' }).click()
    await page.waitForTimeout(300)
  }

  await page.screenshot({ path: '/tmp/unmark-desktop-image.png', fullPage: true })
  console.log('  /tmp/unmark-desktop-image.png')
  await page.close()
}

await browser.close()
server.close()

if (problems.length > 0) {
  console.error(`\n  ${problems.length} problem(s):`)
  for (const problem of new Set(problems)) console.error(`   x ${problem}`)
  process.exit(1)
}

console.log('  No console errors, failed requests or horizontal overflow.')
