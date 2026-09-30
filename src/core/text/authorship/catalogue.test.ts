import { describe, expect, it } from 'vitest'
import { CATALOGUE, matchesOf } from './catalogue/index.ts'
import { FR_TRAPS } from './catalogue/fr.traps.ts'

// Every entry, walked. A pattern that no longer matches its own sample has
// drifted; one that matches its own trap fires on the legitimate use it was
// written to leave alone. Both are silent in production, so both are checked
// here for every entry rather than in a handful of hand-picked tests.

describe('catalogue', () => {
  it('has entries', () => {
    expect(CATALOGUE.length).toBeGreaterThan(50)
  })

  it('gives every entry a unique id in the lang.category.name shape', () => {
    const ids = CATALOGUE.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^(?:fr|en|any)\.[a-z]+\.[a-z0-9_]+$/)
  })

  it('writes a reason and a fix for every entry', () => {
    for (const entry of CATALOGUE) {
      expect(entry.reason.length, entry.id).toBeGreaterThan(10)
      expect(entry.fixHint.length, entry.id).toBeGreaterThan(5)
    }
  })

  it('matches every sample', () => {
    for (const entry of CATALOGUE) {
      expect(entry.samples.length, entry.id).toBeGreaterThan(0)
      for (const sample of entry.samples) {
        expect(matchesOf(entry, sample).length, `${entry.id} should match "${sample}"`).toBe(1)
      }
    }
  })

  it('matches no trap', () => {
    for (const entry of CATALOGUE) {
      for (const trap of entry.traps) {
        expect(matchesOf(entry, trap), `${entry.id} must not match "${trap}"`).toEqual([])
      }
    }
  })

  it('uses only global patterns with bounded wildcards', () => {
    // An unbounded `.*` or `[^.]+` between two alternatives is how a regex
    // backtracks for minutes on one long line. Every wildcard is bounded.
    const unbounded = /(?<!\\)\.(?:[*+]|\{\d+,\})|\[\^[^\]]*\](?:[*+]|\{\d+,\})/
    for (const entry of CATALOGUE) {
      expect(entry.pattern.flags, entry.id).toContain('g')
      expect(unbounded.test(entry.pattern.source), `${entry.id}: ${entry.pattern.source}`).toBe(
        false,
      )
    }
  })

  it('has French entries in every tier', () => {
    const tiers = new Set(CATALOGUE.filter((e) => e.id.startsWith('fr.')).map((e) => e.tier))
    expect(tiers).toEqual(new Set([1, 2, 3]))
  })

  it('finds no tier-1 habit in legitimate administrative or academic French', () => {
    const strong = CATALOGUE.filter((e) => e.tier === 1 && e.lang !== 'en')
    for (const { register, text } of FR_TRAPS) {
      const hits = strong.flatMap((entry) =>
        matchesOf(entry, text).map((m) => `${entry.id}: ${text.slice(m.start, m.end)}`),
      )
      expect(hits, register).toEqual([])
    }
  })

  it('never uses the ASCII-only \\b in a French pattern', () => {
    for (const entry of CATALOGUE.filter((e) => e.lang === 'fr')) {
      expect(entry.pattern.source.includes(String.raw`\b`), entry.id).toBe(false)
    }
  })
})
