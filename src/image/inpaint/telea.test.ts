import { describe, expect, it } from 'vitest'
import { inpaint, rectMask, rectsMask } from './telea.ts'
import { at, createRaster, xorshift, type Raster } from '../raster.ts'

/** A smooth ramp: an inpainter that works should reconstruct this almost exactly. */
function ramp(width: number, height: number): Raster {
  const raster = createRaster(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(raster, x, y)
      raster.data[index] = (x / width) * 255
      raster.data[index + 1] = (y / height) * 255
      raster.data[index + 2] = 128
      raster.data[index + 3] = 255
    }
  }
  return raster
}

function noisy(width: number, height: number, seed = 3): Raster {
  const raster = ramp(width, height)
  const random = xorshift(seed)
  for (let i = 0; i < raster.data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      raster.data[i + c] = (raster.data[i + c] ?? 0) + (random() * 2 - 1) * 12
    }
  }
  return raster
}

const HOLE = { x: 28, y: 28, width: 12, height: 12 }

function worstInside(a: Raster, b: Raster, rect: typeof HOLE): number {
  let worst = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(a, x, y)
      for (let c = 0; c < 3; c += 1) {
        worst = Math.max(worst, Math.abs((a.data[index + c] ?? 0) - (b.data[index + c] ?? 0)))
      }
    }
  }
  return worst
}

/** Mean absolute error inside a region. The worst pixel is too noisy to compare on. */
function meanInside(a: Raster, b: Raster, rect: typeof HOLE): number {
  let sum = 0
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(a, x, y)
      for (let c = 0; c < 3; c += 1) {
        sum += Math.abs((a.data[index + c] ?? 0) - (b.data[index + c] ?? 0))
        count += 1
      }
    }
  }
  return sum / count
}

/** Paint the hole a flat colour, the way a watermark would. */
function punch(raster: Raster, rect: typeof HOLE): Raster {
  const out = { ...raster, data: new Uint8ClampedArray(raster.data) }
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(out, x, y)
      out.data[index] = 255
      out.data[index + 1] = 255
      out.data[index + 2] = 255
    }
  }
  return out
}

describe('inpaint', () => {
  it('reconstructs a smooth ramp close to the original', () => {
    // The strongest claim a classic inpainter can make: where the picture is
    // predictable from its edges, the fill is nearly the real thing.
    const original = ramp(64, 64)
    const damaged = punch(original, HOLE)
    const filled = inpaint(damaged, rectMask(64, 64, HOLE))

    expect(worstInside(original, damaged, HOLE)).toBeGreaterThan(80)
    expect(worstInside(original, filled, HOLE)).toBeLessThan(24)
  })

  it('improves on the damaged image rather than merely changing it', () => {
    const original = noisy(64, 64)
    const damaged = punch(original, HOLE)
    const filled = inpaint(damaged, rectMask(64, 64, HOLE))
    expect(worstInside(original, filled, HOLE)).toBeLessThan(worstInside(original, damaged, HOLE))
  })

  it('leaves every pixel outside the mask untouched', () => {
    // An inpainter that adjusts the rest of the picture has done something
    // other than what it was asked.
    const damaged = punch(ramp(64, 64), HOLE)
    const filled = inpaint(damaged, rectMask(64, 64, HOLE))

    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const insideHole =
          x >= HOLE.x && x < HOLE.x + HOLE.width && y >= HOLE.y && y < HOLE.y + HOLE.height
        if (insideHole) continue
        const index = at(damaged, x, y)
        expect(filled.data[index]).toBe(damaged.data[index])
      }
    }
  })

  it('leaves the alpha channel alone', () => {
    // Inpainting reconstructs colour, not coverage.
    const damaged = punch(ramp(32, 32), { x: 10, y: 10, width: 8, height: 8 })
    damaged.data[at(damaged, 12, 12) + 3] = 77
    const filled = inpaint(damaged, rectMask(32, 32, { x: 10, y: 10, width: 8, height: 8 }))
    expect(filled.data[at(filled, 12, 12) + 3]).toBe(77)
  })

  it('does nothing for an empty mask', () => {
    const before = ramp(32, 32)
    expect([...inpaint(before, new Uint8Array(32 * 32)).data]).toEqual([...before.data])
  })

  it('does nothing when the mask covers everything', () => {
    // There is no known pixel to fill from. Returning the input unchanged is
    // the only honest answer.
    const before = ramp(32, 32)
    const all = new Uint8Array(32 * 32).fill(1)
    expect([...inpaint(before, all).data]).toEqual([...before.data])
  })

  it('handles a mask that touches the edge of the image', () => {
    const original = ramp(48, 48)
    const edge = { x: 0, y: 0, width: 10, height: 10 }
    const damaged = punch(original, edge)
    expect(() => inpaint(damaged, rectMask(48, 48, edge))).not.toThrow()
  })

  it('fills every masked pixel', () => {
    // A hole left half-filled is worse than one left alone: it looks fixed.
    const damaged = punch(ramp(64, 64), HOLE)
    const filled = inpaint(damaged, rectMask(64, 64, HOLE))

    let unchanged = 0
    for (let y = HOLE.y; y < HOLE.y + HOLE.height; y += 1) {
      for (let x = HOLE.x; x < HOLE.x + HOLE.width; x += 1) {
        const index = at(filled, x, y)
        if (filled.data[index] === 255 && filled.data[index + 1] === 255) unchanged += 1
      }
    }
    expect(unchanged).toBeLessThan(4)
  })
})

