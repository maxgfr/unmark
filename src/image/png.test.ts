import { describe, expect, it } from 'vitest'
import { bytesFromDataUrl, decodePng } from './png.ts'
import { at } from './raster.ts'

// The site's own icons are the committed real-world sample: 8-bit RGBA,
// non-interlaced, filtered by whatever wrote them. Everything else here is
// built by hand, because a decoder tested only against files it can already
// read proves nothing about the ones it cannot.
const icons = import.meta.glob('/public/pwa-*.png', {
  eager: true,
  query: '?inline',
  import: 'default',
}) as Record<string, string>

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const uint32 = (value: number) =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])

function chunk(type: string, body: Uint8Array): Uint8Array {
  const typed = new Uint8Array(type.length + body.length)
  for (const [index, character] of [...type].entries()) typed[index] = character.charCodeAt(0)
  typed.set(body, type.length)

  const out = new Uint8Array(8 + body.length + 4)
  out.set(uint32(body.length), 0)
  out.set(typed, 4)
  out.set(uint32(crc32(typed)), 8 + body.length)
  return out
}

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Build a PNG from scanlines that already carry their filter byte. */
async function png(
  width: number,
  height: number,
  depth: number,
  colorType: number,
  scanlines: Uint8Array,
  extra: Uint8Array[] = [],
): Promise<Uint8Array> {
  const header = new Uint8Array(13)
  header.set(uint32(width), 0)
  header.set(uint32(height), 4)
  header[8] = depth
  header[9] = colorType

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', await deflate(scanlines)),
    chunk('IEND', new Uint8Array(0)),
  ]

  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let written = 0
  for (const part of parts) {
    out.set(part, written)
    written += part.length
  }
  return out
}

describe('decodePng', () => {
  it('reads an 8-bit RGBA file written by something else', async () => {
    const [url] = Object.values(icons)
    expect(url).toBeDefined()
    if (!url) return

    const raster = await decodePng(bytesFromDataUrl(url))
    expect(raster.width).toBeGreaterThan(0)
    expect(raster.width).toBe(raster.height)
    expect(raster.data.length).toBe(raster.width * raster.height * 4)
    // An icon that decoded to nothing but zeros would satisfy every structural
    // assertion above and still be wrong.
    expect([...raster.data].some((value) => value > 0)).toBe(true)
  })

  it('undoes every filter type', async () => {
    // One row per filter, all encoding the same ramp. If a filter is wrong its
    // row comes out different from the others, which no dimension check finds.
    const width = 6
    const ramp = [10, 40, 70, 100, 130, 160]
    const rows = new Uint8Array(5 * (1 + width * 3))

    for (let filter = 0; filter <= 4; filter += 1) {
      const start = filter * (1 + width * 3)
      rows[start] = filter
      for (let x = 0; x < width; x += 1) {
        const value = ramp[x] ?? 0
        // Encode against the same predictors the decoder will reconstruct with.
        const left = x > 0 ? (ramp[x - 1] ?? 0) : 0
        const up = filter === 0 ? 0 : (ramp[x] ?? 0)
        const upLeft = x > 0 && filter !== 0 ? (ramp[x - 1] ?? 0) : 0
        const previous = filter === 0 ? 0 : up

        let encoded = value
        if (filter === 1) encoded = value - left
        else if (filter === 2) encoded = value - previous
        else if (filter === 3) encoded = value - ((left + previous) >> 1)
        else if (filter === 4) {
          const prediction = left + previous - upLeft
          const dLeft = Math.abs(prediction - left)
          const dUp = Math.abs(prediction - previous)
          const dUpLeft = Math.abs(prediction - upLeft)
          encoded =
            value - (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? previous : upLeft)
        }
        for (let c = 0; c < 3; c += 1) rows[start + 1 + x * 3 + c] = encoded & 0xff
      }
    }

    const raster = await decodePng(await png(width, 5, 8, 2, rows))
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < width; x += 1) {
        expect(raster.data[at(raster, x, y)]).toBe(ramp[x])
      }
    }
  })

  it('expands a palette and its transparency', async () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255])
    const alpha = new Uint8Array([255, 128, 0])
    const rows = new Uint8Array([0, 0, 1, 2])

    const raster = await decodePng(
      await png(3, 1, 8, 3, rows, [chunk('PLTE', palette), chunk('tRNS', alpha)]),
    )
    expect(Array.from(raster.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(raster.data.slice(4, 8))).toEqual([0, 255, 0, 128])
    expect(Array.from(raster.data.slice(8, 12))).toEqual([0, 0, 255, 0])
  })

  it('scales a 4-bit greyscale sample to the full range', async () => {
    // The trap in sub-8-bit depths: a 4-bit 15 is white, not a very dark grey.
    const raster = await decodePng(await png(2, 1, 4, 0, new Uint8Array([0, 0x0f])))
    expect(raster.data[0]).toBe(0)
    expect(raster.data[4]).toBe(255)
    expect(raster.data[7]).toBe(255)
  })

  it('says what is wrong rather than returning nothing', async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(/not a PNG/)

    const interlaced = await png(2, 2, 8, 2, new Uint8Array(2 * (1 + 6)))
    // Byte 12 of IHDR is the interlace method; the header starts at offset 16.
    interlaced[16 + 12] = 1
    await expect(decodePng(interlaced)).rejects.toThrow(/interlaced/)
  })
})

describe('bytesFromDataUrl', () => {
  it('reads a base64 payload', () => {
    expect([...bytesFromDataUrl('data:image/png;base64,AAECAw==')]).toEqual([0, 1, 2, 3])
  })

  it('reads a payload with no data: prefix at all', () => {
    expect([...bytesFromDataUrl('AAECAw==')]).toEqual([0, 1, 2, 3])
  })
})
