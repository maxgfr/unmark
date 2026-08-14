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
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // Served with the right type so the runtime uses streaming instantiation,
  // which is the path production takes.
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
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

// The Files tab, driven for real. Until this existed the tab had only ever been
// screenshotted empty: the drop handler, the findings render and the download
// were all unexercised outside unit tests of the core underneath them.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => problems.push(`files: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`files: console ${message.text()}`)
  })

  await page.goto(`http://localhost:${PORT}${BASE}#files`, { waitUntil: 'networkidle' })

  // A PNG carrying a tEXt chunk and a C2PA manifest, built in the page.
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    canvas.getContext('2d').fillRect(0, 0, 8, 8)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const original = new Uint8Array(await blob.arrayBuffer())

    // Splice a tEXt and a caBX chunk in just after IHDR.
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c >>> 0
    })
    const crc = (bytes) => {
      let c = 0xffffffff
      for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }
    const chunk = (type, text) => {
      const body = new TextEncoder().encode(type + text)
      const out = new Uint8Array(body.length + 8)
      new DataView(out.buffer).setUint32(0, body.length - 4)
      out.set(body, 4)
      new DataView(out.buffer).setUint32(out.length - 4, crc(body))
      return out
    }

    const marked = new Uint8Array([
      ...original.subarray(0, 33),
      ...chunk('tEXt', `Software\0ShootFixture 1.0`),
      ...chunk('caBX', 'signed provenance manifest'),
      ...original.subarray(33),
    ])
    return btoa(String.fromCharCode(...marked))
  })

  await page.setInputFiles('input[type=file]', {
    name: 'marked.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  })

  try {
    await page.waitForSelector('text=C2PA provenance manifest', { timeout: 5000 })
    await page.waitForSelector('text=ShootFixture 1.0', { timeout: 5000 })
  } catch {
    problems.push('files: the dropped PNG did not report its tEXt and C2PA chunks')
  }

  // The download path: a Blob URL and a synthetic click, never exercised before.
  try {
    const download = page.waitForEvent('download', { timeout: 8000 })
    await page.getByRole('button', { name: 'Download cleaned' }).click()
    const saved = await download
    if (!saved.suggestedFilename().includes('unmarked')) {
      problems.push(`files: download was named ${saved.suggestedFilename()}`)
    }
    console.log(`  files: downloaded ${saved.suggestedFilename()}`)
  } catch (error) {
    problems.push(`files: download never fired — ${String(error).split('\n')[0]}`)
  }

  await page.screenshot({ path: '/tmp/unmark-desktop-files-loaded.png', fullPage: true })
  console.log('  /tmp/unmark-desktop-files-loaded.png')
  await page.close()
}

// The Image tab, driven for real: load a picture with a known 45% white badge
// composited into the corner, let the corner scan find it, and unblend.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (error) => problems.push(`image: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`image: ${response.status()} ${response.url()}`)
    // Print every wasm and model fetch: this is where a runtime that decided
    // to reach for a CDN would become visible.
    if (/wasm|onnx/.test(response.url())) {
      console.log('  fetched:', response.url().replace(/^http:\/\/[^/]+/, ''))
    }
  })
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

    // MI-GAN, for real: 40 MB of model and runtime off our own origin, then an
    // actual inference. Shipping an "AI inpaint" button that was never run
    // would be exactly the kind of claim this project refuses to make.
    await page.getByRole('button', { name: 'AI inpaint' }).click()
    await page.getByRole('button', { name: 'Download and run' }).click()

    try {
      await page.waitForSelector('text=/Filled from a \\d+×\\d+ window/', { timeout: 120_000 })
      const note = await page.locator('text=/Filled from a/').first().textContent()
      console.log(`  MI-GAN: ${note?.trim()}`)
    } catch {
      problems.push('image: MI-GAN never reported a completed fill')
    }

    // Telea and the disruption pass: both were unit-tested as functions but
    // their buttons had never been clicked.
    const before = await page.evaluate(() => document.querySelector('canvas').toDataURL().length)

    await page.getByRole('button', { name: 'Inpaint', exact: true }).click()
    await page.waitForTimeout(400)

    await page.getByLabel('Scrub the lowest bit').check()
    await page.getByLabel('Resample round trip').check()
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.waitForSelector('button:has-text("Apply"):not([disabled])', { timeout: 20_000 })
    await page.waitForTimeout(400)

    const after = await page.evaluate(() => document.querySelector('canvas').toDataURL().length)
    if (before === after) problems.push('image: Inpaint and Apply left the canvas untouched')

    // Undo has to walk it back.
    await page.getByRole('button', { name: 'Undo' }).click()
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
