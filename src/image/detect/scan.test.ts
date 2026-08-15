import { describe, expect, it } from 'vitest'
import { blend, estimateOverlay, refineRect, type OverlayCandidate, type Rect } from './overlay.ts'
import {
  findOverlays,
  mergeCandidates,
  proxyFactor,
  scanCorners,
  shrink,
  wideCandidates,
} from './scan.ts'
import { at, createRaster, xorshift, type Raster } from '../raster.ts'

/** A textured picture, deterministic so an assertion means something. */
function photograph(width: number, height: number, seed = 7): Raster {
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

/** A region with almost no texture, the way sky or an out-of-focus wall reads. */
function smoothPatch(base: Raster, rect: Rect): Raster {
  const out = { ...base, data: new Uint8ClampedArray(base.data) }
  const random = xorshift(3)
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = at(out, x, y)
      out.data[index] = 196 + random() * 2
      out.data[index + 1] = 206 + random() * 2
      out.data[index + 2] = 226 + random() * 2
    }
  }
  return out
}

const covers = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('shrink', () => {
  it('averages each block rather than dropping pixels', () => {
    const raster = createRaster(2, 2)
    raster.data.set([0, 0, 0, 255, 100, 100, 100, 255, 100, 100, 100, 255, 200, 200, 200, 255])

    const small = shrink(raster, 2)
    expect(small.width).toBe(1)
    expect(small.height).toBe(1)
    expect(small.data[0]).toBe(100)
  })

  it('returns the picture itself when there is nothing to shrink', () => {
    const raster = photograph(64, 64)
    expect(shrink(raster, 1)).toBe(raster)
  })

  it('preserves the alpha a blend was measured through', () => {
    // The claim the whole proxy rests on: a box average is linear and the
    // composite is affine, so `shrink(aC + (1-a)I) = aC + (1-a)shrink(I)` and
    // the estimator reads the same alpha off either one. Lanczos would blur
    // across the region's edge; a box average inside it does not.
    const rect: Rect = { x: 128, y: 128, width: 192, height: 192 }
    const marked = blend(photograph(512, 512), rect, 0.4, [255, 255, 255])

    const full = estimateOverlay(marked, rect)
    const small = estimateOverlay(shrink(marked, 2), {
      x: rect.x / 2,
      y: rect.y / 2,
      width: rect.width / 2,
      height: rect.height / 2,
    })

    expect(full?.alpha).toBeCloseTo(0.4, 1)
    expect(small?.alpha).toBeCloseTo(full?.alpha ?? 0, 1)
  })
})

describe('proxyFactor', () => {
  it('leaves a small picture alone', () => {
    expect(proxyFactor(createRaster(800, 600))).toBe(1)
  })

  it('shrinks a large one to roughly a thousand pixels on its long edge', () => {
    const factor = proxyFactor(createRaster(4000, 3000))
    expect(4000 / factor).toBeLessThan(1400)
    expect(4000 / factor).toBeGreaterThan(700)
  })
})

