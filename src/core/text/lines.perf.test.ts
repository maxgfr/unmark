import { describe, expect, it } from 'vitest'
import { lineIndex } from './lines.ts'

// Timing budgets, run on their own by `pnpm test:perf` so the parallel suite's
// contention cannot make them flaky.

describe('lineIndex performance', () => {
  it('finds a column deep in one very long line quickly', () => {
    // One megabyte with no newline: counting code points from the start of the
    // line on every lookup is quadratic, and a report locates thousands.
    const text = `${'a\u{1F600}'.repeat(10)}${'x'.repeat(1_000_000)}`
    const at = lineIndex(text)
    const started = performance.now()
    for (let i = 0; i < 20_000; i += 1) at.locate(text.length - i)
    expect(performance.now() - started).toBeLessThan(200)
    expect(at.locate(30)).toEqual({ line: 1, col: 21 })
  })

  it('finds the line of an offset deep in a long text quickly', () => {
    const text = 'line\n'.repeat(200_000)
    const at = lineIndex(text)
    const started = performance.now()
    for (let i = 0; i < 10_000; i += 1) at.locate(i * 97)
    expect(performance.now() - started).toBeLessThan(200)
    expect(at.locate(5 * 150_000).line).toBe(150_001)
  })
})
