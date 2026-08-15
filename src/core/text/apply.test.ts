// Applying one finding, and the invariant that keeps it honest.
//
// The page offers two ways to act on the same character: a toggle that acts on
// every one of them, and a button on the row that acts on that one. Two code
// paths to one answer is a pair that drifts, and the drift would show up as a
// document the report no longer describes. So the test that matters here is not
// "does Apply work" — it is "does applying all of a pass's findings produce
// exactly what that pass produces".

import { describe, expect, it } from 'vitest'
import {
  applyFindings,
  cleanText,
  humanise,
  inspectTextDocument,
  normaliseTypography,
} from './index.ts'
import { cleanProvenance } from './provenance.ts'

const ZWSP = '​'

describe('applyFindings agrees with the pass it came from', () => {
  const document = [
    'In order to proceed, we utilize the attached report — it is a large number',
    'of pages. Needless to say, please review it prior to the meeting.',
    'Source: https://example.com/report?utm_source=chatgpt.com',
  ].join('\n')

  it('reproduces normaliseTypography exactly', () => {
    const pass = normaliseTypography(document)
    expect(applyFindings(document, pass.findings)).toBe(pass.output)
  })

  it('reproduces humanise exactly, seam tidying included', () => {
    // The one that catches a missed `tidySeam`: "Needless to say, " is deleted
    // outright, and the pass closes the gap behind it. A splicer that only
    // spliced would leave a doubled space here and the two paths would differ.
    const pass = humanise(document)
    expect(applyFindings(document, pass.findings)).toBe(pass.output)
    expect(pass.output).not.toContain('  ')
  })

  it('reproduces cleanProvenance exactly', () => {
    const pass = cleanProvenance(document)
    expect(applyFindings(document, pass.findings)).toBe(pass.output)
  })
})

describe('applyFindings', () => {
  it('rewrites the one span it was given and leaves its neighbours alone', () => {
    const source = 'a — b — c — d'
    const dashes = normaliseTypography(source).findings
    expect(dashes).toHaveLength(3)

    const applied = applyFindings(source, [dashes[1] as (typeof dashes)[number]])
    expect(applied).toBe('a — b - c — d')
  })

  it('deletes a carrier without touching the spaces around it', () => {
    // The seam tidy is `humanise`'s, not everyone's. A zero-width character
    // between two words was sitting between spaces the author typed.
    const source = `two ${ZWSP} words`
    const carriers = cleanText(source).findings

    expect(applyFindings(source, carriers)).toBe('two  words')
  })

  it('ignores a finding that has no replacement rather than throwing', () => {
    const source = 'A short line.'
    const invented = {
      kind: 'stylometry' as const,
      verdict: 'probable' as const,
      offset: 0,
      length: 5,
      label: 'x',
    }

    expect(applyFindings(source, [invented])).toBe(source)
  })

  it('ignores a document-scoped finding even when it carries a replacement', () => {
    const source = 'A short line.'
    const invented = {
      kind: 'stylometry' as const,
      verdict: 'probable' as const,
      offset: 0,
      length: source.length,
      label: 'x',
      scope: 'document' as const,
      replacement: '',
    }

    expect(applyFindings(source, [invented])).toBe(source)
  })

  it('works against the offsets the page actually holds', () => {
    // The report the interface renders is rebased into the original frame, and
    // this is the call the Apply button makes: the string shown to the reader,
    // and findings taken straight off that report. If the two ever stopped
    // sharing a frame, this would splice the wrong characters.
    const source = `Quarterly${ZWSP.repeat(20)} results — attached.`
    const report = inspectTextDocument(source)
    const dash = [...report.findings, ...report.preserved].find((f) => f.kind === 'typography')

    expect(dash).toBeDefined()
    expect(applyFindings(source, [dash as NonNullable<typeof dash>])).toBe(
      `Quarterly${ZWSP.repeat(20)} results - attached.`,
    )
  })
})