describe('wideCandidates', () => {
  const raster = createRaster(1000, 800)
  const probes = wideCandidates(raster)

  it('proposes bands that span the frame', () => {
    // The shape the corner scan structurally cannot express: a caption scrim is
    // full width, and no corner rectangle is.
    const full = probes.filter((probe) => probe.rect.width === 1000 && probe.source === 'band')
    expect(full.length).toBeGreaterThan(0)
    expect(probes.some((probe) => probe.rect.height === 800 && probe.source === 'band')).toBe(true)
  })

  it('lets a band refine only across its thickness', () => {
    // Otherwise refineRect snaps a full-width band down to a fragment of it.
    for (const probe of probes.filter((p) => p.source === 'band')) {
      expect(probe.axes).not.toBe('both')
    }
  })

  it('steps bands by half their thickness, so one lands inside a band', () => {
    // The bug this pins: laid end to end, every probe over a band straddles one
    // of its edges, and the step at that edge is the largest neighbour
    // difference in the region — so the detail energy inside reads as high as
    // the ring's and the estimator reports no overlay. Measured on a 60px scrim
    // across a 420px picture: fifteen band probes, none of them a hit. What the
    // scan needs is one probe wholly inside the band, which refineRect then
    // grows back out to the real edges.
    const band = { y: 350, height: 60 }
    const inside = wideCandidates(createRaster(420, 420)).filter(
      (probe) =>
        probe.axes === 'vertical' &&
        probe.rect.y >= band.y &&
        probe.rect.y + probe.rect.height <= band.y + band.height,
    )
    expect(inside.length).toBeGreaterThan(0)
  })

  it('proposes a centred rectangle', () => {
    const centre = probes.filter((probe) => probe.source === 'centre')
    expect(centre.length).toBeGreaterThan(0)
    for (const probe of centre) {
      expect(probe.rect.x + probe.rect.width / 2).toBeCloseTo(500, 0)
    }
  })

  it('covers every pixel with at least one probe', () => {
    // A scan with a blind stripe down it is worse than one that says it only
    // looked at the corners.
    for (const point of [
      { x: 5, y: 5 },
      { x: 995, y: 5 },
      { x: 5, y: 795 },
      { x: 995, y: 795 },
      { x: 500, y: 400 },
    ]) {
      const dot = { ...point, width: 1, height: 1 }
      expect(probes.some((probe) => covers(probe.rect, dot))).toBe(true)
    }
  })

  it('keeps every probe inside the picture', () => {
    for (const probe of probes) {
      expect(probe.rect.x).toBeGreaterThanOrEqual(0)
      expect(probe.rect.y).toBeGreaterThanOrEqual(0)
      expect(probe.rect.x + probe.rect.width).toBeLessThanOrEqual(1000)
      expect(probe.rect.y + probe.rect.height).toBeLessThanOrEqual(800)
    }
  })

  it('proposes nothing at all for a picture too small to probe', () => {
    expect(wideCandidates(createRaster(20, 20))).toHaveLength(0)
  })
})

describe('refineRect on one axis', () => {
  it('keeps a full-width band full width', () => {
    // Measured: the walk is capped at 1.6x the longest side, so a square probe
    // on a wide band refines to a fragment of it. Refining the free axis only
    // is what makes a band survive its own measurement.
    const band: Rect = { x: 0, y: 300, width: 512, height: 64 }
    const marked = blend(photograph(512, 512), band, 0.35, [255, 255, 255])

    const kept = refineRect(marked, band, 'vertical')
    expect(kept.x).toBe(0)
    expect(kept.width).toBe(512)
  })

  it('keeps a full-height band full height', () => {
    const band: Rect = { x: 300, y: 0, width: 64, height: 512 }
    const marked = blend(photograph(512, 512), band, 0.35, [255, 255, 255])

    const kept = refineRect(marked, band, 'horizontal')
    expect(kept.y).toBe(0)
    expect(kept.height).toBe(512)
  })
})

