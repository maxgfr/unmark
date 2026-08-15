// A badge is a shape, not a rectangle.
//
// overlay.ts models an overlay as one constant alpha over an axis-aligned
// rectangle — which is exactly what its own `blend` produces, and every fixture
// in overlay.test.ts is built with `blend`, so the forward model under test is
// the detector's own assumption. That is the reason none of this ever showed up
// there.
//
// A real generator badge is not that. A Gemini sparkle or a Firefly corner mark
// is an antialiased glyph: inside the rectangle but outside the glyph the true
// alpha is zero, along the glyph's border it passes through every value in
// between, and there is usually a scrim or a drop shadow under it as well.
//
// Two separate things break on such a badge, and the second is worse.
//
// Inverting the region with a single alpha over-corrects every pixel the glyph
// never touched — subtracting a*C from a pixel that was never tinted and then
// dividing by (1-a) pushes it away from its real value and, on dark ground,
// into the clamp at 0. That is the defect this file was written for.
//
// But estimateOverlay never gets that far. Its statistic is the *mean* squared
// neighbour difference, and a glyph adds enormous differences along every edge
// it has. On a shaped badge the mean detail inside the rectangle comes out
// higher than the detail around it, the ratio exceeds one, the alpha comes out
// negative and the function returns undefined: it reports no overlay at all.
// On the fixture in coverage.test.ts a badge worth 28 levels of error was
// invisible to it.
//
// So everything here is built on the *median* squared difference instead of the
// mean. A blend scales every neighbour difference by (1-a), so it scales every
// quantile of their distribution by (1-a)^2 exactly as it scales the mean — the
// ratio of medians estimates the same quantity — but a median is unmoved by the
// small fraction of pairs that lie on a glyph edge. The model does not change;
// the statistic does.
//
// One scale is not enough. An 8x8 grid cannot resolve a glyph arm three pixels
// wide: the tile straddling one reads as half covered, bilinear interpolation
// then smears that half over sixteen pixels, and the region *around* the glyph
// gets corrected as though the glyph were there. Measured on the fixture, the
// tile-only map was worse over the badge's untouched majority than simply
// picking one good alpha. So the tile grid is a prior, not an answer: every
// pixel is re-measured over a 5x5 window and shrunk toward its tile, by the
// same rule the tiles are shrunk toward the region. Where the local evidence is
// overwhelming — a glyph's solid core has almost no detail left at all — it
// wins; where it is 24 noisy differences saying very little, the tile stands.
//
// On top of that:
//
// A tile holds 64 pixels and about 128 neighbour differences, and the ratio of
// two medians on that many samples is noisy — roughly 0.04 of alpha at alpha
// 0.4, which fed straight into the inversion is worth several levels per pixel.
// The first version made a *uniform* badge measurably worse than the
// single-alpha inversion it was meant to improve on. Each tile is therefore
// shrunk toward the region's own median tile in proportion to how far it
// departs from it relative to that noise: a deviation the size of the noise is
// treated as noise, a deviation many times the noise passes through untouched.
// A uniform badge comes back out as a flat map, so today's behaviour is the
// special case rather than a competitor to it.
//
// And a per-pixel ceiling, which is not an estimate at all. For a known overlay
// colour C the alphas that leave `(observed - a*C)/(1-a)` inside [0, 255] form
// an interval whose upper end depends only on the observed pixel. Any alpha
// above it is provably wrong — it recovers a pixel that cannot exist — so the
// map is capped there. This is the part that works at full resolution rather
// than at tile resolution, and it is what stops the dark ground under a white
// badge being crushed to black.
//
// What none of this fixes: a tile is still measured against the ring around the
// whole region, so it assumes the picture under that tile is about as detailed
// as the picture around the badge. Over a badge sitting half on sky and half on
// foliage, the sky half reads as more covered than it is. Nothing recoverable
// from a single image changes that.
//
// And one thing deliberately not built. estimateShaped sees badges that
// findCornerOverlays is blind to, so wiring the corner scan to it looks like
// free accuracy. It was written, measured and thrown away: an ordinary bright
// object in a corner — a road sign, a page, a lit window — scores the same
// alpha and the same confidence as a real badge, to three decimal places. That
// is not a threshold that needs raising. A near-opaque light overlay and a
// white thing that was in front of the camera are the same measurement: little
// local detail, a near-uniform light colour, hard edges, three channels in
// agreement. A grid search over every gate on alpha, confidence and edge
// sharpness, across 18 true and 62 false probes, found none that admits a
// single true positive with no false ones. The scan therefore stays flat-only
// and the interface says so; coverage.test.ts holds the numbers.

