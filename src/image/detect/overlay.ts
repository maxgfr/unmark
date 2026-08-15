// Flat semi-transparent overlays, undone exactly rather than painted over.
//
// A generator badge, a scrim behind a caption, a tint bar — anything composited
// as `observed = a*C + (1-a)*original` for one constant colour C and one alpha
// — is not a hole in the picture. It is an invertible affine transform of it,
// and the original pixels are still there, contracted toward C. Inpainting such
// a region throws away real data and replaces it with a guess; unblending
// recovers it.
//
// The catch is that a and C are unknown. They are estimated from how much the
// blend flattens local detail. Since the transform is affine, the difference
// between any two neighbouring pixels is scaled by exactly (1-a):
//
//   I'(x+1) - I'(x) = (1-a) * (I(x+1) - I(x))
//
// so the mean squared neighbour difference — call it the detail energy — scales
// by (1-a)^2, and:
//
//   a = 1 - sqrt(detail_inside / detail_outside)
//   C = (mean_inside - (1-a)*mean_outside) / a
//
// The first draft used plain variance instead of neighbour differences and was
// wrong on every real photograph. Variance over a region includes the image's
// low-frequency content, which grows with the region's spatial extent — so a
// small interior compared against a larger surrounding ring looks flatter than
// it is, and an unmarked gradient reads as a 25% overlay. Neighbour differences
// are blind to gradients and to region size, which is the property this needs.
//
// It still assumes the picture under the overlay is about as detailed as its
// surroundings. When it is not, the estimate is wrong — so it ships with a
// confidence, and the UI lets the numbers be corrected by hand.

import { at, clamp, cloneRaster, type Raster } from '../raster.ts'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayEstimate {
  rect: Rect
  /** 0–1 opacity of the overlay. */
  alpha: number
  /** The overlay colour, as [r, g, b]. */
  color: [number, number, number]
  /** 0–1. How well the region behaves like a flat blend of its surroundings. */
  confidence: number
}

interface Stats {
  mean: [number, number, number]
  /** Mean squared difference between neighbouring pixels, per channel. */
  detail: [number, number, number]
  count: number
}

/**
 * Mean and detail energy over the pixels a predicate accepts.
 *
 * A neighbour difference is only counted when both pixels pass the predicate,
 * so a difference straddling the overlay's edge — which is a step, not detail —
 * never lands in either sample.
 */
function statsOf(raster: Raster, inside: (x: number, y: number) => boolean, rect: Rect): Stats {
  const sum: [number, number, number] = [0, 0, 0]
  const detailSum: [number, number, number] = [0, 0, 0]
  let count = 0
  let pairs = 0

  const x0 = Math.max(0, rect.x)
  const y0 = Math.max(0, rect.y)
  const x1 = Math.min(raster.width, rect.x + rect.width)
  const y1 = Math.min(raster.height, rect.y + rect.height)

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!inside(x, y)) continue
      const index = at(raster, x, y)
      for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + (raster.data[index + c] ?? 0)
      count += 1

      const right = x + 1 < x1 && inside(x + 1, y)
      const down = y + 1 < y1 && inside(x, y + 1)
      if (!right && !down) continue

      const rightIndex = at(raster, x + 1, y)
      const downIndex = at(raster, x, y + 1)
      for (let c = 0; c < 3; c += 1) {
        const value = raster.data[index + c] ?? 0
        let energy = 0
        if (right) energy += ((raster.data[rightIndex + c] ?? 0) - value) ** 2
        if (down) energy += ((raster.data[downIndex + c] ?? 0) - value) ** 2
        detailSum[c] = (detailSum[c] ?? 0) + energy
      }
      pairs += (right ? 1 : 0) + (down ? 1 : 0)
    }
  }

  if (count === 0 || pairs === 0) {
    return { mean: [0, 0, 0], detail: [0, 0, 0], count: 0 }
  }

  const mean: [number, number, number] = [0, 0, 0]
  const detail: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c += 1) {
    mean[c] = (sum[c] ?? 0) / count
    detail[c] = (detailSum[c] ?? 0) / pairs
  }
  return { mean, detail, count }
}

const inRect = (rect: Rect) => (x: number, y: number) =>
  x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height

