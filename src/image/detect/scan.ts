// Looking for overlays outside the four corners.
//
// The corner scan (overlay.ts) is deliberately narrow and it is right to be:
// generator badges live in corners, sixteen probes is cheap, and it finds
// nothing at all in an unmarked photograph. What it structurally cannot see is
// a caption scrim across the bottom, a tint bar down one side, or a mark in the
// middle — none of those is in a corner, and none of them is square.
//
// Two things had to be solved to look anywhere else.
//
// COST. estimateOverlay walks the rectangle plus a ring 60% of its short side
// deep, so a probe costs about five times its own area. A grid of side-s
// windows at stride s/2 is 4WH/s^2 probes at 4.84 s^2 pixels each — 19.4·W·H
// per scale, *independent of s*. On a 12-megapixel photo that is a quarter of a
// billion pixel visits per scale, and seven scales is half a minute. The answer
// here is to search a shrunken copy: a box downsample is a linear filter and
// the composite is affine, so `shrink(aC + (1-a)I) = aC + (1-a)shrink(I)` holds
// exactly — the alpha the estimator reads off the proxy is the alpha of the
// real thing. Every surviving rectangle is then re-snapped and re-measured on
// the full-resolution picture, so no number the panel shows came from the
// proxy. Lanczos was the obvious tool and is the wrong one: `resample` widens
// its support as it shrinks, and resampling 12 MP down costs five seconds,
// more than the scan it was meant to save.
//
// PRECISION, and this one has no clean answer. Measured on a 1024x768
// photograph, the flat model over the whole frame at four scales: zero hits on
// the unmarked picture, but a patch of smooth sky reads as a 77%-opaque overlay
// at 98% confidence — a stronger reading than either real mark in the same
// test. overlay.ts:29 already says why: the model assumes the picture under the
// overlay is about as detailed as its surroundings, and a smooth region is
// indistinguishable from a detailed one with a blanket over it. A
// boundary-step consistency gate was written and measured; it works until
// refineRect snaps the probe onto the smooth patch's own edge, after which 44
// of the 49 false hits survive it.
//
// So this reports and never applies. The corner scan stays the automatic pass
// because its precision is what makes an automatic pass defensible; the wide
// scan is a button, its results are ticked by hand, and the panel says what a
// smooth sky does. That is the same conclusion coverage.ts:74 reached for
// shaped marks, reproduced for the flat model the moment it leaves the corners.

import { createRaster, type Raster } from '../raster.ts'
import { estimateShaped } from './coverage.ts'
import {
  containment,
  cornerCandidates,
  estimateOverlay,
  findCornerOverlays,
  iou,
  refineRect,
  type OverlayCandidate,
  type Rect,
} from './overlay.ts'

/** A rectangle to probe, and which family proposed it. */
export interface Probe {
  rect: Rect
  source: OverlayCandidate['source']
  /** Which extent refineRect may move. Bands span an axis and must keep it. */
  axes: 'both' | 'vertical' | 'horizontal'
}

export interface ScanOptions {
  /** Look outside the corners. Slow, and much less precise; see the header. */
  wide: boolean
  /** Also propose shaped marks. Less precise again; see `SHAPED_ALPHA`. */
  shaped: boolean
}

export interface ScanHooks {
  onProgress?: (fraction: number) => void
}

/** The longest edge the coarse search runs at. */
const PROXY_EDGE = 1100

/** Thicknesses of the edge bands, as fractions of the crossing dimension. */
const BAND_FRACTIONS = [0.05, 0.1, 0.18]

/** Sizes of the centred rectangles, as fractions of each dimension. */
const CENTRE_FRACTIONS = [0.25, 0.4, 0.6]

/** Grid tilings, as a count of columns and rows. */
const GRID_DIVISIONS = [3, 4]

/** Below this a probe has too few pixels for the estimator to say anything. */
const MIN_PROBE = 24

/** The coarse pass keeps a proposal at or above these. Deliberately loose. */
const COARSE_CONFIDENCE = 0.55
const COARSE_ALPHA = 0.1

/** The full-resolution pass keeps a candidate at or above these. */
const KEEP_CONFIDENCE = 0.6
const KEEP_ALPHA = 0.12

/**
 * How many proposals survive the coarse pass into full-resolution measurement.
 *
 * A cap on where to look, not on what was found: roughly a hundred probes are
 * proposed over a frame and the strongest two dozen are measured properly. It
 * is worth being clear that this is not reported anywhere, because it does not
 * bound the result — a region dropped here was ranked below twenty-four others
 * on the same picture, and saying "24 of 110 places were measured" would be a
 * number about the search rather than about the image.
 */