import { at, clamp, cloneRaster, type Raster } from '../raster.ts'
import type { OverlayEstimate, Rect } from './overlay.ts'

/** The tile side. Small enough to resolve a glyph arm, large enough to measure. */
const TILE = 8

/** Below this many neighbour differences a tile carries no usable measurement. */
const MIN_PAIRS = 24

/**
 * How many standard errors a tile has to move before it is believed outright.
 *
 * At 1 a tile that differs from the region by exactly the measurement noise
 * would keep half of that noise. 2 keeps a fifth of it, which is what makes a
 * uniform badge come back flat.
 */
const TRUST = 2

/**
 * Relative standard error of a sample median, as a multiple of 1/sqrt(n).
 *
 * 1 would be the figure for a mean. A median of exponentially distributed
 * values — roughly what squared neighbour differences are — costs about 44%
 * more, and that is the price of being unmoved by glyph edges.
 */
const MEDIAN_COST = 1.45

/** Enough of the ring to pin a median. Past this the extra samples buy nothing. */
const RING_BUDGET = 40_000

export interface CoverageMap {
  /** The region the map covers, clipped to the raster. */
  rect: Rect
  /**
   * Per-pixel alpha over `rect`, row-major, `rect.width * rect.height` long.
   *
   * Alpha, not a 0–1 fraction of some reference opacity: a badge's opacity
   * varies between its glyph, its scrim and its antialiased border, and there
   * is no single number to take a fraction of.
   */
  data: Float32Array
}

const clipRect = (raster: Raster, rect: Rect): Rect => {
  const x = Math.max(0, Math.min(raster.width, rect.x))
  const y = Math.max(0, Math.min(raster.height, rect.y))
  return {
    x,
    y,
    width: Math.max(0, Math.min(raster.width, rect.x + rect.width) - x),
    height: Math.max(0, Math.min(raster.height, rect.y + rect.height) - y),
  }
}

const within = (rect: Rect, x: number, y: number) =>
  x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height

interface Sample {
  /** Squared neighbour differences summed over the three channels. */
  total: Float64Array
  /** The same kept per channel, for the per-channel alphas confidence needs. */
  channel: readonly [Float64Array, Float64Array, Float64Array]
  pairs: number
  /** Mean value of the sampled pixels, per channel. */
  mean: [number, number, number]
  pixels: number
}

/**
 * Collect neighbour differences over the pixels a predicate accepts.
 *
 * A difference is kept only when both of its pixels are accepted, so the step
 * at the region's own edge — the overlay's border, not detail — never enters
 * the sample. `stride` skips base pixels without moving the neighbour, which is
 * what keeps a large ring affordable: a median needs a representative sample,
 * not every pixel.
 */
function sampleDifferences(
  raster: Raster,
  scan: Rect,
  member: (x: number, y: number) => boolean,
  stride = 1,
): Sample {
  const columns = Math.ceil(scan.width / stride)
  const rows = Math.ceil(scan.height / stride)
  const capacity = Math.max(1, columns * rows * 2)

  const total = new Float64Array(capacity)
  const channel = [
    new Float64Array(capacity),
    new Float64Array(capacity),
    new Float64Array(capacity),
  ] as const
  const sum: [number, number, number] = [0, 0, 0]
  let pairs = 0
  let pixels = 0

  const x1 = scan.x + scan.width
  const y1 = scan.y + scan.height

  for (let y = scan.y; y < y1; y += stride) {
    for (let x = scan.x; x < x1; x += stride) {
      if (!member(x, y)) continue
      const index = at(raster, x, y)
      for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + (raster.data[index + c] ?? 0)
      pixels += 1

      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        if (!member(x + dx, y + dy)) continue
        const neighbour = at(raster, x + dx, y + dy)
        let energy = 0
        for (let c = 0; c < 3; c += 1) {
          const difference = (raster.data[neighbour + c] ?? 0) - (raster.data[index + c] ?? 0)
          const squared = difference * difference
          energy += squared
          ;(channel[c] as Float64Array)[pairs] = squared
        }
        total[pairs] = energy
        pairs += 1
      }
    }
  }

  const mean: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c += 1) mean[c] = pixels === 0 ? 0 : (sum[c] ?? 0) / pixels
  return { total, channel, pairs, mean, pixels }
}