/** The ring of picture immediately around a rectangle, used as the control sample. */
function ringAround(rect: Rect): { bounds: Rect; test: (x: number, y: number) => boolean } {
  const pad = Math.max(4, Math.round(Math.min(rect.width, rect.height) * 0.6))
  const bounds: Rect = {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
  const insideRect = inRect(rect)
  return { bounds, test: (x, y) => !insideRect(x, y) }
}

/**
 * Estimate the alpha and colour of a flat overlay over `rect`.
 *
 * Returns undefined when the region does not behave like a blend at all — less
 * textured than its surroundings by chance, or more textured, or too small to
 * measure.
 */
export function estimateOverlay(raster: Raster, rect: Rect): OverlayEstimate | undefined {
  const inside = statsOf(raster, inRect(rect), rect)
  const ring = ringAround(rect)
  const outside = statsOf(raster, ring.test, ring.bounds)

  if (inside.count < 64 || outside.count < 64) return undefined

  // A flat region on a flat background carries no information about alpha: the
  // ratio is 0/0. Refuse rather than return a fabricated number.
  const outsideEnergy = outside.detail.reduce((a, b) => a + b, 0)
  if (outsideEnergy < 12) return undefined

  const alphas: number[] = []
  for (let c = 0; c < 3; c += 1) {
    const detailIn = inside.detail[c] ?? 0
    const detailOut = outside.detail[c] ?? 0
    if (detailOut <= 1) continue
    alphas.push(clamp(1 - Math.sqrt(detailIn / detailOut), 0, 1))
  }
  if (alphas.length === 0) return undefined

  const alpha = alphas.reduce((a, b) => a + b, 0) / alphas.length

  // Below this the "overlay" is indistinguishable from the picture being
  // slightly smoother there, which it very often just is.
  if (alpha < 0.08) return undefined

  const color = [0, 1, 2].map((c) => {
    const meanIn = inside.mean[c] ?? 0
    const meanOut = outside.mean[c] ?? 0
    return clamp((meanIn - (1 - alpha) * meanOut) / alpha, 0, 255)
  }) as [number, number, number]

  // Agreement between the per-channel alphas is the honest confidence signal: a
  // real single-alpha composite gives three channels the same answer.
  const spread = Math.max(...alphas) - Math.min(...alphas)
  const confidence = clamp(1 - spread * 3, 0, 1)

  return { rect, alpha, color, confidence }
}

/**
 * Invert the blend over a region.
 *
 * `original = (observed - a*C) / (1 - a)`. Exact where the assumption holds,
 * which is why this is preferred over inpainting whenever it applies: nothing
 * is invented, the pixels come back.
 */
export function unblend(raster: Raster, estimate: OverlayEstimate): Raster {
  const out = cloneRaster(raster)
  const { rect, alpha, color } = estimate
  if (alpha >= 1) return out

  const x1 = Math.min(raster.width, rect.x + rect.width)
  const y1 = Math.min(raster.height, rect.y + rect.height)

  for (let y = Math.max(0, rect.y); y < y1; y += 1) {
    for (let x = Math.max(0, rect.x); x < x1; x += 1) {
      const index = at(out, x, y)
      for (let c = 0; c < 3; c += 1) {
        const observed = out.data[index + c] ?? 0
        out.data[index + c] = clamp((observed - alpha * (color[c] ?? 0)) / (1 - alpha), 0, 255)
      }
    }
  }
  return out
}

/**
 * Mean detail energy along one line, measured across the line rather than along
 * it.
 *
 * A column is sampled using its *vertical* differences, so the horizontal step
 * at the overlay's left or right edge — the very thing being located — never
 * contaminates the measurement of whether that column is inside.
 */
function lineDetail(
  raster: Raster,
  fixed: number,
  from: number,
  to: number,
  vertical: boolean,
): number {
  let total = 0
  let pairs = 0

  for (let n = from; n < to; n += 1) {
    const [x, y] = vertical ? [fixed, n] : [n, fixed]
    const [x2, y2] = vertical ? [fixed, n + 1] : [n + 1, fixed]
    if (x2 >= raster.width || y2 >= raster.height) break

    const a = at(raster, x, y)
    const b = at(raster, x2, y2)
    for (let c = 0; c < 3; c += 1) {
      total += ((raster.data[b + c] ?? 0) - (raster.data[a + c] ?? 0)) ** 2
    }
    pairs += 1
  }
  return pairs === 0 ? 0 : total / pairs
}

/**
 * Snap a proposed rectangle onto the overlay's actual edges.
 *
 * Without this the corner scan is worse than useless. Its candidate sizes are
 * fixed fractions of the image, so a proposed rectangle overlaps the real badge
 * without matching it — and unblending *that* leaves one strip still tinted and
 * over-corrects another, which looks worse than leaving the badge alone. The
 * region has to be found, not guessed at.
 *
 * Each edge is walked outward from the centre until the line's detail energy
 * climbs back toward the surrounding level, which is where the overlay stops.
 */
export function refineRect(raster: Raster, rect: Rect): Rect {
  const cx = Math.round(rect.x + rect.width / 2)
  const cy = Math.round(rect.y + rect.height / 2)
  if (cx < 1 || cy < 1 || cx >= raster.width - 1 || cy >= raster.height - 1) return rect

  const inside = statsOf(raster, inRect(rect), rect)
  const ring = ringAround(rect)
  const outside = statsOf(raster, ring.test, ring.bounds)

  const insideLevel = inside.detail.reduce((a, b) => a + b, 0)
  const outsideLevel = outside.detail.reduce((a, b) => a + b, 0)
  // No contrast between the two means there is no edge to find.
  if (outsideLevel <= 0 || insideLevel >= outsideLevel * 0.9) return rect

  // The geometric midpoint: a threshold in the log domain, which is the right
  // scale for a quantity that scales multiplicatively with (1-alpha)^2.
  const threshold = Math.sqrt(Math.max(insideLevel, 1) * outsideLevel)
  const span = Math.round(Math.max(rect.width, rect.height) * 1.6)

  const walk = (step: number, vertical: boolean): number => {
    const start = vertical ? cx : cy
    let edge = start

    for (let n = 1; n <= span; n += 1) {
      const line = start + step * n
      if (line < 1 || line >= (vertical ? raster.width : raster.height) - 1) break

      // Sample the line across a window centred on the region, not its whole
      // length: the far end of a long line has already left the overlay.
      const half = Math.round((vertical ? rect.height : rect.width) / 3)
      const centre = vertical ? cy : cx
      const detail = lineDetail(
        raster,
        line,
        Math.max(0, centre - half),
        Math.min(vertical ? raster.height : raster.width, centre + half),
        vertical,
      )
      if (detail > threshold) break
      edge = line
    }
    return edge
  }

  const left = walk(-1, true)
  const right = walk(1, true)
  const top = walk(-1, false)
  const bottom = walk(1, false)

  const width = right - left + 1
  const height = bottom - top + 1
  if (width < 8 || height < 8) return rect

  return { x: left, y: top, width, height }
}

// Generator badges live in corners, at a size proportional to the image. This
// is a bounded search over where they actually are, not a full-image scan.
const CORNER_FRACTIONS = [0.08, 0.12, 0.18, 0.25]

/**
 * Look for a flat overlay in each corner.
 *
 * Deliberately narrow, and it reports rather than acts: a corner it flags is
 * offered as a selection the user confirms, because a corner of sky is exactly
 * the false positive this heuristic produces.
 */
/**
 * The rectangles the corner scan probes.
 *
 * Exported so the shaped estimator can search exactly the same places. It has
 * to: the flat model returns `undefined` for every shaped badge, so a scan
 * built only on it proposes nothing for the one thing it exists to find.
 */
export function cornerCandidates(raster: Raster): Rect[] {
  const short = Math.min(raster.width, raster.height)
  const rects: Rect[] = []

  for (const fraction of CORNER_FRACTIONS) {
    const size = Math.round(short * fraction)
    if (size < 12) continue
    const inset = Math.round(short * 0.02)

    rects.push(
      { x: inset, y: inset, width: size, height: size },
      { x: raster.width - size - inset, y: inset, width: size, height: size },
      { x: inset, y: raster.height - size - inset, width: size, height: size },
      {
        x: raster.width - size - inset,
        y: raster.height - size - inset,
        width: size,
        height: size,
      },
    )
  }

  return rects
}

/** Which corner a rectangle sits in, so four sizes of one badge stay one candidate. */
export const cornerKey = (raster: Raster, rect: Rect): string =>
  `${rect.x < raster.width / 2 ? 'l' : 'r'}${rect.y < raster.height / 2 ? 't' : 'b'}`

/** Keep the strongest candidate per corner. */
export function bestPerCorner(
  raster: Raster,
  estimates: readonly OverlayEstimate[],
): OverlayEstimate[] {
  const best = new Map<string, OverlayEstimate>()
  for (const estimate of estimates) {
    const key = cornerKey(raster, estimate.rect)
    const current = best.get(key)
    if (!current || estimate.confidence * estimate.alpha > current.confidence * current.alpha) {
      best.set(key, estimate)
    }
  }
  return [...best.values()]
}

export function findCornerOverlays(raster: Raster): OverlayEstimate[] {
  const found: OverlayEstimate[] = []

  for (const rect of cornerCandidates(raster)) {
    const probe = estimateOverlay(raster, rect)
    if (!probe || probe.confidence < 0.6 || probe.alpha < 0.12) continue

    // Snap to the real edges, then re-measure. The probe only says "something
    // flat is around here"; the refined rectangle is what the user is offered
    // and what unblending will actually be applied to, so the alpha reported
    // has to be the alpha of that region.
    const snapped = refineRect(raster, rect)
    const estimate = estimateOverlay(raster, snapped) ?? { ...probe, rect: snapped }
    if (estimate.alpha >= 0.12) found.push(estimate)
  }

  return bestPerCorner(raster, found)
}

/** Composite a flat overlay onto a region — the operation the rest of this file undoes. */
export function blend(
  raster: Raster,
  rect: Rect,
  alpha: number,
  color: readonly [number, number, number],
): Raster {
  const out = cloneRaster(raster)
  const x1 = Math.min(raster.width, rect.x + rect.width)
  const y1 = Math.min(raster.height, rect.y + rect.height)

  for (let y = Math.max(0, rect.y); y < y1; y += 1) {
    for (let x = Math.max(0, rect.x); x < x1; x += 1) {
      const index = at(out, x, y)
      for (let c = 0; c < 3; c += 1) {
        const under = out.data[index + c] ?? 0
        out.data[index + c] = clamp(alpha * (color[c] ?? 0) + (1 - alpha) * under, 0, 255)
      }
    }
  }
  return out
}
