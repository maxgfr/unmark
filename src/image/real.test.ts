import { describe, expect, it } from 'vitest'
import { bytesFromDataUrl, decodePng } from './png.ts'
import { coverageMap, estimateShaped, unblendVarying } from './detect/coverage.ts'
import { estimateOverlay, findCornerOverlays, type Rect } from './detect/overlay.ts'
import { inpaint, rectMask } from './inpaint/telea.ts'
import { addNoise, disrupt, scrubLowBits } from './disrupt.ts'
import { at, type Raster } from './raster.ts'

// The one thing every other test in src/image has in common is that its input
// was produced by src/image. The fixtures are honest — the shaped badge in
// coverage.test.ts was built specifically not to agree with the model under
// test — but they are still synthetic, and no synthetic fixture has JPEG
// ringing around the glyph, a badge sitting half on a face, or a 12-megapixel
// frame.
//
// So this runs over whatever is in fixtures/real, which is gitignored: drop in
// files you actually got out of a generator and the suite exercises the whole
// pipeline on them. It asserts invariants rather than quality, because there is
// no ground truth for a real file — nobody has the un-badged original. What can
// be checked is that nothing throws, that the picture keeps its size, and that
// every operation leaves the pixels outside its region exactly as they were.
// Those are the properties that make an edit safe to offer someone.
//
// PNG only, and png.ts says why. `?inline` rather than a file read because the
// app's tsconfig deliberately carries no Node types.

const files = import.meta.glob('/fixtures/real/*.{png,PNG,jpg,jpeg,JPG,JPEG,webp,WEBP,gif,avif}', {
  eager: true,
  query: '?inline',
  import: 'default',
}) as Record<string, string>

const entries = Object.entries(files)
const readable = entries.filter(([path]) => /\.png$/i.test(path))
const unreadable = entries.filter(([path]) => !/\.png$/i.test(path))

/** A corner selection of the size a generator badge actually occupies. */
function corner(raster: Raster): Rect {
  const short = Math.min(raster.width, raster.height)
  const size = Math.max(16, Math.min(96, Math.round(short * 0.18)))
  return {
    x: Math.max(0, raster.width - size - Math.round(short * 0.02)),
    y: Math.max(0, raster.height - size - Math.round(short * 0.02)),
    width: size,
    height: size,
  }
}

/** Every pixel not in `rect`, compared byte for byte. */
function differsOutside(before: Raster, after: Raster, rect: Rect): number {
  let count = 0
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
        continue
      const index = at(before, x, y)
      for (let c = 0; c < 4; c += 1) {
        if (before.data[index + c] !== after.data[index + c]) count += 1
      }
    }
  }
  return count
}

describe('the real-file pipeline', () => {
  if (entries.length === 0) {
    it.skip('fixtures/real is empty — drop PNGs in there and this runs over them', () => {})
  }

  for (const [path] of unreadable) {
    it.skip(`${path} is not a PNG, and only PNG can be decoded under Node`, () => {})
  }

  for (const [path, url] of readable) {
    const name = path.replace('/fixtures/real/', '')

    it(
      `${name}: survives detection, unblending, inpainting and disruption unchanged outside its region`,
      { timeout: 180_000 },
      async () => {
        const raster = await decodePng(bytesFromDataUrl(url))
        expect(raster.width).toBeGreaterThan(0)
        expect(raster.height).toBeGreaterThan(0)
        expect(raster.data.length).toBe(raster.width * raster.height * 4)

        // The corner scan is offered to a user unprompted, so it has to survive
        // anything. Whether it finds something is not asserted: on most real
        // files it should find nothing, and demanding a hit would be demanding
        // false positives.
        expect(() => findCornerOverlays(raster)).not.toThrow()

        const rect = corner(raster)
        const estimate =
          estimateShaped(raster, rect) ??
          estimateOverlay(raster, rect) ??
          ({ rect, alpha: 0.3, color: [255, 255, 255], confidence: 0 } as const)

        const map = coverageMap(raster, rect, estimate.color)
        expect(map.data.length).toBe(map.rect.width * map.rect.height)
        for (const alpha of map.data) expect(alpha).toBeGreaterThanOrEqual(0)
        for (const alpha of map.data) expect(alpha).toBeLessThanOrEqual(1)

        const unblended = unblendVarying(raster, estimate, map)
        expect([unblended.width, unblended.height]).toEqual([raster.width, raster.height])
        expect(differsOutside(raster, unblended, map.rect)).toBe(0)

        const filled = inpaint(raster, rectMask(raster.width, raster.height, rect))
        expect([filled.width, filled.height]).toEqual([raster.width, raster.height])
        expect(differsOutside(raster, filled, rect)).toBe(0)

        // Disruption is whole-image by definition, so the invariant is size and
        // the fact that it actually changed something.
        const scrubbed = scrubLowBits(raster, 1)
        expect([scrubbed.width, scrubbed.height]).toEqual([raster.width, raster.height])

        const disrupted = disrupt(raster, { lowBits: 1, noiseAmplitude: 2, cropPixels: 2 })
        expect(disrupted.width).toBe(raster.width - 4)
        expect(disrupted.height).toBe(raster.height - 4)

        const noisy = addNoise(raster, 2, 1)
        expect([...noisy.data]).not.toEqual([...raster.data])
      },
    )
  }
})