/** The median of the first `count` entries. Sorts the buffer in place. */
function median(values: Float64Array, count: number): number {
  if (count === 0) return 0
  const view = values.subarray(0, count)
  view.sort()
  return view[count >> 1] ?? 0
}

/** The ring of picture around a region — the same control sample overlay.ts uses. */
function ringOf(
  raster: Raster,
  rect: Rect,
): { scan: Rect; member: (x: number, y: number) => boolean } {
  const pad = Math.max(4, Math.round(Math.min(rect.width, rect.height) * 0.6))
  const scan = clipRect(raster, {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  })
  return {
    scan,
    member: (x, y) =>
      x >= 0 && y >= 0 && x < raster.width && y < raster.height && !within(rect, x, y),
  }
}

interface TileField {
  columns: number
  rows: number
  /** Per-tile alpha after the shrink toward `level`. Unclamped. */
  alpha: Float64Array
  /** The region's own median tile alpha — the shrink target. */
  level: number
  /** Median squared difference of the ring, summed over channels. */
  outside: number
  /** The same, per channel. */
  outsidePerChannel: [number, number, number]
  /** Mean value of the ring, per channel. */
  outsideMean: [number, number, number]
  measured: boolean
}

/**
 * Per-tile alpha over a region: the shared basis of the map and the estimate.
 *
 * `measured` is false when the ring carries no detail. The ratio is then 0/0
 * and there is nothing here to measure, which callers turn into a refusal
 * rather than into a number.
 */
function tileField(raster: Raster, rect: Rect): TileField {
  const columns = Math.max(1, Math.ceil(rect.width / TILE))
  const rows = Math.max(1, Math.ceil(rect.height / TILE))
  const alpha = new Float64Array(columns * rows)

  const ring = ringOf(raster, rect)
  const stride = Math.max(
    1,
    Math.round(Math.sqrt((ring.scan.width * ring.scan.height) / RING_BUDGET)),
  )
  const around = sampleDifferences(raster, ring.scan, ring.member, stride)

  const outside = median(around.total, around.pairs)
  const outsidePerChannel = [0, 1, 2].map((c) =>
    median(around.channel[c] as Float64Array, around.pairs),
  ) as [number, number, number]

  const field: TileField = {
    columns,
    rows,
    alpha,
    level: 0,
    outside,
    outsidePerChannel,
    outsideMean: around.mean,
    // The same idea as overlay.ts's floor: below this the ring is flat enough
    // that the ratio is noise divided by noise.
    measured: around.pairs >= 64 && outside >= 4,
  }
  if (!field.measured) return field

  const inRegion = (x: number, y: number) => within(rect, x, y)
  const raw = new Float64Array(columns * rows)
  const counted = new Int32Array(columns * rows)

  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < columns; tx += 1) {
      const scan = clipRect(raster, {
        x: rect.x + tx * TILE,
        y: rect.y + ty * TILE,
        width: Math.min(TILE, rect.width - tx * TILE),
        height: Math.min(TILE, rect.height - ty * TILE),
      })
      // Neighbours are tested against the whole region rather than the tile, so
      // the pairs straddling a tile boundary are kept. On a sample this small,
      // throwing away a quarter of it would matter.
      const sample = sampleDifferences(raster, scan, inRegion)
      const cell = ty * columns + tx
      counted[cell] = sample.pairs
      raw[cell] =
        sample.pairs < MIN_PAIRS ? 0 : 1 - Math.sqrt(median(sample.total, sample.pairs) / outside)
    }
  }

  // The shrink target is the median tile, not a single ratio over the whole
  // rectangle: on a shaped badge most tiles are background and the median lands
  // there, whereas the whole-rectangle ratio moves with whatever fraction of it
  // the glyph happens to occupy.
  const ordered = Float64Array.from(raw).sort()
  field.level = ordered[ordered.length >> 1] ?? 0

  for (let cell = 0; cell < raw.length; cell += 1) {
    const value = raw[cell] ?? 0
    const count = counted[cell] ?? 0
    if (count < MIN_PAIRS) {
      alpha[cell] = field.level
      continue
    }

    const sigma = 0.5 * Math.abs(1 - value) * (MEDIAN_COST / Math.sqrt(count))
    const deviation = value - field.level
    const noise = (TRUST * sigma) ** 2
    const trust = deviation === 0 ? 0 : deviation ** 2 / (deviation ** 2 + noise)
    alpha[cell] = field.level + deviation * trust
  }

  return field
}

