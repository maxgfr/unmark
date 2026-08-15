// Decoding a PNG without a browser and without a dependency.
//
// canvas.ts already decodes anything the platform can read, and that is what
// the app uses. But the test suite runs in Node, where there is no
// createImageBitmap, and the one thing the image pipeline has never been run
// against is a file somebody actually downloaded from a generator. Without a
// decoder that works under Node, `fixtures/real/` could only ever hold buffers
// written by the same code that reads them — which is the exact circularity the
// coverage fixtures were written to escape.
//
// So: PNG, and only PNG. The inflate comes from DecompressionStream, which Node
// and every target browser have had for years, so the whole decoder is a header
// parse, an unfilter and a channel expansion. Adding JPEG would mean a DCT, a
// Huffman decoder and colour conversion — several hundred lines to read a
// format the app itself never has to parse — so a JPEG dropped into
// fixtures/real is reported as unreadable rather than half-handled.
//
// Interlaced PNGs are refused for the same reason: Adam7 is a second scanline
// layout for a case no generator emits.

import { createRaster, type Raster } from './raster.ts'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Channels per pixel for each PNG colour type. Index 1 and 5 do not exist. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

interface Header {
  width: number
  height: number
  depth: number
  colorType: number
  interlace: number
}

const readUint32 = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] ?? 0) << 24) |
  ((bytes[offset + 1] ?? 0) << 16) |
  ((bytes[offset + 2] ?? 0) << 8) |
  (bytes[offset + 3] ?? 0)

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // IDAT carries a zlib stream, header and Adler-32 included, which is what
  // 'deflate' means here — 'deflate-raw' would be the headerless one.
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Undo the per-scanline filters.
 *
 * PNG filters each row against the row above and the pixel to the left, so this
 * has to run in order and in place: row n's reconstruction is row n+1's input.
 */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const stride = Math.ceil((width * bytesPerPixel * 8) / 8)
  const out = new Uint8Array(stride * height)
  const step = Math.max(1, Math.round(bytesPerPixel))

  for (let y = 0; y < height; y += 1) {
    const from = y * (stride + 1)
    const filter = raw[from] ?? 0
    const line = from + 1
    const target = y * stride
    const above = target - stride

    for (let x = 0; x < stride; x += 1) {
      const value = raw[line + x] ?? 0
      const left = x >= step ? (out[target + x - step] ?? 0) : 0
      const up = y > 0 ? (out[above + x] ?? 0) : 0
      const upLeft = y > 0 && x >= step ? (out[above + x - step] ?? 0) : 0

      let restored = value
      if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) {
        // Paeth: whichever of the three neighbours the linear prediction lands
        // closest to.
        const prediction = left + up - upLeft
        const dLeft = Math.abs(prediction - left)
        const dUp = Math.abs(prediction - up)
        const dUpLeft = Math.abs(prediction - upLeft)
        restored = value + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft)
      } else if (filter > 4) {
        throw new Error(`unknown PNG filter ${filter} on row ${y}`)
      }
      out[target + x] = restored & 0xff
    }
  }
  return out
}

/** Read one sample of `depth` bits from a packed scanline. */
function sampleAt(row: Uint8Array, offset: number, index: number, depth: number): number {
  if (depth === 8) return row[offset + index] ?? 0
  if (depth === 16) return row[offset + index * 2] ?? 0

  const perByte = 8 / depth
  const byte = row[offset + Math.floor(index / perByte)] ?? 0
  const shift = 8 - depth * ((index % perByte) + 1)
  return (byte >> shift) & ((1 << depth) - 1)
}

/**
 * Decode a PNG into the plain RGBA buffer everything else in src/image uses.
 *
 * Throws with a specific reason rather than returning undefined: every caller
 * of this is a test or a CLI, and "which file, and why" is the only useful
 * thing to say when a real fixture will not open.
 */
export async function decodePng(bytes: Uint8Array): Promise<Raster> {
  for (const [index, expected] of SIGNATURE.entries()) {
    if (bytes[index] !== expected) throw new Error('not a PNG')
  }

  let header: Header | undefined
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const parts: Uint8Array[] = []

  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = readUint32(bytes, offset)
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    )
    const body = bytes.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      header = {
        width: readUint32(body, 0),
        height: readUint32(body, 4),
        depth: body[8] ?? 0,
        colorType: body[9] ?? 0,
        interlace: body[12] ?? 0,
      }
    } else if (type === 'PLTE') palette = new Uint8Array(body)
    else if (type === 'tRNS') transparency = new Uint8Array(body)
    else if (type === 'IDAT') parts.push(new Uint8Array(body))
    else if (type === 'IEND') break

    offset += 12 + length
  }

  if (!header) throw new Error('this PNG has no IHDR')
  const { width, height, depth, colorType, interlace } = header
  if (width <= 0 || height <= 0) throw new Error('this PNG declares no pixels')
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported')

  const channels = CHANNELS[colorType]
  if (!channels) throw new Error(`unknown PNG colour type ${colorType}`)
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`unsupported PNG bit depth ${depth}`)
  if (depth < 8 && colorType !== 0 && colorType !== 3) {
    throw new Error(`bit depth ${depth} is only defined for greyscale and palette PNGs`)
  }
  if (parts.length === 0) throw new Error('this PNG has no image data')

  const compressed = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let written = 0
  for (const part of parts) {
    compressed.set(part, written)
    written += part.length
  }

  const bitsPerPixel = depth * channels
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const raw = await inflate(compressed)
  if (raw.length < (stride + 1) * height) throw new Error('this PNG is truncated')

  const rows = unfilter(raw, width, height, bitsPerPixel / 8)
  const raster = createRaster(width, height)
  // Sub-8-bit samples carry their own scale: a 4-bit grey 15 is white, not 15.
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1

  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4
      const read = (channel: number) => sampleAt(rows, row, x * channels + channel, depth)

      if (colorType === 3) {
        const index = read(0)
        const source = index * 3
        raster.data[target] = palette?.[source] ?? 0
        raster.data[target + 1] = palette?.[source + 1] ?? 0
        raster.data[target + 2] = palette?.[source + 2] ?? 0
        raster.data[target + 3] = transparency?.[index] ?? 255
      } else if (colorType === 0 || colorType === 4) {
        const grey = read(0) * scale
        raster.data[target] = grey
        raster.data[target + 1] = grey
        raster.data[target + 2] = grey
        raster.data[target + 3] = colorType === 4 ? read(1) : 255
      } else {
        raster.data[target] = read(0)
        raster.data[target + 1] = read(1)
        raster.data[target + 2] = read(2)
        raster.data[target + 3] = colorType === 6 ? read(3) : 255
      }
    }
  }

  return raster
}

/**
 * Bytes out of a `data:` URL.
 *
 * This is how the test suite gets at `fixtures/real/` at all: the app's
 * tsconfig deliberately carries no Node types, so a test cannot open a file,
 * and Vite's `?inline` import hands the contents over as base64 instead.
 */
export function bytesFromDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(',')
  const payload = comma === -1 ? url : url.slice(comma + 1)
  if (comma !== -1 && !url.slice(0, comma).includes('base64')) {
    return new TextEncoder().encode(decodeURIComponent(payload))
  }
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
