import { describe, expect, it } from 'vitest'
import { blend, estimateOverlay, unblend, type OverlayCandidate, type Rect } from './overlay.ts'
import { coverageMap, unblendVarying } from './coverage.ts'
import { disjoint, planRemoval, removeAll, removeOverlay } from './remove.ts'
import { at, createRaster, xorshift, type Raster } from '../raster.ts'

/** A textured picture, deterministic so an assertion means something. */
function noisyPicture(width: number, height: number, seed = 7): Raster {
  const raster = createRaster(width, height)
  const random = xorshift(seed)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(raster, x, y)
      raster.data[index] = 40 + (x / width) * 120 + random() * 60
      raster.data[index + 1] = 90 + (y / height) * 90 + random() * 60
      raster.data[index + 2] = 150 - (x / width) * 80 + random() * 60
      raster.data[index + 3] = 255
    }
  }
  return raster
}

const identical = (a: Raster, b: Raster) => {
  expect(a.width).toBe(b.width)
  expect(a.height).toBe(b.height)
  expect([...a.data]).toEqual([...b.data])
}

const worstDifference = (a: Raster, b: Raster) => {
  let worst = 0
  for (let index = 0; index < a.data.length; index += 1) {
    worst = Math.max(worst, Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0)))
  }
  return worst
}

const candidate = (
  raster: Raster,
  rect: Rect,
  overrides: Partial<OverlayCandidate> = {},
): OverlayCandidate => {
  const estimate = estimateOverlay(raster, rect)
  if (!estimate) throw new Error('the fixture did not produce an estimate')
  return { ...estimate, kind: 'flat', source: 'grid', ...overrides }
}

const LEFT: Rect = { x: 40, y: 40, width: 80, height: 80 }
const RIGHT: Rect = { x: 260, y: 260, width: 80, height: 80 }

describe('removeOverlay', () => {
  it('routes a confident flat estimate to the exact inverse', () => {
    // This is the behaviour that used to be four lines inside ImageTab. It must
    // not change on the way out, or every single-region removal changes with it.
    const marked = blend(noisyPicture(384, 384), LEFT, 0.4, [255, 255, 255])
    const found = candidate(marked, LEFT)
    expect(found.confidence).toBeGreaterThanOrEqual(0.7)

    identical(removeOverlay(marked, found), unblend(marked, found))
  })

  it('routes everything else through the coverage map', () => {
    const marked = blend(noisyPicture(384, 384), LEFT, 0.4, [255, 255, 255])
    // Confidence forced below the threshold: the router's decision is about the
    // number, and the fixture only has to supply a well-formed estimate.
    const found = candidate(marked, LEFT, { confidence: 0.5 })

    identical(
      removeOverlay(marked, found),
      unblendVarying(marked, found, coverageMap(marked, found.rect, found.color)),
    )
  })

  it('sends a shaped candidate through the map however sure it is', () => {
    // A shaped mark's alpha varies pixel to pixel by definition. One alpha over
    // the whole rectangle would over-correct the picture between the glyph's
    // strokes, which is most of the region.
    const marked = blend(noisyPicture(384, 384), LEFT, 0.4, [255, 255, 255])
    const found = candidate(marked, LEFT, { kind: 'shaped', confidence: 0.99 })

    expect(planRemoval(marked, found).coverage).toBeDefined()
  })

  it('leaves the picture it was given untouched', () => {
    const marked = blend(noisyPicture(384, 384), LEFT, 0.4, [255, 255, 255])
    const before = [...marked.data]
    removeOverlay(marked, candidate(marked, LEFT))
    expect([...marked.data]).toEqual(before)
  })
})