/**
 * The largest alpha for which unblending this pixel still lands in range.
 *
 * `(observed - a*C)/(1-a)` has to come out a real 8-bit value. Solving both
 * ends of that for a gives an upper bound depending only on what was observed
 * and on the overlay colour — no estimate, no assumption about the picture. A
 * genuine composite always satisfies it, having been produced by one; an alpha
 * above it claims the picture underneath was brighter than white or darker than
 * black.
 */
function alphaCeiling(observed: number, color: number): number {
  const low = color > 0 ? observed / color : 1
  const high = color < 255 ? (255 - observed) / (255 - color) : 1
  return Math.min(low, high)
}

/** Per-coordinate weights onto the tile grid, computed once per axis. */
function interpolationAxis(
  length: number,
  centres: readonly number[],
): { low: Int32Array; high: Int32Array; fraction: Float32Array } {
  const low = new Int32Array(length)
  const high = new Int32Array(length)
  const fraction = new Float32Array(length)
  const last = centres.length - 1

  for (let n = 0; n < length; n += 1) {
    let index = 0
    while (index < last && (centres[index + 1] ?? 0) <= n) index += 1

    const a = centres[index] ?? 0
    const b = centres[index + 1] ?? a
    low[n] = index
    high[n] = Math.min(index + 1, last)
    fraction[n] = b === a ? 0 : clamp((n - a) / (b - a), 0, 1)
  }
  return { low, high, fraction }
}

const tileCentres = (extent: number, count: number): number[] =>
  Array.from({ length: count }, (_, t) => (t * TILE + Math.min(extent, t * TILE + TILE) - 1) / 2)

/**
 * Half-width of the window each pixel is re-measured over, once it has a prior.
 *
 * 2 was measured against 1 and 3 on the shaped fixture. 1 is too few
 * differences to overrule anything; 3 blurs the glyph's arms back together.
 */
const LOCAL_RADIUS = 2

/**
 * The same rule as TRUST, one notch stricter, for the per-pixel window.
 *
 * Stricter because the 48 differences in a 5x5 window are not 48 independent
 * measurements — each pixel appears in four of them — and because this pass is
 * the one that can only add error on a badge that is genuinely uniform. At 2 a
 * uniform badge cost 2.9 levels and a shaped one came back to 12.3; at 3 those
 * are 2.2 and 12.5. Buying half a level of noise for a fifth of a level of
 * sharpness is the right way round.
 */
const LOCAL_TRUST = 3

/** A pixel's own window has to hold this many differences to say anything. */
const MIN_LOCAL_PAIRS = 12

interface AlphaField {
  rect: Rect
  /** Per-pixel alpha, 0–1, before any colour ceiling is applied. */
  data: Float32Array
  measured: boolean
  outsidePerChannel: [number, number, number]
  outsideMean: [number, number, number]
}

/**
 * Per-pixel alpha over a region, at two scales.
 *
 * The tile grid gives every pixel a prior it could not get on its own; the 5x5
 * window around the pixel then either overrules that prior or leaves it, by how
 * far it moves against how far it could move by chance. Nothing here looks at
 * the overlay colour — the colour estimate is derived *from* this field, so
 * depending on it would be circular.
 */
