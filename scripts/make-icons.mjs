#!/usr/bin/env node
// The six icon files the manifest and index.html have always referenced.
//
// They did not exist. `index.html` asked for `/unmark/favicon.svg` and
// `/unmark/apple-touch-icon-180x180.png`, and the web manifest listed four
// `pwa-*.png` sizes — six URLs, six 404s in production, an install prompt with
// no icon and a browser tab showing the default globe.
//
// Drawn here rather than committed as opaque binaries, and rasterised without a
// browser or an image library: the shape is four rounded rectangles, which is
// little enough arithmetic to write down. That keeps the icons reviewable in a
// diff — you can read what changed — and keeps the toolchain at zero.
//
// Anti-aliasing is 3x supersampling. At these sizes it is indistinguishable
// from a real rasteriser and it is twenty lines instead of a dependency.

import { deflateSync } from 'node:zlib'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'

const OUT = 'public'

// The page's palette, so the icon and the product are the same object.
const GROUND = [0x0b, 0x0b, 0x0c]
const MUTED = [0x8b, 0x8a, 0x86]
const SIGNAL = [0xff, 0xb0, 0x20]

/** The artwork, in a 64-unit square — the same geometry as favicon.svg. */
const SHAPES = [
  { x: 12, y: 19, w: 40, h: 4, r: 2, fill: MUTED },
  { x: 12, y: 30, w: 28, h: 4, r: 2, fill: MUTED },
  { x: 12, y: 41, w: 34, h: 4, r: 2, fill: MUTED },
  { x: 8, y: 28.5, w: 48, h: 7, r: 3.5, fill: SIGNAL },
]

/** Whether a point is inside a rounded rectangle. */
function inRounded(px, py, { x, y, w, h, r }) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const cx = Math.min(Math.max(px, x + r), x + w - r)
  const cy = Math.min(Math.max(py, y + r), y + h - r)
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
}

const SUPERSAMPLE = 3

/**
 * Draw the icon at `size` pixels.
 *
 * `bleed` is for the maskable variant: Android crops a maskable icon to
 * whatever shape the launcher wants, so the artwork has to sit inside a safe
 * zone of 80% and the ground has to reach every edge.
 */
function draw(size, { bleed = false, rounded = true } = {}) {
  const pixels = Buffer.alloc(size * size * 4)
  const scale = size / 64
  const corner = rounded && !bleed ? 12 * scale : 0
  const artScale = bleed ? 0.8 : 1
  const artOffset = bleed ? (64 * (1 - artScale)) / 2 : 0

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x + (sx + 0.5) / SUPERSAMPLE
          const py = y + (sy + 0.5) / SUPERSAMPLE

          const onGround = inRounded(px, py, { x: 0, y: 0, w: size, h: size, r: corner })
          if (!onGround) continue

          let colour = GROUND
          const ux = (px / scale - artOffset) / artScale
          const uy = (py / scale - artOffset) / artScale
          for (const shape of SHAPES) {
            if (inRounded(ux, uy, shape)) colour = shape.fill
          }

          r += colour[0]
          g += colour[1]
          b += colour[2]
          a += 255
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE
      const index = (y * size + x) * 4
      const cover = a / (samples * 255)
      // Composite the anti-aliased edge against the ground itself, so a
      // rounded corner fades to transparent rather than to a grey fringe.
      pixels[index] = cover === 0 ? 0 : Math.round(r / (samples * cover))
      pixels[index + 1] = cover === 0 ? 0 : Math.round(g / (samples * cover))
      pixels[index + 2] = cover === 0 ? 0 : Math.round(b / (samples * cover))
      pixels[index + 3] = Math.round(cover * 255)
    }
  }

  return pixels
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (buffer) => {
  let c = 0xff_ff_ff_ff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xff_ff_ff_ff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Encode RGBA pixels as a PNG. Filter 0 on every row: these are tiny. */
function png(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const ICONS = [
  { name: 'pwa-64x64.png', size: 64 },
  { name: 'pwa-192x192.png', size: 192 },
  { name: 'pwa-512x512.png', size: 512 },
  { name: 'maskable-icon-512x512.png', size: 512, bleed: true },
  // Apple composites its own rounded mask, so this one ships square.
  { name: 'apple-touch-icon-180x180.png', size: 180, rounded: false },
]

await Promise.all(
  ICONS.map(async (icon) => {
    const pixels = draw(icon.size, { bleed: icon.bleed, rounded: icon.rounded ?? true })
    await writeFile(join(OUT, icon.name), png(icon.size, pixels))
    process.stdout.write(`wrote ${join(OUT, icon.name)}\n`)
  }),
)
