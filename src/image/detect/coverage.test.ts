import { describe, expect, it } from 'vitest'
import { coverageMap, estimateShaped, unblendVarying } from './coverage.ts'
import {
  blend,
  cornerCandidates,
  estimateOverlay,
  findCornerOverlays,
  unblend,
  type OverlayEstimate,
  type Rect,
} from './overlay.ts'
import { at, clamp, cloneRaster, createRaster, xorshift, type Raster } from '../raster.ts'

// The fixtures here exist because the ones in overlay.test.ts cannot show this
// defect: every one of them is built with `blend`, which composites a single
// constant alpha over a rectangle — the detector's own model. A test whose
// forward model is the assumption under test can only ever agree with it.
//
// So the badge below is drawn the way a real one is: a shaped glyph, a
// translucent scrim behind it, a soft dark halo, and every edge antialiased by
// supersampling rather than snapped to the pixel grid. The picture underneath
// is a gradient with structure and grain, not a flat field.
//
// The flat baseline the map is measured against is deliberately generous. It is
// not the alpha any estimator produces — none of them produce a usable single
// alpha for a shaped badge — it is the alpha found by searching for whichever
// one leaves the least error, with the true overlay colour handed to it. No
// implementation could do better with one number, so beating it is the claim
// worth making.

/** Something with the statistics of a photograph: low frequency, structure, grain. */
function photograph(width: number, height: number, seed = 19): Raster {
  const raster = createRaster(width, height)
  const random = xorshift(seed)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width
      const v = y / height
      // Two soft lobes and a diagonal ridge: content at a scale between the
      // gradient and the grain, which is what a real subject has and a
      // gradient-plus-noise fixture does not.
      const lobe = 62 * Math.exp(-(((u - 0.28) ** 2 + (v - 0.72) ** 2) / 0.03))
      const dip = -48 * Math.exp(-(((u - 0.74) ** 2 + (v - 0.26) ** 2) / 0.05))
      const ridge = 20 * Math.sin((x + y) * 0.11)

      const index = at(raster, x, y)
      raster.data[index] = 44 + u * 118 + lobe + ridge + random() * 26
      raster.data[index + 1] = 68 + v * 108 + lobe * 0.6 + dip + ridge * 0.7 + random() * 26
      raster.data[index + 2] = 148 - u * 68 + dip * 0.8 - ridge * 0.5 + random() * 26
      raster.data[index + 3] = 255
    }
  }
  return raster
}

const SUB = 4

/** Coverage per pixel, by supersampling a shape 4x4. This is the antialiasing. */
function rasterise(
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
): Float32Array {
  const field = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hits = 0
      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          if (inside(x + (sx + 0.5) / SUB, y + (sy + 0.5) / SUB)) hits += 1
        }
      }
      field[y * width + x] = hits / (SUB * SUB)
    }
  }
  return field
}

const roundedRect =
  (left: number, top: number, right: number, bottom: number, radius: number) =>
  (x: number, y: number): boolean => {
    const dx = Math.max(left + radius - x, 0, x - (right - radius))
    const dy = Math.max(top + radius - y, 0, y - (bottom - radius))
    return dx * dx + dy * dy <= radius * radius
  }

/** The four-point sparkle every generator badge seems to have settled on. */
const astroid =
  (cx: number, cy: number, radius: number) =>
  (x: number, y: number): boolean =>
    Math.abs((x - cx) / radius) ** (2 / 3) + Math.abs((y - cy) / radius) ** (2 / 3) <= 1

/** Two box passes, which is close enough to a Gaussian for a halo. */
function blur(field: Float32Array, width: number, height: number, radius: number): Float32Array {
  let current = field
  for (let pass = 0; pass < 2; pass += 1) {
    const horizontal = new Float32Array(width * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        let count = 0
        for (let k = -radius; k <= radius; k += 1) {
          const sx = x + k
          if (sx < 0 || sx >= width) continue
          sum += current[y * width + sx] ?? 0
          count += 1
        }
        horizontal[y * width + x] = count === 0 ? 0 : sum / count
      }
    }
    const vertical = new Float32Array(width * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        let count = 0
        for (let k = -radius; k <= radius; k += 1) {
          const sy = y + k
          if (sy < 0 || sy >= height) continue
          sum += horizontal[sy * width + x] ?? 0
          count += 1
        }
        vertical[y * width + x] = count === 0 ? 0 : sum / count
      }
    }
    current = vertical
  }
  return current
}