function alphaField(raster: Raster, region: Rect): AlphaField {
  const { width, height } = region
  const data = new Float32Array(width * height)
  const field = tileField(raster, region)
  const result: AlphaField = {
    rect: region,
    data,
    measured: field.measured,
    outsidePerChannel: field.outsidePerChannel,
    outsideMean: field.outsideMean,
  }
  if (!field.measured) return result

  // Every neighbour difference in the region, computed once. -1 marks a pair
  // whose other half lies outside the region: the step at the overlay's border,
  // which is not detail and must not be measured as any.
  const right = new Float64Array(width * height).fill(-1)
  const down = new Float64Array(width * height).fill(-1)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(raster, region.x + x, region.y + y)
      const cell = y * width + x
      if (x + 1 < width) {
        const neighbour = at(raster, region.x + x + 1, region.y + y)
        let energy = 0
        for (let c = 0; c < 3; c += 1) {
          energy += ((raster.data[neighbour + c] ?? 0) - (raster.data[index + c] ?? 0)) ** 2
        }
        right[cell] = energy
      }
      if (y + 1 < height) {
        const neighbour = at(raster, region.x + x, region.y + y + 1)
        let energy = 0
        for (let c = 0; c < 3; c += 1) {
          energy += ((raster.data[neighbour + c] ?? 0) - (raster.data[index + c] ?? 0)) ** 2
        }
        down[cell] = energy
      }
    }
  }

  const axisX = interpolationAxis(width, tileCentres(width, field.columns))
  const axisY = interpolationAxis(height, tileCentres(height, field.rows))
  const window = new Float64Array((LOCAL_RADIUS * 2 + 1) ** 2 * 2)

  for (let y = 0; y < height; y += 1) {
    const ty0 = axisY.low[y] ?? 0
    const ty1 = axisY.high[y] ?? 0
    const fy = axisY.fraction[y] ?? 0

    for (let x = 0; x < width; x += 1) {
      const tx0 = axisX.low[x] ?? 0
      const tx1 = axisX.high[x] ?? 0
      const fx = axisX.fraction[x] ?? 0

      const top =
        (field.alpha[ty0 * field.columns + tx0] ?? 0) * (1 - fx) +
        (field.alpha[ty0 * field.columns + tx1] ?? 0) * fx
      const bottom =
        (field.alpha[ty1 * field.columns + tx0] ?? 0) * (1 - fx) +
        (field.alpha[ty1 * field.columns + tx1] ?? 0) * fx
      const prior = top * (1 - fy) + bottom * fy

      let count = 0
      for (
        let wy = Math.max(0, y - LOCAL_RADIUS);
        wy <= Math.min(height - 1, y + LOCAL_RADIUS);
        wy += 1
      ) {
        for (
          let wx = Math.max(0, x - LOCAL_RADIUS);
          wx <= Math.min(width - 1, x + LOCAL_RADIUS);
          wx += 1
        ) {
          const cell = wy * width + wx
          const r = right[cell] ?? -1
          if (r >= 0) window[count++] = r
          const d = down[cell] ?? -1
          if (d >= 0) window[count++] = d
        }
      }

      let alpha = prior
      if (count >= MIN_LOCAL_PAIRS) {
        const local = 1 - Math.sqrt(median(window, count) / field.outside)
        const sigma = 0.5 * Math.abs(1 - local) * (MEDIAN_COST / Math.sqrt(count))
        const deviation = local - prior
        const noise = (LOCAL_TRUST * sigma) ** 2
        const trust = deviation === 0 ? 0 : deviation ** 2 / (deviation ** 2 + noise)
        alpha = prior + deviation * trust
      }
      data[y * width + x] = clamp(alpha, 0, 1)
    }
  }

  return result
}

/**
 * Estimate the overlay's alpha at every pixel of a region.
 *
 * `color` is the overlay colour, from whichever estimate the caller trusts. It
 * is used only for the per-pixel ceiling, never to decide where the glyph is —
 * deciding that from how close a pixel sits to C would read every white cloud
 * under a white badge as fully covered.
 *
 * When the ring around the region carries no detail the map is all zeros: an
 * honest refusal, and one that makes `unblendVarying` a no-op rather than a
 * guess.
 */
export function coverageMap(
  raster: Raster,
  rect: Rect,
  color: readonly [number, number, number],
): CoverageMap {
  const region = clipRect(raster, rect)
  if (region.width === 0 || region.height === 0) {
    return { rect: region, data: new Float32Array(0) }
  }

  const field = alphaField(raster, region)
  if (!field.measured) return { rect: region, data: field.data }

  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const cell = y * region.width + x
      let alpha = field.data[cell] ?? 0
      const index = at(raster, region.x + x, region.y + y)
      for (let c = 0; c < 3; c += 1) {
        alpha = Math.min(alpha, alphaCeiling(raster.data[index + c] ?? 0, color[c] ?? 0))
      }
      field.data[cell] = clamp(alpha, 0, 1)
    }
  }

  return { rect: region, data: field.data }
}

/** Pixels at or above this share of the peak count as the badge's solid part. */
const SOLID_SHARE = 0.75

