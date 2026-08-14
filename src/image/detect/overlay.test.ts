import { describe, expect, it } from 'vitest'
import {
  blend,
  estimateOverlay,
  findCornerOverlays,
  refineRect,
  unblend,
  type Rect,
} from './overlay.ts'
import { at, createRaster, xorshift, type Raster } from '../raster.ts'

/** A textured picture, deterministic so an assertion means something. */
function noisyPicture(width: number, height: number, seed = 7): Raster {
  const raster = createRaster(width, height)
  const random = xorshift(seed)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(raster, x, y)
      // A gradient plus noise: real variance in every channel, which is what
      // the estimator needs to have anything to measure.
      raster.data[index] = 40 + (x / width) * 120 + random() * 60
      raster.data[index + 1] = 90 + (y / height) * 90 + random() * 60
      raster.data[index + 2] = 150 - (x / width) * 80 + random() * 60
      raster.data[index + 3] = 255
    }
  }
  return raster
}

/** A flat picture: no variance anywhere, so nothing can be estimated from it. */
function flatPicture(width: number, height: number): Raster {
  const raster = createRaster(width, height)
  raster.data.fill(128)
  for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255
  return raster
}

const BADGE: Rect = { x: 150, y: 150, width: 60, height: 60 }

const maxDifference = (a: Raster, b: Raster, rect: Rect) => {
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

describe('estimateOverlay', () => {
  it('recovers the alpha and colour of a known blend', () => {
    const original = noisyPicture(256, 256)
    const marked = blend(original, BADGE, 0.4, [255, 255, 255])

    const estimate = estimateOverlay(marked, BADGE)
    expect(estimate).toBeDefined()
    expect(estimate?.alpha).toBeCloseTo(0.4, 1)
    expect(estimate?.color[0]).toBeGreaterThan(200)
    expect(estimate?.confidence).toBeGreaterThan(0.6)
  })

  it('recovers a dark overlay as readily as a light one', () => {
    const original = noisyPicture(256, 256, 11)
    const marked = blend(original, BADGE, 0.35, [10, 10, 10])
    const estimate = estimateOverlay(marked, BADGE)
    expect(estimate?.alpha).toBeCloseTo(0.35, 1)
    expect(estimate?.color[0]).toBeLessThan(60)
  })

  it('finds nothing where there is no overlay', () => {
    // The most important negative: an unmarked picture must not produce a
    // confident estimate, or the tool invents watermarks.
    const estimate = estimateOverlay(noisyPicture(256, 256), BADGE)
    expect(estimate === undefined || estimate.alpha < 0.12).toBe(true)
  })

  it('refuses to guess on a flat background', () => {
    // Zero variance outside means the variance ratio is 0/0. There is no
    // information here, and returning a number anyway would be fabrication.
    expect(estimateOverlay(flatPicture(256, 256), BADGE)).toBeUndefined()
  })

  it('refuses a region too small to measure', () => {
    const marked = blend(noisyPicture(256, 256), BADGE, 0.4, [255, 255, 255])
    expect(estimateOverlay(marked, { x: 150, y: 150, width: 4, height: 4 })).toBeUndefined()
  })
})

describe('unblend', () => {
  it('restores the original pixels almost exactly', () => {
    // The whole argument for unblending over inpainting: the pixels are still
    // there, contracted toward the overlay colour. Nothing is invented.
    const original = noisyPicture(256, 256)
    const marked = blend(original, BADGE, 0.4, [255, 255, 255])
    const restored = unblend(marked, {
      rect: BADGE,
      alpha: 0.4,
      color: [255, 255, 255],
      confidence: 1,
    })

    // Within rounding: the blend quantised to 8 bits on the way in.
    expect(maxDifference(original, restored, BADGE)).toBeLessThanOrEqual(3)
  })

  it('is a real inverse, not an approximation that drifts', () => {
    const original = noisyPicture(128, 128, 3)
    const rect: Rect = { x: 20, y: 20, width: 40, height: 40 }
    let image = original

    for (let round = 0; round < 3; round += 1) {
      image = blend(image, rect, 0.3, [200, 60, 60])
      image = unblend(image, { rect, alpha: 0.3, color: [200, 60, 60], confidence: 1 })
    }
    expect(maxDifference(original, image, rect)).toBeLessThanOrEqual(6)
  })

  it('leaves everything outside the region untouched', () => {
    const marked = blend(
      noisyPicture(128, 128),
      { x: 10, y: 10, width: 30, height: 30 },
      0.5,
      [255, 0, 0],
    )
    const restored = unblend(marked, {
      rect: { x: 10, y: 10, width: 30, height: 30 },
      alpha: 0.5,
      color: [255, 0, 0],
      confidence: 1,
    })
    expect(maxDifference(marked, restored, { x: 60, y: 60, width: 40, height: 40 })).toBe(0)
  })

  it('does nothing for a fully opaque overlay', () => {
    // At alpha 1 the original is gone: there is nothing to divide by and
    // nothing to recover. Inpainting is the only option, and this says so by
    // declining rather than dividing by zero.
    const marked = blend(noisyPicture(128, 128), BADGE, 1, [255, 255, 255])
    const out = unblend(marked, { rect: BADGE, alpha: 1, color: [255, 255, 255], confidence: 1 })
    expect(maxDifference(marked, out, { x: 0, y: 0, width: 128, height: 128 })).toBe(0)
  })
})

describe('findCornerOverlays', () => {
  it('finds a badge composited into a corner', () => {
    const badge: Rect = { x: 330, y: 330, width: 55, height: 55 }
    const marked = blend(noisyPicture(400, 400), badge, 0.45, [255, 255, 255])

    const bottomRight = findCornerOverlays(marked).find((e) => e.rect.x > 200 && e.rect.y > 200)
    expect(bottomRight).toBeDefined()

    // The scan proposes a region, it does not measure one. Its candidate sizes
    // are fixed fractions of the image, so a candidate only ever partly covers
    // the badge and its alpha is correspondingly diluted — 0.45 reads as ~0.2.
    // That is why the scan reports rather than acts.
    expect(bottomRight?.alpha).toBeGreaterThan(0.1)

    // The contract that matters: re-estimating on the confirmed region recovers
    // the real alpha, which is what the UI does once the selection is settled.
    expect(estimateOverlay(marked, badge)?.alpha).toBeCloseTo(0.45, 1)
  })

  it('reports at most one candidate per corner', () => {
    const marked = blend(
      noisyPicture(400, 400),
      { x: 330, y: 330, width: 55, height: 55 },
      0.45,
      [255, 255, 255],
    )
    // Four candidate sizes are tried per corner; four findings for one badge
    // would be a report the user has to de-duplicate by eye.
    expect(findCornerOverlays(marked).length).toBeLessThanOrEqual(4)
  })

  it('finds nothing in an unmarked picture', () => {
    expect(findCornerOverlays(noisyPicture(400, 400, 21))).toEqual([])
  })

  it('finds nothing in a flat picture', () => {
    expect(findCornerOverlays(flatPicture(400, 400))).toEqual([])
  })
})

describe('refineRect', () => {
  it('snaps a misaligned proposal onto the real edges', () => {
    // The defect this exists for: a proposal that overlaps the badge without
    // matching it. Unblending that leaves one strip still tinted and
    // over-corrects another — visibly worse than leaving the badge alone.
    const badge: Rect = { x: 250, y: 250, width: 55, height: 55 }
    const marked = blend(noisyPicture(320, 320), badge, 0.45, [255, 255, 255])

    const snapped = refineRect(marked, { x: 256, y: 256, width: 58, height: 58 })

    expect(Math.abs(snapped.x - badge.x)).toBeLessThanOrEqual(3)
    expect(Math.abs(snapped.y - badge.y)).toBeLessThanOrEqual(3)
    expect(Math.abs(snapped.width - badge.width)).toBeLessThanOrEqual(6)
    expect(Math.abs(snapped.height - badge.height)).toBeLessThanOrEqual(6)
  })

  it('makes the alpha estimate land on the real value', () => {
    // The measurable consequence: the alpha of a snapped region is the alpha of
    // the overlay, not a figure diluted by whatever else the proposal covered.
    const badge: Rect = { x: 250, y: 250, width: 55, height: 55 }
    const marked = blend(noisyPicture(320, 320), badge, 0.45, [255, 255, 255])

    const proposal: Rect = { x: 256, y: 256, width: 58, height: 58 }
    expect(estimateOverlay(marked, proposal)?.alpha ?? 0).toBeLessThan(0.35)
    expect(estimateOverlay(marked, refineRect(marked, proposal))?.alpha ?? 0).toBeGreaterThan(0.35)
  })

  it('leaves a proposal alone when there is no edge to find', () => {
    const rect: Rect = { x: 100, y: 100, width: 50, height: 50 }
    expect(refineRect(noisyPicture(320, 320), rect)).toEqual(rect)
  })

  it('recovers the picture once the region is snapped', () => {
    const original = noisyPicture(320, 320)
    const badge: Rect = { x: 250, y: 250, width: 55, height: 55 }
    const marked = blend(original, badge, 0.45, [255, 255, 255])

    const [candidate] = findCornerOverlays(marked)
    expect(candidate).toBeDefined()
    if (!candidate) return

    const restored = unblend(marked, candidate)
    // Not pixel-perfect — the snap is within a few pixels and the alpha is
    // estimated — but the badge must be substantially gone.
    expect(maxDifference(original, restored, badge)).toBeLessThan(
      maxDifference(original, marked, badge) / 2,
    )
  })
})