/** Composite one colour over a region at a per-pixel alpha. */
function over(
  raster: Raster,
  rect: Rect,
  color: readonly [number, number, number],
  field: Float32Array,
): Raster {
  const out = cloneRaster(raster)
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const alpha = field[y * rect.width + x] ?? 0
      if (alpha <= 0) continue
      const index = at(out, rect.x + x, rect.y + y)
      for (let c = 0; c < 3; c += 1) {
        const under = out.data[index + c] ?? 0
        out.data[index + c] = clamp(alpha * (color[c] ?? 0) + (1 - alpha) * under, 0, 255)
      }
    }
  }
  return out
}

const SCRIM_ALPHA = 0.14
const GLYPH_ALPHA = 0.88
const HALO_ALPHA = 0.3
const WHITE: readonly [number, number, number] = [252, 252, 250]
const HALO: readonly [number, number, number] = [12, 14, 20]

/**
 * A badge that looks like one: a sparkle, two bars of stand-in text, a wider
 * bar for a caption, a rounded translucent scrim, every edge antialiased.
 *
 * `halo` adds the soft dark ring a real badge carries so it stays legible on a
 * light background. It is a second colour, which the one-colour-one-alpha model
 * cannot represent at any alpha — so it is separated out, and both cases are
 * measured: what a shaped badge in one colour costs, and what the halo adds on
 * top of that.
 *
 * The returned field is the ground truth: the alpha of the white layer.
 */
function shapedBadge(
  base: Raster,
  rect: Rect,
  { halo = false }: { halo?: boolean } = {},
): { marked: Raster; alpha: Float32Array } {
  const { width, height } = rect

  const scrim = rasterise(width, height, roundedRect(2, 2, width - 2, height - 2, 14))
  const sparkle = astroid(width * 0.28, height * 0.3, width * 0.2)
  const barOne = roundedRect(width * 0.5, height * 0.2, width * 0.92, height * 0.3, 2.5)
  const barTwo = roundedRect(width * 0.5, height * 0.36, width * 0.8, height * 0.46, 2.5)
  const barThree = roundedRect(width * 0.11, height * 0.65, width * 0.89, height * 0.78, 3.5)
  const glyph = rasterise(
    width,
    height,
    (x, y) => sparkle(x, y) || barOne(x, y) || barTwo(x, y) || barThree(x, y),
  )

  const alpha = new Float32Array(width * height)
  for (let i = 0; i < alpha.length; i += 1) {
    // The scrim and the glyph are the same colour, so they compose into one
    // alpha field rather than two layers.
    alpha[i] = 1 - (1 - SCRIM_ALPHA * (scrim[i] ?? 0)) * (1 - GLYPH_ALPHA * (glyph[i] ?? 0))
  }

  let ground = base
  if (halo) {
    // Tight to the glyph and hidden underneath it, which is where a real one is
    // — a blurred copy of the whole scrim would be a flat dark tint over the
    // entire badge, which is not what anyone ships.
    const spread = blur(glyph, width, height, 2)
    const ring = new Float32Array(width * height)
    for (let i = 0; i < ring.length; i += 1) {
      ring[i] = clamp((spread[i] ?? 0) * 1.8, 0, 1) * (1 - (glyph[i] ?? 0)) * HALO_ALPHA
    }
    ground = over(base, rect, HALO, ring)
  }

  return { marked: over(ground, rect, WHITE, alpha), alpha }
}

function meanAbsError(a: Raster, b: Raster, rect: Rect): number {
  let total = 0
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(a, x, y)
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs((a.data[index + c] ?? 0) - (b.data[index + c] ?? 0))
        count += 1
      }
    }
  }
  return count === 0 ? 0 : total / count
}

/**
 * The least error any single alpha can leave, given the true overlay colour.
 *
 * An oracle: it is handed the answer to half the problem and searches the other
 * half exhaustively. No estimator can beat it, so it is the honest floor for
 * "what a constant-alpha model is worth on this badge".
 */
