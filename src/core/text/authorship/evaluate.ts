// The arithmetic of the evaluation, kept apart from its file handling.
//
// scripts/eval-authorship.mjs reads corpora and writes reports; the test suite
// replays the committed subset. Both need the same AUROC, the same bootstrap
// and the same threshold rule, so they live here, pure and seeded: an
// evaluation that gives a different number on every run is not measuring the
// detector.
//
// The protocol follows binoculars-eu (Apache-2.0): a frozen corpus, a fixed
// split, AUROC with bootstrap intervals, and the true-positive rate at a false
// positive rate a person could live with — 1 %, not the accuracy at 50 %.

/** Probability that a random positive outranks a random negative; ties count half. */
export function auroc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) return Number.NaN
  // Rank-sum form: sort once rather than compare every pair.
  const all = [
    ...positives.map((score) => ({ score, positive: true })),
    ...negatives.map((score) => ({ score, positive: false })),
  ].sort((a, b) => a.score - b.score)

  let rankSum = 0
  for (let at = 0; at < all.length;) {
    let end = at
    while (end < all.length && all[end]?.score === all[at]?.score) end += 1
    const rank = (at + 1 + end) / 2 // average rank of the tied run, 1-based
    for (let k = at; k < end; k += 1) if (all[k]?.positive) rankSum += rank
    at = end
  }
  const n = positives.length
  return (rankSum - (n * (n + 1)) / 2) / (n * negatives.length)
}

/**
 * The true-positive rate at the lowest threshold that keeps the false-positive
 * rate within `fpr`. A score at or above the threshold is called positive.
 */
export function tprAtFpr(
  positives: readonly number[],
  negatives: readonly number[],
  fpr: number,
): { threshold: number; tpr: number; fpr: number } {
  const candidates = [...new Set([...positives, ...negatives])].sort((a, b) => a - b)
  candidates.push(Number.POSITIVE_INFINITY)
  for (const threshold of candidates) {
    const falsePositive = negatives.filter((s) => s >= threshold).length / negatives.length
    if (falsePositive <= fpr) {
      return {
        threshold,
        tpr: positives.filter((s) => s >= threshold).length / positives.length,
        fpr: falsePositive,
      }
    }
  }
  return { threshold: Number.POSITIVE_INFINITY, tpr: 0, fpr: 0 }
}

/** A small seeded generator: the same seed, the same resamples, the same interval. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A 95 % percentile bootstrap interval, positives and negatives resampled apart. */
export function bootstrapInterval(
  positives: readonly number[],
  negatives: readonly number[],
  statistic: (p: readonly number[], n: readonly number[]) => number,
  { rounds = 1000, seed = 42 }: { rounds?: number; seed?: number } = {},
): [number, number] {
  if (positives.length === 0 || negatives.length === 0) return [Number.NaN, Number.NaN]
  const random = mulberry32(seed)
  const draw = (values: readonly number[]) =>
    values.map(() => values[Math.floor(random() * values.length)] as number)
  const stats: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    stats.push(statistic(draw(positives), draw(negatives)))
  }
  stats.sort((a, b) => a - b)
  const at = (q: number) =>
    stats[Math.min(stats.length - 1, Math.floor(q * stats.length))] as number
  return [at(0.025), at(0.975)]
}

/**
 * Logistic regression by gradient descent, lightly regularised.
 *
 * No dependency and no cleverness: a handful of features and a few hundred
 * documents, where plain batch descent converges well inside a second.
 */
export function fitLogistic(
  x: readonly (readonly number[])[],
  y: readonly number[],
  { iterations = 4000, rate = 0.5, l2 = 0.001 } = {},
): { coefficients: number[]; intercept: number } {
  const features = x[0]?.length ?? 0
  const coefficients: number[] = Array.from({ length: features }, () => 0)
  let intercept = 0
  const n = x.length
  for (let step = 0; step < iterations; step += 1) {
    const gradient: number[] = Array.from({ length: features }, () => 0)
    let gradientIntercept = 0
    for (let i = 0; i < n; i += 1) {
      const row = x[i] as readonly number[]
      let z = intercept
      for (let j = 0; j < features; j += 1) z += (coefficients[j] as number) * (row[j] as number)
      const error = 1 / (1 + Math.exp(-z)) - (y[i] as number)
      for (let j = 0; j < features; j += 1)
        gradient[j] = (gradient[j] as number) + error * (row[j] as number)
      gradientIntercept += error
    }
    for (let j = 0; j < features; j += 1) {
      coefficients[j] =
        (coefficients[j] as number) -
        rate * ((gradient[j] as number) / n + l2 * (coefficients[j] as number))
    }
    intercept -= rate * (gradientIntercept / n)
  }
  return { coefficients, intercept }
}

/**
 * Weights for the weighted mean, from fitted coefficients.
 *
 * A negative coefficient says the signal points the wrong way on this corpus;
 * the mean has no way to use that honestly, so it gets no weight rather than
 * an inverted one.
 */
export function fitWeights(coefficients: readonly number[]): number[] {
  const positive = coefficients.map((c) => Math.max(0, c))
  const total = positive.reduce((a, b) => a + b, 0)
  if (total === 0) return coefficients.map(() => 1 / coefficients.length)
  return positive.map((c) => c / total)
}

/** The AI threshold may never sit below this, whatever the corpus says. */
export const AI_FLOOR = 0.5

/**
 * Thresholds from training scores.
 *
 *   ai     the lowest score reached by at most 1 % of human texts, never below
 *          0.5: `likely_ai` is a claim, and its false-positive rate is the one
 *          that matters.
 *   human  the highest score under which at most 5 % of generated texts fall,
 *          and never above `ai`.
 */
export function fitThresholds(
  human: readonly number[],
  ai: readonly number[],
  { humanFpr = 0.01, aiBelow = 0.05 } = {},
): { human: number; ai: number } {
  const round = (value: number) => Math.round(value * 1000) / 1000
  const aiThreshold = Math.max(AI_FLOOR, tprAtFpr(ai, human, humanFpr).threshold)
  const tAi = Number.isFinite(aiThreshold) ? aiThreshold : 1

  const sorted = [...ai].sort((a, b) => a - b)
  const allowed = Math.floor(aiBelow * sorted.length)
  // The lowest AI score above the allowed tail: everything strictly below it
  // is at most `allowed` documents.
  const tHuman = sorted.length === 0 ? 0 : (sorted[allowed] ?? sorted.at(-1) ?? 0)
  return { human: round(Math.min(tHuman, tAi)), ai: round(tAi) }
}

/** FNV-1a: a stable 32-bit hash with no dependency on `node:crypto`. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A document's split, from its id alone, so it never moves between runs. */
export const splitOf = (id: string): 'train' | 'test' => (fnv1a(id) % 2 === 0 ? 'train' : 'test')