describe('rectMask', () => {
  it('marks exactly the rectangle', () => {
    const mask = rectMask(10, 10, { x: 2, y: 3, width: 4, height: 2 })
    expect(mask.reduce((sum, v) => sum + v, 0)).toBe(8)
    expect(mask[3 * 10 + 2]).toBe(1)
    expect(mask[3 * 10 + 1]).toBe(0)
  })

  it('clips a rectangle that runs off the edge', () => {
    const mask = rectMask(10, 10, { x: 8, y: 8, width: 5, height: 5 })
    expect(mask.reduce((sum, v) => sum + v, 0)).toBe(4)
  })

  it('is rectsMask with one rectangle', () => {
    // The compatibility claim, byte for byte. rectMask is now a wrapper, and a
    // wrapper that quietly behaves differently is worse than two functions.
    const rect = { x: 2, y: 3, width: 4, height: 2 }
    expect([...rectMask(10, 10, rect)]).toEqual([...rectsMask(10, 10, [rect])])
  })
})

describe('rectsMask', () => {
  it('marks the union of several rectangles', () => {
    const mask = rectsMask(10, 10, [
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 6, y: 6, width: 3, height: 3 },
    ])
    expect(mask.reduce((sum, v) => sum + v, 0)).toBe(4 + 9)
  })

  it('marks an overlap once', () => {
    // The mask is a set, and inpaint counts the hole by scanning it. Two
    // rectangles sharing pixels are one hole, not a hole and a half.
    const mask = rectsMask(10, 10, [
      { x: 0, y: 0, width: 4, height: 4 },
      { x: 2, y: 2, width: 4, height: 4 },
    ])
    expect(mask.reduce((sum, v) => sum + v, 0)).toBe(16 + 16 - 4)
  })

  it('marks nothing for an empty list', () => {
    expect(rectsMask(10, 10, []).reduce((sum, v) => sum + v, 0)).toBe(0)
  })

  it('clips every rectangle independently', () => {
    const mask = rectsMask(10, 10, [
      { x: -3, y: -3, width: 5, height: 5 },
      { x: 8, y: 8, width: 5, height: 5 },
    ])
    expect(mask.reduce((sum, v) => sum + v, 0)).toBe(4 + 4)
  })

  it('one pass over the union beats one pass per rectangle', () => {
    // Telea reads any pixel the mask does not cover as known picture. Filling A
    // while B is still marked therefore continues the *watermark's* edge into
    // A — the flat white of the mark is exactly the wrong thing to extend a
    // gradient from.
    //
    // Measured on two 16x16 holes four pixels apart in a noisy ramp: the union
    // pass leaves 7.4 levels of mean error against the original and the
    // sequential pair leaves 11.8, worst case 26 against 50. This is why batch
    // inpainting builds one mask instead of calling inpaint in a loop.
    const near = [
      { x: 20, y: 20, width: 16, height: 16 },
      { x: 40, y: 20, width: 16, height: 16 },
    ]
    const original = noisy(80, 80)
    const damaged = near.reduce((picture, rect) => punch(picture, rect), original)

    const union = inpaint(damaged, rectsMask(80, 80, near))
    const sequential = near.reduce(
      (picture, rect) => inpaint(picture, rectMask(80, 80, rect)),
      damaged,
    )

    const unionError = Math.max(...near.map((rect) => meanInside(union, original, rect)))
    const sequentialError = Math.max(...near.map((rect) => meanInside(sequential, original, rect)))
    expect(unionError).toBeLessThan(sequentialError * 0.8)
  })

  it('agrees with the sequential result when the regions are far apart', () => {
    // The control, and the test above is worth nothing without it: the union
    // path could simply be better at everything, in which case the numbers
    // there would say nothing about interference.
    //
    // Forty pixels apart the two agree to within a tenth of a level of mean
    // error — 7.31 against 7.24. The remaining pixel-level difference is the
    // marching order of Telea's front, which one mask with two components does
    // not walk in the same sequence as two masks with one each.
    const far = [
      { x: 8, y: 8, width: 12, height: 12 },
      { x: 60, y: 60, width: 12, height: 12 },
    ]
    const original = noisy(80, 80)
    const damaged = far.reduce((picture, rect) => punch(picture, rect), original)

    const union = inpaint(damaged, rectsMask(80, 80, far))
    const sequential = far.reduce(
      (picture, rect) => inpaint(picture, rectMask(80, 80, rect)),
      damaged,
    )

    for (const rect of far) {
      const difference = Math.abs(
        meanInside(union, original, rect) - meanInside(sequential, original, rect),
      )
      expect(difference).toBeLessThan(0.5)
    }
  })
})