function bestFlatResidual(
  original: Raster,
  marked: Raster,
  rect: Rect,
  color: readonly [number, number, number],
): { alpha: number; residual: number } {
  let best = { alpha: 0, residual: meanAbsError(original, marked, rect) }
  for (let step = 1; step < 96; step += 1) {
    const alpha = step / 100
    const candidate = unblend(marked, { rect, alpha, color: [...color], confidence: 1 })
    const residual = meanAbsError(original, candidate, rect)
    if (residual < best.residual) best = { alpha, residual }
  }
  return best
}

/** Pixels driven into the clamp at 0 that were not dark to begin with. */
function crushed(original: Raster, restored: Raster, rect: Rect): number {
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(original, x, y)
      for (let c = 0; c < 3; c += 1) {
        if ((restored.data[index + c] ?? 0) === 0 && (original.data[index + c] ?? 0) > 12)
          count += 1
      }
    }
  }
  return count
}

const BADGE: Rect = { x: 156, y: 156, width: 72, height: 72 }
const scene = () => photograph(384, 384)

const mean = (values: Float32Array) => values.reduce((a, b) => a + b, 0) / values.length
const deviation = (values: Float32Array) => {
  const centre = mean(values)
  return Math.sqrt(mean(values.map((v) => (v - centre) ** 2)))
}

const WHITE_ESTIMATE: OverlayEstimate = {
  rect: BADGE,
  alpha: 0.4,
  color: [255, 255, 255],
  confidence: 1,
}

describe('coverageMap', () => {
  it('is flat for a uniform badge, so the constant-alpha case is unchanged', () => {
    // The property that makes this a generalisation rather than a replacement.
    // Standard deviation rather than max minus min: over 5184 pixels the
    // extreme of any noisy field is an order statistic, not a description of
    // it, and asserting on one would be asserting on the tail.
    const marked = blend(scene(), BADGE, 0.4, [255, 255, 255])
    const map = coverageMap(marked, BADGE, [255, 255, 255])

    expect(mean(map.data)).toBeCloseTo(0.4, 1)
    expect(deviation(map.data)).toBeLessThan(0.03)
  })

  it('costs a uniform badge about two levels against plain unblending', () => {
    // The price of the second scale, stated rather than hidden. A per-pixel
    // window over 48 neighbour differences fits some noise no matter how hard
    // it is shrunk, and on a badge that really is uniform that fitting is all
    // it does. Two levels against the fifteen it saves on a shaped badge is the
    // trade this file makes; both numbers are here so it can be re-judged.
    const original = scene()
    const marked = blend(original, BADGE, 0.4, [255, 255, 255])

    const flat = meanAbsError(original, unblend(marked, WHITE_ESTIMATE), BADGE)
    const varying = meanAbsError(
      original,
      unblendVarying(marked, WHITE_ESTIMATE, coverageMap(marked, BADGE, [255, 255, 255])),
      BADGE,
    )
    expect(flat).toBeLessThan(1)
    expect(varying).toBeLessThan(3)
  })

  it('reads a shaped badge as covered where the glyph is and not where it is not', () => {
    const { marked, alpha } = shapedBadge(scene(), BADGE)
    const estimate = estimateShaped(marked, BADGE)
    if (!estimate) throw new Error('the fixture stopped reading as an overlay')

    const map = coverageMap(marked, BADGE, estimate.color)

    let onGlyph = 0
    let onCount = 0
    let offGlyph = 0
    let offCount = 0
    for (let i = 0; i < alpha.length; i += 1) {
      const truth = alpha[i] ?? 0
      if (truth > 0.7) {
        onGlyph += map.data[i] ?? 0
        onCount += 1
      } else if (truth < 0.05) {
        offGlyph += map.data[i] ?? 0
        offCount += 1
      }
    }
    expect(onCount).toBeGreaterThan(400)
    expect(offCount).toBeGreaterThan(400)

    // A single alpha gives these two the same number. The gap is the entire
    // content of the map.
    expect(onGlyph / onCount).toBeGreaterThan(0.7)
    expect(offGlyph / offCount).toBeLessThan(0.2)
  })

  it('refuses to guess when the surroundings carry no detail', () => {
    const flat = createRaster(256, 256)
    flat.data.fill(140)
    for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255

    const map = coverageMap(blend(flat, BADGE, 0.4, [255, 255, 255]), BADGE, [255, 255, 255])
    expect(Math.max(...map.data)).toBe(0)
  })

  it('clips its region to the raster', () => {
    const map = coverageMap(scene(), { x: 350, y: 350, width: 80, height: 80 }, [255, 255, 255])
    expect(map.rect).toEqual({ x: 350, y: 350, width: 34, height: 34 })
    expect(map.data.length).toBe(34 * 34)
  })
})

