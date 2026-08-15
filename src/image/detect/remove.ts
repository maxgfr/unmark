// Undoing overlays: one, or all of them at once.
//
// The single-region router used to be four lines inside ImageTab, which was
// fine while removal was one rectangle at a time. Batch removal needs exactly
// the same decision, and a second copy of "when is the flat inverse exact" is
// how the button and the batch come to disagree about the same picture.
//
// Two properties this file exists to hold, both of them arithmetic rather than
// interface:
//
//   Every estimate is measured against the picture as it was found. An overlay
//   estimate is a statement about a composite — `observed = aC + (1-a)I` — so
//   the raster it is measured from has to be the marked one. Re-estimating
//   between removals is not "more up to date", it is measuring a region whose
//   control ring is now half recovered original and half still-marked
//   composite, which is a mixture the model does not describe.
//
//   Nothing is inverted twice. The inverse is not idempotent: applying it again
//   gives `(I - aC)/(1 - a)`, off by `a(I - C)/(1 - a)`. At alpha 0.4 under a
//   white mark over mid-grey picture that is a hundred levels — worse than the
//   mark was. `disjoint` is what stops a batch from doing it.

import { cloneRaster, type Raster } from '../raster.ts'
import { coverageMap, unblendVaryingInto, type CoverageMap } from './coverage.ts'
import { intersectionArea, unblendInto, type OverlayCandidate } from './overlay.ts'

/**
 * Above this the flat inverse is used as it stands.
 *
 * A region the flat estimator is confident about is exactly the case its
 * inverse is exact for, and a coverage map over it can only add measurement
 * noise — about two levels of it. Anything else goes through the map, where a
 * single alpha is worth thirty.
 */
const EXACT_CONFIDENCE = 0.7

/**
 * What will be done to one region, decided but not yet done.
 *
 * The coverage map is the expensive half and it has to be built from the
 * untouched raster, so planning and applying are separate steps rather than one
 * function called in a loop.
 */
export interface Removal {
  candidate: OverlayCandidate
  /** Absent for the flat case, where one alpha describes the whole rectangle. */
  coverage: CoverageMap | undefined
}

/** Decide which inverse fits a region, and measure whatever it needs. */
export function planRemoval(raster: Raster, candidate: OverlayCandidate): Removal {
  const exact = candidate.kind === 'flat' && candidate.confidence >= EXACT_CONFIDENCE
  return {
    candidate,
    coverage: exact ? undefined : coverageMap(raster, candidate.rect, candidate.color),
  }
}

/** Carry out a planned removal, writing into a raster the caller owns. */
export function applyRemoval(out: Raster, removal: Removal): void {
  if (removal.coverage) {
    unblendVaryingInto(out, removal.candidate, removal.coverage)
    return
  }
  unblendInto(out, removal.candidate)
}

/** Undo one overlay, by whichever inverse fits it. */
export function removeOverlay(raster: Raster, candidate: OverlayCandidate): Raster {
  const out = cloneRaster(raster)
  applyRemoval(out, planRemoval(raster, candidate))
  return out
}

/**
 * The strongest pairwise non-overlapping subset, best first.
 *
 * What a batch is allowed to touch. Two candidates that share a pixel would
 * have that pixel inverted twice, and the header says what that costs. The
 * weaker of an overlapping pair is dropped rather than trimmed: half a
 * rectangle is not a region anything measured.
 */
export function disjoint(candidates: readonly OverlayCandidate[]): OverlayCandidate[] {
  const ranked = [...candidates].sort((a, b) => b.confidence * b.alpha - a.confidence * a.alpha)
  const kept: OverlayCandidate[] = []

  for (const candidate of ranked) {
    if (kept.some((other) => intersectionArea(candidate.rect, other.rect) > 0)) continue
    kept.push(candidate)
  }
  return kept
}

/**
 * Undo every overlay in one pass, against the picture as it was found.
 *
 * One clone, not one per candidate: each is 48 MB on a 12-megapixel photo, and
 * eight of them is the entire undo history spent inside a single operation.
 * Measuring first and applying second is also what makes the result
 * order-independent, which is what makes collapsing N removals into one undo
 * step honest rather than merely convenient.
 *
 * The caller is expected to have passed the list through `disjoint`. This does
 * not do it itself: silently dropping a region the user ticked would be the
 * interface deciding something it was not asked to decide.
 */
export function removeAll(
  raster: Raster,
  candidates: readonly OverlayCandidate[],
  options: { onProgress?: (fraction: number) => void } = {},
): Raster {
  const out = cloneRaster(raster)
  if (candidates.length === 0) return out

  candidates.forEach((candidate, index) => {
    applyRemoval(out, planRemoval(raster, candidate))
    options.onProgress?.((index + 1) / candidates.length)
  })
  return out
}