const SHORTLIST = 24

/**
 * A shaped candidate has to be this opaque to be proposed at all.
 *
 * A shaped mark worth naming is a glyph, and a glyph's solid core is close to
 * opaque. Below this it is a soft tint, which is the flat model's job and the
 * flat model's precision. This does not make shaped proposals trustworthy — see
 * `findOverlays` — it only keeps the weakest half of them out of the list.
 */
const SHAPED_ALPHA = 0.35
const SHAPED_CONFIDENCE = 0.75

/** Two candidates describe the same region past either of these. */
const SAME_IOU = 0.3
const SAME_CONTAINMENT = 0.65

const clampRect = (rect: Rect, raster: Raster): Rect => {
  const x = Math.max(0, Math.min(rect.x, raster.width - 1))
  const y = Math.max(0, Math.min(rect.y, raster.height - 1))
  return {
    x,
    y,
    width: Math.min(rect.width, raster.width - x),
    height: Math.min(rect.height, raster.height - y),
  }
}

/**
 * Shrink by an integer factor, averaging each block.
 *
 * A box average, which is what makes the proxy sound: it is linear, so it
 * commutes with the composite the estimator inverts. Lanczos would be prettier
 * and is not needed — nothing is shown to anyone at this size, it is only
 * measured.
 */
export function shrink(raster: Raster, factor: number): Raster {
  if (factor <= 1) return raster

  const width = Math.max(1, Math.floor(raster.width / factor))
  const height = Math.max(1, Math.floor(raster.height / factor))
  const out = createRaster(width, height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sum = [0, 0, 0, 0]
      let count = 0

      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y * factor + dy
        if (sy >= raster.height) break
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx
          if (sx >= raster.width) break
          const index = (sy * raster.width + sx) * 4
          for (let c = 0; c < 4; c += 1) sum[c] = (sum[c] ?? 0) + (raster.data[index + c] ?? 0)
          count += 1
        }
      }

      const index = (y * width + x) * 4
      for (let c = 0; c < 4; c += 1) out.data[index + c] = (sum[c] ?? 0) / Math.max(1, count)
    }
  }
  return out
}

/** How much to shrink by for the coarse pass. 1 when the picture is already small. */
export const proxyFactor = (raster: Raster): number =>
  Math.max(1, Math.floor(Math.max(raster.width, raster.height) / PROXY_EDGE))

/**
 * A rectangle measured on the proxy, back in the full picture's coordinates.
 *
 * Multiplying by the factor is not enough, because `shrink` floors: a 2201-wide
 * picture at factor 2 has a 1100-wide proxy, and 1100 x 2 is 2200. A probe that
 * ran to the proxy's own edge therefore comes back one pixel short of the real
 * one — and a band freezes exactly that extent when it is refined, so nothing
 * downstream recovers it. The last column of a full-width scrim stayed marked.
 *
 * So an edge on the proxy is carried across as an edge: a probe that reached
 * the proxy's boundary reaches the raster's.
 */
function enlarge(rect: Rect, factor: number, proxy: Raster, raster: Raster): Rect {
  const left = rect.x === 0 ? 0 : rect.x * factor
  const top = rect.y === 0 ? 0 : rect.y * factor
  const right = rect.x + rect.width >= proxy.width ? raster.width : (rect.x + rect.width) * factor
  const bottom =
    rect.y + rect.height >= proxy.height ? raster.height : (rect.y + rect.height) * factor

  return clampRect({ x: left, y: top, width: right - left, height: bottom - top }, raster)
}

/**
 * Everywhere outside the corners that is worth a look.
 *
 * Three families, each for a shape the corner scan cannot express: bands that
 * span the frame, a centred rectangle, and a plain tiling for everything else.
 * The tilings are offset from one another rather than nested, so a mark sitting
 * on one grid's seam is in the middle of the other's cell.
 */