describe('mergeCandidates', () => {
  const fake = (rect: Rect, confidence: number): OverlayCandidate => ({
    rect,
    alpha: 0.5,
    color: [255, 255, 255],
    confidence,
    kind: 'flat',
    source: 'grid',
  })

  it('collapses a scale pyramid over one mark', () => {
    // The fragments of one band, probed at several sizes. Their IoU against the
    // largest is well under any sane threshold; their containment in it is 1.
    // Containment is the predicate that folds them.
    const whole = fake({ x: 0, y: 300, width: 512, height: 64 }, 0.95)
    const fragments = [
      fake({ x: 20, y: 305, width: 90, height: 50 }, 0.7),
      fake({ x: 200, y: 302, width: 120, height: 58 }, 0.72),
    ]

    expect(mergeCandidates([whole, ...fragments])).toEqual([whole])
  })

  it('keeps two genuinely separate marks separate', () => {
    // What IoU alone is for: the tiles of a repeating watermark are the same
    // size and near each other, and folding them would report one mark.
    const left = fake({ x: 20, y: 20, width: 80, height: 80 }, 0.9)
    const right = fake({ x: 300, y: 20, width: 80, height: 80 }, 0.88)
    expect(mergeCandidates([left, right])).toHaveLength(2)
  })

  it('keeps the strongest description of a region, not the first', () => {
    const weak = fake({ x: 0, y: 300, width: 512, height: 64 }, 0.6)
    const strong = fake({ x: 0, y: 302, width: 512, height: 60 }, 0.95)
    expect(mergeCandidates([weak, strong])).toEqual([strong])
  })

  it('keeps the exactly-invertible description when two models describe one region', () => {
    // Score does not decide this one, and must not. A flat candidate is the
    // case whose inverse is exact; a shaped one is the median-based fallback
    // that coverage.ts records cannot tell a badge from a road sign. Ranking
    // the two together by confidence * alpha lets the second win a region the
    // first already describes — and then `findOverlays` emitted both, so one
    // set of pixels appeared twice under two different opacities and ticking
    // both handed `disjoint` a pair it silently halved.
    const flat = { ...fake({ x: 0, y: 300, width: 512, height: 64 }, 0.7), alpha: 0.4 }
    const shaped = {
      ...fake({ x: 4, y: 302, width: 500, height: 60 }, 0.99),
      alpha: 0.9,
      kind: 'shaped' as const,
    }

    expect(shaped.confidence * shaped.alpha).toBeGreaterThan(flat.confidence * flat.alpha)
    expect(mergeCandidates([shaped, flat])).toEqual([flat])
  })
})

describe('findOverlays', () => {
  it('finds a full-width band as a band, where the corner scan finds a corner of one', () => {
    // The headline case, and the reason the wide scan exists. The corner scan
    // is not blind here — a bottom corner probe lands on the band's left or
    // right end — but what it reports is that end, a couple of hundred pixels
    // of a mark that is 512 wide. Unblending that leaves the rest of the band
    // tinted, which looks worse than leaving all of it alone.
    const band: Rect = { x: 0, y: 380, width: 512, height: 72 }
    const marked = blend(photograph(512, 512), band, 0.38, [255, 255, 255])

    const corner = scanCorners(marked).find((found) => covers(found.rect, band))
    expect(corner === undefined || corner.rect.width < 400).toBe(true)

    // The whole band, at its real edges, and only once: the grid probes see the
    // left and right halves of it separately, and containment folds them into
    // the band that swallows both.
    const wide = findOverlays(marked, { wide: true, shaped: false }).filter((found) =>
      covers(found.rect, band),
    )
    expect(wide).toHaveLength(1)
    expect(wide[0]?.rect).toEqual(band)
    expect(wide[0]?.alpha).toBeCloseTo(0.38, 1)
    expect(wide[0]?.source).toBe('band')
  })

  it('covers the whole width when the proxy factor does not divide it', () => {
    // The coarse pass searches a shrunken copy and `shrink` floors: 2201 at
    // factor 2 is a 1100-wide proxy, and multiplying back gives 2200. A band
    // proposes its own full width and `axes: 'vertical'` freezes that extent on
    // purpose, so refineRect never recovers the difference — the last column of
    // a full-width scrim came back still marked. One white column down the side
    // of a photograph is as visible as anything this removes.
    //
    // Large on purpose: the shortfall only exists once the picture is big
    // enough to be searched on a proxy at all, which is 1100px on the long edge.
    const width = 2201
    const band: Rect = { x: 0, y: 904, width, height: 96 }
    const marked = blend(photograph(width, 1200, 5), band, 0.4, [255, 255, 255])

    const found = findOverlays(marked, { wide: true, shaped: false }).find(
      (candidate) => candidate.source === 'band',
    )
    expect(found).toBeDefined()
    expect(found?.rect).toEqual(band)
  })

  it('finds a mark in the middle of the picture', () => {
    const centre: Rect = { x: 176, y: 176, width: 160, height: 160 }
    const marked = blend(photograph(512, 512), centre, 0.4, [255, 255, 255])

    const wide = findOverlays(marked, { wide: true, shaped: false })
    expect(wide.some((found) => covers(found.rect, centre))).toBe(true)
  })

  it('finds nothing in an unmarked photograph', () => {
    // The most important negative in this file. A scan that invents overlays in
    // a clean picture is worse than no scan, because every later reading is
    // measured against a list the reader now half believes.
    expect(findOverlays(photograph(512, 512), { wide: true, shaped: false })).toHaveLength(0)
  })

  it('finds nothing in a picture with no texture anywhere', () => {
    const flat = createRaster(512, 512)
    flat.data.fill(128)
    for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255

    expect(findOverlays(flat, { wide: true, shaped: false })).toHaveLength(0)
  })

  it('reports progress that rises to one', () => {
    const seen: number[] = []
    findOverlays(
      photograph(512, 512),
      { wide: true, shaped: false },
      {
        onProgress: (fraction) => seen.push(fraction),
      },
    )

    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBeCloseTo(1, 5)
    for (const fraction of seen) {
      expect(fraction).toBeGreaterThan(0)
      expect(fraction).toBeLessThanOrEqual(1)
    }
  })

  it('lists every flat candidate before any shaped one', () => {
    // Not cosmetic. The flat tier finds nothing in a clean photograph; the
    // shaped tier cannot tell a badge from a road sign. Sorting the two
    // together by score would hide the only distinction that matters.
    const marked = blend(
      photograph(512, 512),
      { x: 0, y: 380, width: 512, height: 72 },
      0.38,
      [255, 255, 255],
    )
    const found = findOverlays(marked, { wide: true, shaped: true })

    const firstShaped = found.findIndex((candidate) => candidate.kind === 'shaped')
    const lastFlat = found.map((candidate) => candidate.kind).lastIndexOf('flat')
    if (firstShaped >= 0 && lastFlat >= 0) expect(firstShaped).toBeGreaterThan(lastFlat)
  })

  it('does not describe the same region twice, once each way', () => {
    const marked = blend(
      photograph(512, 512),
      { x: 0, y: 380, width: 512, height: 72 },
      0.38,
      [255, 255, 255],
    )
    const found = findOverlays(marked, { wide: true, shaped: true })

    for (const shaped of found.filter((candidate) => candidate.kind === 'shaped')) {
      for (const flat of found.filter((candidate) => candidate.kind === 'flat')) {
        expect(covers(shaped.rect, flat.rect)).toBe(false)
      }
    }
  })
})