describe('estimateShaped', () => {
  it('sees a shaped badge that estimateOverlay reports as nothing at all', () => {
    // The finding that made this file necessary. A glyph adds huge neighbour
    // differences along its own edges, the mean detail inside the rectangle
    // comes out higher than the detail around it, and the flat estimator reads
    // a badge worth 34 levels as an unmarked patch of picture.
    const original = scene()
    const { marked } = shapedBadge(original, BADGE, { halo: true })
    expect(meanAbsError(original, marked, BADGE)).toBeGreaterThan(25)
    expect(estimateOverlay(marked, BADGE)).toBeUndefined()

    const shaped = estimateShaped(marked, BADGE)
    expect(shaped).toBeDefined()
    // The opacity where the badge is solid, which is the glyph's own alpha.
    expect(shaped?.alpha).toBeCloseTo(GLYPH_ALPHA, 1)
    expect(shaped?.confidence).toBeGreaterThan(0.6)
  })

  it('recovers the overlay colour to within 5 levels on a shaped badge', () => {
    // At alpha 0.88 only an eighth of the picture survives the composite, so an
    // error in C is multiplied by eight on the way back out. This is the number
    // that decides whether unblending a solid glyph is worth attempting.
    const { marked } = shapedBadge(scene(), BADGE)
    const shaped = estimateShaped(marked, BADGE)
    expect(shaped).toBeDefined()
    for (let c = 0; c < 3; c += 1) {
      expect(Math.abs((shaped?.color[c] ?? 0) - (WHITE[c] ?? 0))).toBeLessThan(5)
    }
  })

  it('agrees with the flat estimator on a flat badge', () => {
    const marked = blend(scene(), BADGE, 0.4, [255, 255, 255])
    const shaped = estimateShaped(marked, BADGE)
    expect(shaped?.alpha).toBeCloseTo(0.4, 1)
    expect(shaped?.color[0]).toBeGreaterThan(230)
  })

  it('finds nothing in an unmarked picture', () => {
    // The most important negative, and the one a more sensitive estimator is
    // most likely to lose.
    expect(estimateShaped(scene(), BADGE)).toBeUndefined()
    expect(estimateShaped(photograph(384, 384, 41), BADGE)).toBeUndefined()
  })

  it('refuses a region too small to measure', () => {
    const marked = blend(scene(), BADGE, 0.4, [255, 255, 255])
    expect(estimateShaped(marked, { x: 156, y: 156, width: 6, height: 6 })).toBeUndefined()
  })
})