export function wideCandidates(raster: Raster): Probe[] {
  const { width, height } = raster
  const probes: Probe[] = []
  const propose = (rect: Rect, source: Probe['source'], axes: Probe['axes']) => {
    probes.push({ rect: clampRect(rect, raster), source, axes })
  }

  // Bands step by half their thickness, and the overlap is load-bearing rather
  // than thorough. A probe that straddles a band's edge contains the step
  // itself, and a step is the largest neighbour difference in the region — so
  // the detail energy inside comes out as high as the ring's and the estimator
  // reads no overlay at all. Measured: laid end to end, a 60px scrim across a
  // 420px picture was missed by every one of its fifteen band probes. What the
  // scan needs is one probe sitting wholly *inside* the band, which refineRect
  // then grows back out to the real edges.
  for (const fraction of BAND_FRACTIONS) {
    const thickness = Math.round(height * fraction)
    if (thickness >= MIN_PROBE) {
      const step = Math.max(1, Math.round(thickness / 2))
      for (let y = 0; y + thickness <= height; y += step) {
        propose({ x: 0, y, width, height: thickness }, 'band', 'vertical')
      }
    }

    const across = Math.round(width * fraction)
    if (across >= MIN_PROBE) {
      const step = Math.max(1, Math.round(across / 2))
      for (let x = 0; x + across <= width; x += step) {
        propose({ x, y: 0, width: across, height }, 'band', 'horizontal')
      }
    }
  }

  for (const fraction of CENTRE_FRACTIONS) {
    const w = Math.round(width * fraction)
    const h = Math.round(height * fraction)
    if (w < MIN_PROBE || h < MIN_PROBE) continue
    propose(
      { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h },
      'centre',
      'both',
    )
  }

  for (const divisions of GRID_DIVISIONS) {
    const w = Math.floor(width / divisions)
    const h = Math.floor(height / divisions)
    if (w < MIN_PROBE || h < MIN_PROBE) continue

    for (let row = 0; row < divisions; row += 1) {
      for (let column = 0; column < divisions; column += 1) {
        propose({ x: column * w, y: row * h, width: w, height: h }, 'grid', 'both')
      }
    }
  }

  return probes
}

/**
 * Suppress candidates that describe the same region, keeping the strongest.
 *
 * Ranked by `confidence * alpha`, the same score `bestPerCorner` uses, so one
 * notion of "strongest" exists in this codebase rather than two — but *within a
 * kind*. Across the two models the ranking is not a score at all: a flat
 * candidate is the case whose inverse is exact, and a shaped one is the
 * median-based fallback that coverage.ts records cannot tell a badge from a
 * road sign. A region the flat model can describe does not need describing
 * again, less exactly, however confident the fallback is about it.
 *
 * That is why this sorts flat first. It used to sort by score alone, and
 * `findOverlays` merged twice to compensate — once over the flat tier, then
 * over flat-plus-shaped keeping only the shaped. A shaped candidate that
 * outscored a flat one it overlapped suppressed the flat one *inside that
 * second call* and survived the filter, while the first call's flat list was
 * emitted anyway: both came back, one set of pixels described twice at two
 * different opacities, and ticking both handed `disjoint` a pair it dropped
 * half of with a note the reader had no way to explain.
 *
 * Two predicates, because one is not enough. Containment is what folds a scale
 * pyramid: probing one band at four sizes leaves fragments wholly inside the
 * largest whose IoU against it is under 0.25. IoU is what keeps two same-sized
 * neighbours — the tiles of a repeating watermark — from being merged into one.
 */
const RANK: Record<OverlayCandidate['kind'], number> = { flat: 0, shaped: 1 }

export function mergeCandidates(candidates: readonly OverlayCandidate[]): OverlayCandidate[] {
  const ranked = [...candidates].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || b.confidence * b.alpha - a.confidence * a.alpha,
  )
  const kept: OverlayCandidate[] = []

  for (const candidate of ranked) {
    const duplicate = kept.some(
      (other) =>
        iou(candidate.rect, other.rect) >= SAME_IOU ||
        containment(candidate.rect, other.rect) >= SAME_CONTAINMENT,
    )
    if (!duplicate) kept.push(candidate)
  }
  return kept
}

/** Measure one proposal properly, on the full-resolution picture. */
function measure(raster: Raster, probe: Probe, shaped: boolean): OverlayCandidate | undefined {
  const snapped = refineRect(raster, probe.rect, probe.axes)

  const flat = estimateOverlay(raster, snapped)
  if (flat && flat.confidence >= KEEP_CONFIDENCE && flat.alpha >= KEEP_ALPHA) {
    return { ...flat, kind: 'flat', source: probe.source }
  }
  if (!shaped) return undefined

  // Only where the flat model refused. A region it can describe is a region its
  // inverse is exact for, and the shaped estimator is the fallback, not a
  // second opinion.
  const glyph = estimateShaped(raster, snapped)
  if (glyph && glyph.confidence >= SHAPED_CONFIDENCE && glyph.alpha >= SHAPED_ALPHA) {
    return { ...glyph, kind: 'shaped', source: probe.source }
  }
  return undefined
}