describe('removeAll', () => {
  const twoMarks = () => {
    const original = noisyPicture(384, 384)
    const one = blend(original, LEFT, 0.4, [255, 255, 255])
    return { original, marked: blend(one, RIGHT, 0.3, [20, 20, 20]) }
  }

  it('does nothing to a picture with nothing to remove', () => {
    const marked = twoMarks().marked
    identical(removeAll(marked, []), marked)
  })

  it('one candidate through the batch is one candidate through the router', () => {
    const { marked } = twoMarks()
    const found = candidate(marked, LEFT)
    identical(removeAll(marked, [found]), removeOverlay(marked, found))
  })

  it('is order-independent on a disjoint set', () => {
    // The property that makes collapsing N removals into one undo step honest.
    // It only holds because every estimate is measured against the picture as
    // it was found, before any of them were applied.
    const { marked } = twoMarks()
    const left = candidate(marked, LEFT)
    const right = candidate(marked, RIGHT)

    identical(removeAll(marked, [left, right]), removeAll(marked, [right, left]))
  })

  it('recovers both regions, not just the first', () => {
    const { original, marked } = twoMarks()
    const restored = removeAll(marked, [candidate(marked, LEFT), candidate(marked, RIGHT)])

    for (const rect of [LEFT, RIGHT]) {
      const inside = { ...rect, x: rect.x + 8, y: rect.y + 8, width: 64, height: 64 }
      let worst = 0
      for (let y = inside.y; y < inside.y + inside.height; y += 1) {
        for (let x = inside.x; x < inside.x + inside.width; x += 1) {
          const index = at(restored, x, y)
          for (let c = 0; c < 3; c += 1) {
            worst = Math.max(
              worst,
              Math.abs((restored.data[index + c] ?? 0) - (original.data[index + c] ?? 0)),
            )
          }
        }
      }
      expect(worst).toBeLessThan(12)
    }
  })

  it('measures every region against the picture as it was found', () => {
    // Two marks close enough that the second one's control ring covers the
    // first. Removing A and then re-estimating B measures B's surroundings
    // against pixels that are now part recovered-original and part still
    // composite — a mixture `observed = aC + (1-a)I` does not describe. The
    // batch does not do that, and this pins the difference.
    const near: Rect = { x: 150, y: 40, width: 80, height: 80 }
    const original = noisyPicture(384, 384)
    const marked = blend(blend(original, LEFT, 0.4, [255, 255, 255]), near, 0.4, [255, 255, 255])

    const upFront = removeAll(marked, [candidate(marked, LEFT), candidate(marked, near)])

    const afterFirst = removeOverlay(marked, candidate(marked, LEFT))
    const sequential = removeOverlay(afterFirst, candidate(afterFirst, near))

    expect(worstDifference(upFront, sequential)).toBeGreaterThan(0)
  })

  it('reports progress that rises to one', () => {
    const { marked } = twoMarks()
    const seen: number[] = []
    removeAll(marked, [candidate(marked, LEFT), candidate(marked, RIGHT)], {
      onProgress: (fraction) => seen.push(fraction),
    })

    expect(seen.length).toBe(2)
    expect(seen.at(-1)).toBe(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  it('leaves the picture it was given untouched', () => {
    const { marked } = twoMarks()
    const before = [...marked.data]
    removeAll(marked, [candidate(marked, LEFT), candidate(marked, RIGHT)])
    expect([...marked.data]).toEqual(before)
  })
})

describe('disjoint', () => {
  const fake = (rect: Rect, confidence: number, alpha = 0.5): OverlayCandidate => ({
    rect,
    alpha,
    color: [255, 255, 255],
    confidence,
    kind: 'flat',
    source: 'grid',
  })

  it('keeps regions that share no pixel', () => {
    expect(disjoint([fake(LEFT, 0.9), fake(RIGHT, 0.8)])).toHaveLength(2)
  })

  it('drops the weaker of an overlapping pair', () => {
    // Inverting a pixel twice gives `(I - aC)/(1 - a)`, off by
    // `a(I - C)/(1 - a)` — a hundred levels at alpha 0.4 under a white mark,
    // which is worse than leaving the overlay alone.
    const strong = fake({ x: 40, y: 40, width: 80, height: 80 }, 0.95)
    const weak = fake({ x: 90, y: 90, width: 80, height: 80 }, 0.6)

    expect(disjoint([weak, strong])).toEqual([strong])
  })

  it('drops it whole rather than trimming it', () => {
    // Half a rectangle is not a region anything measured, and its alpha and
    // colour describe the region that was measured, not the part left over.
    const strong = fake({ x: 40, y: 40, width: 80, height: 80 }, 0.95)
    const weak = fake({ x: 110, y: 40, width: 80, height: 80 }, 0.6)

    const kept = disjoint([strong, weak])
    expect(kept).toHaveLength(1)
    expect(kept[0]?.rect).toEqual(strong.rect)
  })

  it('ranks by confidence and alpha together', () => {
    // A very sure reading of an almost-invisible tint is not a better thing to
    // remove than a fairly sure reading of a solid one.
    const faint = fake({ x: 40, y: 40, width: 80, height: 80 }, 0.99, 0.05)
    const solid = fake({ x: 60, y: 60, width: 80, height: 80 }, 0.8, 0.6)

    expect(disjoint([faint, solid])).toEqual([solid])
  })

  it('touching edges do not overlap', () => {
    const left = fake({ x: 0, y: 0, width: 40, height: 40 }, 0.9)
    const right = fake({ x: 40, y: 0, width: 40, height: 40 }, 0.8)
    expect(disjoint([left, right])).toHaveLength(2)
  })
})
