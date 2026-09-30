import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectAuthorship, weightedScore } from '../core/text/authorship/index.ts'
import { CALIBRATION } from '../core/text/authorship/calibration.ts'
import { auroc } from '../core/text/authorship/evaluate.ts'

// The committed corpus, replayed on every test run.
//
// scripts/eval-authorship.mjs is where the numbers are measured and written
// down; this is what stops them sliding afterwards. A catalogue entry that
// starts firing on administrative French, or a refactor that shifts every
// score, shows up here as a red test rather than as a worse report nobody
// re-ran.

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'authorship')

interface Entry {
  id: string
  path: string
  label: string
  lang: string
  genre: string
  split: string
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  documents: Entry[]
}
const baseline = JSON.parse(readFileSync(join(ROOT, 'baseline.json'), 'utf8')) as {
  calibration: string
  testAuroc: number
}

const run = () =>
  manifest.documents.map((doc) => {
    const text = readFileSync(join(ROOT, doc.path), 'utf8')
    const report = detectAuthorship(text, {
      format: doc.path.endsWith('.md') ? 'Markdown' : 'Text',
    })
    const residue = report.findings.some((f) => f.category === 'residue')
    return {
      doc,
      report,
      score: weightedScore(report.signals, residue, CALIBRATION.thresholds.ai),
    }
  })

const results = run()

describe('the committed authorship corpus', () => {
  it('was measured with the calibration that ships', () => {
    expect(baseline.calibration).toBe(CALIBRATION.id)
  })

  it('separates generated from human text at least as well as when it was measured', () => {
    const test = results.filter((r) => r.doc.split === 'test')
    const ai = test.filter((r) => r.doc.label === 'ai').map((r) => r.score)
    const human = test.filter((r) => r.doc.label === 'human').map((r) => r.score)
    expect(auroc(ai, human)).toBeGreaterThanOrEqual(baseline.testAuroc - 0.05)
  })

  it('calls no human document likely_ai, in either split', () => {
    const accused = results
      .filter((r) => r.doc.label === 'human' && r.report.verdict === 'likely_ai')
      .map((r) => `${r.doc.id} (${r.report.score})`)
    expect(accused).toEqual([])
  })

  it('never reassures about a document carrying residue', () => {
    for (const r of results) {
      if (r.report.findings.some((f) => f.category === 'residue')) {
        expect(r.report.verdict, r.doc.id).not.toBe('likely_human')
      }
    }
  })

  it('gives the same answer twice', () => {
    const again = run()
    expect(again.map((r) => [r.report.verdict, r.report.score])).toEqual(
      results.map((r) => [r.report.verdict, r.report.score]),
    )
  })
})