describe('inpaint progress and abort', () => {
  // A megapixel selection takes seconds, and the UI used to run it inside the
  // same React batch that set the busy flag — so the indicator never rendered
  // and the tab simply froze. Both halves of the fix live here: something to
  // report, and something to stop.
  const BIG = { x: 40, y: 40, width: 120, height: 120 }
  const bigHole = () => punch(ramp(200, 200), BIG)

  it('reports progress that rises to one', () => {
    const seen: number[] = []
    inpaint(bigHole(), rectMask(200, 200, BIG), { onProgress: (f) => seen.push(f) })

    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(1)
    // Monotonic, because a bar that goes backwards is worse than no bar.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual(seen[i - 1] ?? 0)
    }
  })

  it('stops when asked, leaving the rest of the hole as it was', () => {
    const damaged = bigHole()
    const stopped = inpaint(damaged, rectMask(200, 200, BIG), { shouldStop: () => true })

    // The check is polled, not tested per pixel, so a few thousand pixels are
    // filled before the first poll. The point is that it did not finish.
    let untouched = 0
    for (let y = BIG.y; y < BIG.y + BIG.height; y += 1) {
      for (let x = BIG.x; x < BIG.x + BIG.width; x += 1) {
        const index = at(stopped, x, y)
        if (stopped.data[index] === 255 && stopped.data[index + 1] === 255) untouched += 1
      }
    }
    expect(untouched).toBeGreaterThan(BIG.width * BIG.height * 0.5)
  })

  it('is unchanged when no options are passed at all', () => {
    // The existing callers pass two arguments and must keep getting exactly
    // what they got before.
    const damaged = bigHole()
    const mask = rectMask(200, 200, BIG)
    expect([...inpaint(damaged, mask).data]).toEqual([
      ...inpaint(damaged, mask, { onProgress: () => {}, shouldStop: () => false }).data,
    ])
  })
})