describe('unblendVarying', () => {
  it('leaves every pixel outside the map untouched', () => {
    const { marked } = shapedBadge(scene(), BADGE, { halo: true })
    const estimate = estimateShaped(marked, BADGE)
    if (!estimate) throw new Error('the fixture stopped reading as an overlay')

    const restored = unblendVarying(marked, estimate, coverageMap(marked, BADGE, estimate.color))
    expect(meanAbsError(marked, restored, { x: 0, y: 0, width: 120, height: 384 })).toBe(0)
  })

  it('recovers a shaped antialiased badge to within 13 levels mean absolute error', () => {
    // The number this exercise exists to produce: not "the removal will be
    // partial and I do not know how partial", but a figure a test holds. The
    // badge is worth 36 levels over the region; 13 is what survives it.
    //
    // A perfect map with a perfect colour would leave 0.6, so nearly all of the
    // 13 is estimation error, not a limit of the arithmetic. Almost all of it
    // sits on the glyph's solid core, where alpha is 0.88 and only an eighth of
    // the picture underneath was ever recorded.
    const original = scene()
    const { marked } = shapedBadge(original, BADGE)
    const estimate = estimateShaped(marked, BADGE)
    if (!estimate) throw new Error('the fixture stopped reading as an overlay')

    const residual = meanAbsError(
      original,
      unblendVarying(marked, estimate, coverageMap(marked, BADGE, estimate.color)),
      BADGE,
    )
    expect(meanAbsError(original, marked, BADGE)).toBeGreaterThan(30)
    expect(residual).toBeLessThan(13)
  })

  it('recovers the same badge with a dark halo to within 16 levels', () => {
    // Worse than the one-colour case, and it has to be: the halo is a second
    // colour, and no alpha reproduces two colours from one. Three levels is
    // what that costs here.
    const original = scene()
    const { marked } = shapedBadge(original, BADGE, { halo: true })
    const estimate = estimateShaped(marked, BADGE)
    if (!estimate) throw new Error('the fixture stopped reading as an overlay')

    const residual = meanAbsError(
      original,
      unblendVarying(marked, estimate, coverageMap(marked, BADGE, estimate.color)),
      BADGE,
    )
    expect(residual).toBeLessThan(16)
  })

  it('leaves under half the residual of the best single alpha that exists', () => {
    // Not the alpha an estimator would find — the alpha found by searching all
    // of them with the true colour in hand. Nothing built on one number can do
    // better than this, and it still leaves 27 levels where the map leaves 13.
    const original = scene()
    const { marked } = shapedBadge(original, BADGE)
    const estimate = estimateShaped(marked, BADGE)
    if (!estimate) throw new Error('the fixture stopped reading as an overlay')

    const oracle = bestFlatResidual(original, marked, BADGE, WHITE)
    const varying = meanAbsError(
      original,
      unblendVarying(marked, estimate, coverageMap(marked, BADGE, estimate.color)),
      BADGE,
    )
    expect(oracle.residual).toBeGreaterThan(20)
    expect(varying).toBeLessThan(oracle.residual * 0.5)
  })

  it('stops crushing the dark ground the glyph never covered', () => {
    // The visible half of the defect. A single alpha subtracts a*C from pixels
    // the glyph never touched; where the picture underneath is dark that lands
    // below zero and clamps, and a rectangle of blocked-up shadow appears where
    // the badge was.
    const original = scene()
    const { marked } = shapedBadge(original, BADGE)
    const estimate = estimateShaped(marked, BADGE)
    if (!estimate) throw new Error('the fixture stopped reading as an overlay')

    const flat = crushed(original, unblend(marked, estimate), BADGE)
    const varying = crushed(
      original,
      unblendVarying(marked, estimate, coverageMap(marked, BADGE, estimate.color)),
      BADGE,
    )
    expect(flat).toBeGreaterThan(1000)
    expect(varying).toBeLessThan(flat / 20)
  })
})

describe('the shaped fixture itself', () => {
  it('is not a flat rectangle, which is the only reason these numbers mean anything', () => {
    // If this ever passes trivially the fixture has drifted back into agreeing
    // with the model under test, and every figure above becomes decorative.
    const { alpha } = shapedBadge(scene(), BADGE)
    const bare = [...alpha].filter((a) => a < 0.02).length
    const solid = [...alpha].filter((a) => a > 0.8).length
    const partial = [...alpha].filter((a) => a > 0.02 && a < 0.8).length

    expect(bare).toBeGreaterThan(200)
    expect(solid).toBeGreaterThan(400)
    // The antialiased borders and the scrim: values no constant-alpha model can
    // produce at all.
    expect(partial).toBeGreaterThan(1000)
  })
})

// What the automatic corner scan can and cannot find.
//
// The gap is real: findCornerOverlays is built on estimateOverlay, and
// estimateOverlay cannot see a shaped badge at all — so the scan proposes
// nothing for exactly the badges it exists to find. The obvious repair is to
// probe the same corner rectangles with estimateShaped. That was built and
// measured, and it is not shippable. These tests are the measurement, kept so
// the decision can be re-judged rather than re-argued.
//
// A grid search over every gate on (alpha, confidence, edge sharpness) across
// 18 true and 62 false probes found no gate at all that admits one true
// positive with zero false positives. The reason is below: an ordinary bright
// object in a corner scores the same as a badge, to three decimal places.