/**
 * Estimate a *shaped* overlay: what colour it is, and how opaque where it is solid.
 *
 * estimateOverlay answers the same question for a flat rectangle and returns
 * undefined for anything else, which includes every real badge. This is the
 * same arithmetic on the same model, differing in two places: the statistic is
 * a median rather than a mean, so the glyph's own edges do not swamp it, and
 * the colour and alpha are read off the pixels the glyph actually covers rather
 * than off a rectangle that is mostly not glyph. The second half matters more
 * than it sounds — averaging the whole rectangle to find C on a badge that is
 * four fifths background gives a colour pulled four fifths of the way toward
 * the picture, and at alpha 0.88 an error in C is multiplied by eight.
 *
 * The alpha returned is the opacity where the badge is solid, not its average
 * over the region. Nothing should unblend a whole rectangle with it — that is
 * what the coverage map is for — but it is the number to show someone who asked
 * how opaque the badge is.
 */
export function estimateShaped(raster: Raster, rect: Rect): OverlayEstimate | undefined {
  const region = clipRect(raster, rect)
  if (region.width * region.height < 64) return undefined

  const field = alphaField(raster, region)
  if (!field.measured) return undefined

  // A high quantile rather than the maximum: one pixel that happened to land on
  // a flat patch of sky would otherwise set the peak for the whole badge.
  const ordered = Float32Array.from(field.data).sort()
  const peak = ordered[Math.floor((ordered.length - 1) * 0.98)] ?? 0
  if (peak < 0.12) return undefined

  const threshold = peak * SOLID_SHARE
  const solid = (x: number, y: number) =>
    within(region, x, y) &&
    (field.data[(y - region.y) * region.width + (x - region.x)] ?? 0) >= threshold

  const sample = sampleDifferences(raster, region, solid)
  if (sample.pixels < 24 || sample.pairs < 24) return undefined

  // Per-channel alphas over the solid part. Three channels of a real composite
  // agree; disagreement is the honest signal that this is not one.
  const alphas: number[] = []
  for (let c = 0; c < 3; c += 1) {
    const control = field.outsidePerChannel[c] ?? 0
    if (control <= 1) continue
    const inside = median(sample.channel[c] as Float64Array, sample.pairs)
    alphas.push(clamp(1 - Math.sqrt(inside / control), 0, 1))
  }
  if (alphas.length === 0) return undefined

  const alpha = alphas.reduce((a, b) => a + b, 0) / alphas.length
  if (alpha < 0.12) return undefined

  const color = [0, 1, 2].map((c) => {
    const inside = sample.mean[c] ?? 0
    const outside = field.outsideMean[c] ?? 0
    return clamp((inside - (1 - alpha) * outside) / alpha, 0, 255)
  }) as [number, number, number]

  const spread = Math.max(...alphas) - Math.min(...alphas)
  return { rect: region, alpha, color, confidence: clamp(1 - spread * 3, 0, 1) }
}

/**
 * Invert the blend pixel by pixel, using a per-pixel alpha.
 *
 * The colour comes from the estimate, the alpha from the map, and the map's
 * rect is what gets walked — so a map built for a different region than the
 * estimate writes where the map says, not where the estimate does.
 *
 * With a flat map this is `unblend`, arithmetic included, which is the point:
 * the constant-alpha case is not a separate code path, it is this one with a
 * constant.
 */
export function unblendVarying(
  raster: Raster,
  estimate: OverlayEstimate,
  coverage: CoverageMap,
): Raster {
  const out = cloneRaster(raster)
  unblendVaryingInto(out, estimate, coverage)
  return out
}

/** The same inverse in place. `unblendInto` says why the split exists. */
export function unblendVaryingInto(
  out: Raster,
  estimate: OverlayEstimate,
  coverage: CoverageMap,
): void {
  const { rect } = coverage
  const { color } = estimate

  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const alpha = coverage.data[y * rect.width + x] ?? 0
      if (alpha <= 0 || alpha >= 1) continue

      const index = at(out, rect.x + x, rect.y + y)
      for (let c = 0; c < 3; c += 1) {
        const observed = out.data[index + c] ?? 0
        out.data[index + c] = clamp((observed - alpha * (color[c] ?? 0)) / (1 - alpha), 0, 255)
      }
    }
  }
}