describe('what the wide scan gets wrong', () => {
  // Recorded rather than argued, in the manner of coverage.test.ts. The flat
  // model assumes the picture under an overlay is about as detailed as its
  // surroundings; a smooth region breaks that assumption in the direction that
  // looks exactly like a strong overlay. A boundary-step consistency gate was
  // built and measured against this, and it dies as soon as refineRect snaps
  // the probe onto the smooth patch's own edge.
  //
  // This is why the wide scan is a button rather than an automatic pass, why
  // nothing it proposes is ticked by default, and why the panel says out loud
  // that a patch of sky reads like a scrim.

  const sky: Rect = { x: 64, y: 64, width: 200, height: 160 }

  it('proposes a patch of smooth sky as though it were an overlay', () => {
    const found = findOverlays(smoothPatch(photograph(512, 512), sky), {
      wide: true,
      shaped: false,
    })
    expect(found.some((candidate) => covers(candidate.rect, sky))).toBe(true)
  })

  it('is as sure of the sky as it is of a real mark', () => {
    // The number that kills every gate: the false reading is not weaker than
    // the true one, so no threshold on confidence separates them.
    const sure = (raster: Raster, region: Rect) => {
      const found = findOverlays(raster, { wide: true, shaped: false })
      const hit = found.find((candidate) => covers(candidate.rect, region))
      return hit?.confidence ?? 0
    }

    const band: Rect = { x: 0, y: 380, width: 512, height: 72 }
    const real = sure(blend(photograph(512, 512), band, 0.38, [255, 255, 255]), band)
    const false_ = sure(smoothPatch(photograph(512, 512), sky), sky)

    expect(real).toBeGreaterThan(0.6)
    expect(false_).toBeGreaterThan(real * 0.8)
  })
})