/**
 * The automatic pass: corners, flat only, exactly as it always was.
 *
 * A wrapper rather than a reimplementation. `findCornerOverlays` is the scan
 * whose precision has been measured over time and the only one that runs
 * without being asked for; a second copy of it here that drifted by one
 * threshold would be a difference nobody would look for.
 */
export function scanCorners(raster: Raster): OverlayCandidate[] {
  const found: OverlayCandidate[] = []
  for (const estimate of findCornerOverlays(raster)) {
    found.push({ ...estimate, kind: 'flat', source: 'corner' })
  }
  return found
}

/** Strongest first, by the one score this file uses. Kind is ordered outside. */
const sortByStrength = (candidates: readonly OverlayCandidate[]) =>
  [...candidates].sort((a, b) => b.confidence * b.alpha - a.confidence * a.alpha)

/**
 * Which of the wide proposals are worth measuring properly.
 *
 * Run on the shrunken copy, at loose thresholds: this pass is deciding where to
 * look, not what is there. Everything it keeps is re-snapped and re-measured at
 * full resolution afterwards.
 */
function shortlistWide(raster: Raster, hooks: ScanHooks): Probe[] {
  const factor = proxyFactor(raster)
  const proxy = shrink(raster, factor)
  const scaled = wideCandidates(proxy)
  const promising: { probe: Probe; score: number }[] = []

  scaled.forEach((probe, index) => {
    const estimate = estimateOverlay(proxy, probe.rect)
    if (estimate && estimate.confidence >= COARSE_CONFIDENCE && estimate.alpha >= COARSE_ALPHA) {
      promising.push({
        probe: { ...probe, rect: enlarge(probe.rect, factor, proxy, raster) },
        score: estimate.confidence * estimate.alpha,
      })
    }
    hooks.onProgress?.(((index + 1) / scaled.length) * 0.5)
  })

  promising.sort((a, b) => b.score - a.score)
  return promising.slice(0, SHORTLIST).map((entry) => entry.probe)
}

/**
 * Everything the scan can propose, strongest first, flat before shaped.
 *
 * Ordering is not cosmetic. The flat tier is a model that finds nothing at all
 * in an unmarked photograph; the shaped tier is a model that cannot tell a
 * badge from a road sign, and coverage.test.ts holds both numbers. Interleaving
 * them by score would put a proposal of the second kind above one of the first
 * and hide the only distinction that matters.
 */
export function findOverlays(
  raster: Raster,
  options: ScanOptions,
  hooks: ScanHooks = {},
): OverlayCandidate[] {
  const corners = scanCorners(raster)

  // The corner probes are measured at full resolution, where they were
  // designed to be: the badge they look for is a few dozen pixels wide, and a
  // proxy is exactly where it would disappear.
  const probes: Probe[] = options.shaped
    ? cornerCandidates(raster).map((rect) => ({ rect, source: 'corner', axes: 'both' }))
    : []

  if (options.wide) probes.push(...shortlistWide(raster, hooks))

  const found: OverlayCandidate[] = [...corners]
  probes.forEach((probe, index) => {
    const candidate = measure(raster, probe, options.shaped)
    if (candidate) found.push(candidate)
    hooks.onProgress?.(0.5 + ((index + 1) / Math.max(1, probes.length)) * 0.5)
  })

  // One merge over both tiers, not one per tier and then a second across them.
  // `mergeCandidates` ranks flat ahead of shaped, so a region the flat model
  // already describes exactly is not described again, less exactly — which is
  // what the two-call version was reaching for and did not achieve.
  const merged = mergeCandidates(found)
  const flat = merged.filter((candidate) => candidate.kind === 'flat')
  const shaped = merged.filter((candidate) => candidate.kind === 'shaped')

  // Unconditionally, and at the end. The coarse pass can shortlist nothing at
  // all — which is the right answer on a clean picture — and the loop that
  // would have carried the bar the rest of the way then never runs, leaving a
  // finished scan showing 50%.
  hooks.onProgress?.(1)
  return [...sortByStrength(flat), ...sortByStrength(shaped)]
}