const CORNER: Rect = { x: 300, y: 300, width: 72, height: 72 }

const overlapping = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** A plainer picture: gradient and grain, with no structure in between. */
function lowTexture(size = 384, seed = 9): Raster {
  const raster = createRaster(size, size)
  const random = xorshift(seed)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = at(raster, x, y)
      raster.data[index] = 40 + (x / size) * 140 + random() * 50
      raster.data[index + 1] = 70 + (y / size) * 120 + random() * 50
      raster.data[index + 2] = 160 - (x / size) * 90 + random() * 50
      raster.data[index + 3] = 255
    }
  }
  return raster
}

/**
 * An ordinary bright object in a corner: a sign, a page, a lit window, snow.
 *
 * Not a composite — a thing that was in front of the camera. This is the case
 * that decides the question.
 */
function brightObject(base: Raster, rect: Rect): Raster {
  const out = cloneRaster(base)
  const random = xorshift(53)
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(out, x, y)
      out.data[index] = 234 + random() * 5
      out.data[index + 1] = 232 + random() * 5
      out.data[index + 2] = 227 + random() * 5
    }
  }
  return out
}

describe('the corner scan and shaped badges', () => {
  it('proposes nothing for a shaped badge sitting in a corner', () => {
    // The limitation, stated. estimateOverlay's statistic is a mean squared
    // neighbour difference; a glyph adds more of those along its own edges than
    // the blend removes, so the scan built on it reads an unmarked corner.
    const { marked } = shapedBadge(scene(), CORNER, { halo: true })

    expect(estimateOverlay(marked, CORNER)).toBeUndefined()
    expect(findCornerOverlays(marked).filter((e) => overlapping(e.rect, CORNER))).toEqual([])
  })

  it('finds the same badge the moment the region is selected by hand', () => {
    // Which is why the UI says so. The capability exists; only the automatic
    // proposal does not.
    const { marked } = shapedBadge(scene(), CORNER, { halo: true })
    const shaped = estimateShaped(marked, CORNER)

    expect(shaped).toBeDefined()
    expect(shaped?.alpha).toBeGreaterThan(0.7)
    expect(shaped?.confidence).toBeGreaterThan(0.6)
  })

  it('cannot tell a real badge from an ordinary bright object in the same corner', () => {
    // The reason the scan was not wired to estimateShaped. A white sign in a
    // corner is, to a detail-ratio model given one image, indistinguishable
    // from a near-opaque light overlay: little local detail, a near-uniform
    // light colour, hard edges, and three channels that agree. There is no
    // information in a single frame separating "white thing photographed" from
    // "white thing composited", so no threshold on these numbers can either.
    const base = lowTexture()
    const object = estimateShaped(brightObject(base, CORNER), CORNER)
    const badge = estimateShaped(shapedBadge(base, CORNER).marked, CORNER)

    expect(object).toBeDefined()
    expect(badge).toBeDefined()
    if (!object || !badge) return

    expect(Math.abs(object.alpha - badge.alpha)).toBeLessThan(0.05)
    expect(Math.abs(object.confidence - badge.confidence)).toBeLessThan(0.15)
  })

  it('fires on every corner candidate over that object, where the flat scan fires on none', () => {
    // What the user would actually see: four confident proposals pointing at a
    // road sign. An empty list plus "select it by hand" is better than a list
    // whose wrong entries look exactly like its right ones — clicking one and
    // unblending damages the picture.
    const object = brightObject(lowTexture(), CORNER)

    expect(findCornerOverlays(object)).toEqual([])
    const wouldPropose = cornerCandidates(object)
      .map((rect) => estimateShaped(object, rect))
      .filter((estimate) => estimate !== undefined)

    expect(wouldPropose.length).toBeGreaterThanOrEqual(4)
    expect(Math.max(...wouldPropose.map((e) => e.confidence))).toBeGreaterThan(0.9)
  })
})
