import { describe, expect, it } from 'vitest'
import {
  auroc,
  bootstrapInterval,
  fitLogistic,
  fitThresholds,
  fitWeights,
  mulberry32,
  splitOf,
  tprAtFpr,
} from './evaluate.ts'

describe('auroc', () => {
  it('is 1 when every positive outranks every negative, 0.5 when they tie', () => {
    expect(auroc([0.9, 0.8], [0.1, 0.2])).toBe(1)
    expect(auroc([0.5, 0.5], [0.5, 0.5])).toBe(0.5)
    expect(auroc([0.1], [0.9])).toBe(0)
  })

  it('counts a tie as half', () => {
    expect(auroc([0.5, 0.9], [0.5, 0.1])).toBeCloseTo(0.875)
  })
})

describe('tprAtFpr', () => {
  it('finds the share of positives above the threshold that keeps false positives in budget', () => {
    const negatives = Array.from({ length: 100 }, (_, i) => i / 100)
    const positives = [0.995, 0.999, 0.5, 0.2]
    const { tpr, threshold } = tprAtFpr(positives, negatives, 0.01)
    expect(threshold).toBeGreaterThan(0.98)
    expect(tpr).toBe(0.5)
  })
})

describe('bootstrapInterval', () => {
  it('is deterministic for a seed and brackets the point estimate', () => {
    const pos = [0.9, 0.8, 0.7, 0.4, 0.95, 0.6]
    const neg = [0.1, 0.3, 0.5, 0.2, 0.45, 0.35]
    const a = bootstrapInterval(pos, neg, auroc, { rounds: 300, seed: 42 })
    const b = bootstrapInterval(pos, neg, auroc, { rounds: 300, seed: 42 })
    expect(a).toEqual(b)
    expect(a[0]).toBeLessThanOrEqual(auroc(pos, neg))
    expect(a[1]).toBeGreaterThanOrEqual(auroc(pos, neg))
  })
})

describe('mulberry32', () => {
  it('repeats its sequence for a seed', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('fitLogistic', () => {
  it('learns a positive weight for a feature that separates the classes', () => {
    const x = [
      [0.9, 0.5],
      [0.8, 0.4],
      [0.85, 0.6],
      [0.1, 0.5],
      [0.2, 0.6],
      [0.15, 0.4],
    ]
    const y = [1, 1, 1, 0, 0, 0]
    const { coefficients } = fitLogistic(x, y)
    expect(coefficients[0]).toBeGreaterThan(1)
    expect(Math.abs(coefficients[1] as number)).toBeLessThan(coefficients[0] as number)
  })
})

describe('fitWeights', () => {
  it('turns coefficients into non-negative weights summing to one', () => {
    const weights = fitWeights([2, -1, 1, 0])
    expect(weights).toEqual([2 / 3, 0, 1 / 3, 0])
  })

  it('falls back to equal weights when nothing is positive', () => {
    expect(fitWeights([-1, 0])).toEqual([0.5, 0.5])
  })
})

describe('fitThresholds', () => {
  it('sets the AI threshold where at most 1 % of human texts reach it, never below 0.5', () => {
    const human = Array.from({ length: 200 }, (_, i) => i / 400) // 0 … 0.4975
    const ai = Array.from({ length: 100 }, (_, i) => 0.3 + i / 200)
    const { ai: tAi, human: tHuman } = fitThresholds(human, ai)
    expect(tAi).toBeGreaterThanOrEqual(0.5)
    expect(human.filter((s) => s >= tAi).length / human.length).toBeLessThanOrEqual(0.01)
    expect(ai.filter((s) => s < tHuman).length / ai.length).toBeLessThanOrEqual(0.05)
    expect(tHuman).toBeLessThanOrEqual(tAi)
  })
})

describe('splitOf', () => {
  it('assigns a stable split from the id alone, about half each', () => {
    expect(splitOf('doc-1')).toBe(splitOf('doc-1'))
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`)
    const train = ids.filter((id) => splitOf(id) === 'train').length
    expect(train).toBeGreaterThan(400)
    expect(train).toBeLessThan(600)
  })
})
