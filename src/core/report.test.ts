import { describe, expect, it } from 'vitest'
import {
  byPosition,
  bySeverity,
  collapseRuns,
  isRemovable,
  KIND_LABEL,
  outcomeOf,
  worstVerdict,
  type Finding,
} from './report.ts'

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: 'zwj_family',
  verdict: 'confirmed',
  offset: 0,
  length: 1,
  label: 'test',
  ...over,
})

describe('isRemovable', () => {
  it('keeps a finding whose context says it is legitimate', () => {
    expect(isRemovable(finding({ verdict: 'likely_false_positive' }))).toBe(false)
  })

  it('never removes a stylometric tell', () => {
    // Prose style is evidence, not a carrier. Editing it is Layer B's job and
    // needs a model plus the user's consent — a `clean` pass must not touch it.
    expect(isRemovable(finding({ kind: 'stylometry', verdict: 'probable' }))).toBe(false)
  })

  it('never removes a decoded payload', () => {
    // The payload finding describes what the carriers spelled out. Its carriers
    // get stripped on their own; deleting the report of them would erase the
    // only record of what was hidden.
    expect(isRemovable(finding({ kind: 'stego_payload' }))).toBe(false)
  })

  it('removes a confirmed carrier', () => {
    expect(isRemovable(finding())).toBe(true)
  })
})

describe('worstVerdict', () => {
  it('is undefined for a clean report', () => {
    expect(worstVerdict([])).toBeUndefined()
  })

  it('reports the strongest verdict present, not the most common', () => {
    // A summary line that averaged its findings would hide one confirmed C2PA
    // manifest behind twenty informational EXIF tags.
    const findings = [
      finding({ verdict: 'informational' }),
      finding({ verdict: 'informational' }),
      finding({ verdict: 'confirmed' }),
      finding({ verdict: 'probable' }),
    ]
    expect(worstVerdict(findings)).toBe('confirmed')
  })

  it('does not promote a false positive', () => {
    expect(worstVerdict([finding({ verdict: 'likely_false_positive' })])).toBe(
      'likely_false_positive',
    )
  })
})

describe('byPosition', () => {
  it('orders by offset, then by kind for a stable render', () => {
    const findings = [
      finding({ offset: 5, kind: 'space' }),
      finding({ offset: 1, kind: 'tag_chars' }),
      finding({ offset: 5, kind: 'bidi' }),
    ]
    expect([...findings].sort(byPosition).map((f) => [f.offset, f.kind])).toEqual([
      [1, 'tag_chars'],
      [5, 'bidi'],
      [5, 'space'],
    ])
  })
})

describe('collapseRuns', () => {
  const many = (count: number, kind: Finding['kind'] = 'zwj_family') =>
    Array.from({ length: count }, (_, i) => finding({ kind, offset: i * 2, length: 1 }))

  it('leaves a small number of findings listed individually', () => {
    // Six carriers is a report you can read. Summarising it would hide detail
    // for no gain.
    expect(collapseRuns(many(6))).toHaveLength(6)
  })

  it('folds a crowd into one summary carrying the count and the span', () => {
    const collapsed = collapseRuns(many(88))
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.label).toContain('88 × zero-width character')
    expect(collapsed[0]?.offset).toBe(0)
    expect(collapsed[0]?.length).toBe(87 * 2 + 1)
  })

  it('does not merge different kinds or different verdicts', () => {
    const mixed = [
      ...many(10, 'zwj_family'),
      ...many(10, 'space').map((f) => finding({ ...f, verdict: 'probable' })),
    ]
    const collapsed = collapseRuns(mixed)
    expect(collapsed).toHaveLength(2)
    expect(new Set(collapsed.map((f) => f.kind))).toEqual(new Set(['zwj_family', 'space']))
  })

  it('never hides the decoded payload behind the carriers that spelled it', () => {
    // The one line worth reading must survive the fold.
    const payload = finding({ kind: 'stego_payload', offset: 0, evidence: 'leaker-7' })
    const collapsed = collapseRuns([payload, ...many(88)])
    expect(collapsed.some((f) => f.kind === 'stego_payload')).toBe(true)
  })

  it('returns findings in document order', () => {
    const collapsed = collapseRuns([finding({ offset: 9, kind: 'bidi' }), ...many(9)])
    const offsets = collapsed.map((f) => f.offset)
    expect(offsets).toEqual(offsets.toSorted((a, b) => a - b))
  })

  it('is a no-op on an empty report', () => {
    expect(collapseRuns([])).toEqual([])
  })

  it('keeps a folded group honest about not having been removed', () => {
    // The fold used to copy `preserved` and drop `available`, so eleven em
    // dashes waiting on a toggle folded into one row that read `removed` —
    // while the text still contained every one of them. A summary that
    // misreports the outcome is worse than no summary.
    const waiting = Array.from({ length: 11 }, (_, i) =>
      finding({
        kind: 'typography',
        verdict: 'informational',
        offset: i * 3,
        available: 'style, not a mark — enable the option to apply it',
      }),
    )
    const collapsed = collapseRuns(waiting)
    expect(collapsed).toHaveLength(1)
    expect(outcomeOf(collapsed[0] as Finding)).toBe('available')
  })

  it('carries the reason a folded group was kept', () => {
    const kept = Array.from({ length: 11 }, (_, i) =>
      finding({ verdict: 'likely_false_positive', offset: i, preserved: 'emoji joiner' }),
    )
    expect(collapseRuns(kept)[0]?.preserved).toBe('emoji joiner')
  })
})

describe('outcomeOf', () => {
  it('separates what was done from how sure we are', () => {
    // The distinction the table exists to show: a confirmed emoji joiner is
    // kept, and a merely probable XMP packet is removed. Reading the verdict
    // alone answers the wrong question.
    const keptJoiner = finding({
      kind: 'zwj_family',
      verdict: 'confirmed',
      preserved: 'emoji sequence glue',
    })
    const removedXmp = finding({ kind: 'xmp', verdict: 'probable' })

    expect(outcomeOf(keptJoiner)).toBe('kept')
    expect(outcomeOf(removedXmp)).toBe('removed')
  })

  it('calls a decoded payload reported, not removed', () => {
    // Its carriers are stripped on their own; the payload line is the record of
    // what they said, and nothing removes a record.
    expect(outcomeOf(finding({ kind: 'stego_payload' }))).toBe('reported')
  })

  it('calls a style tell reported', () => {
    expect(outcomeOf(finding({ kind: 'stylometry', verdict: 'probable' }))).toBe('reported')
  })
})

describe('bySeverity', () => {
  it('puts the confirmed finding first even when it is last in the file', () => {
    // Document order buries the point: an EXIF timestamp at offset 20 would sit
    // above a signed C2PA manifest at offset 900.
    const rows = [
      finding({ kind: 'exif', verdict: 'informational', offset: 20 }),
      finding({ kind: 'c2pa', verdict: 'confirmed', offset: 900 }),
    ].sort(bySeverity)
    expect(rows[0]?.kind).toBe('c2pa')
  })

  it('keeps document order inside a verdict', () => {
    const rows = [
      finding({ verdict: 'probable', offset: 50 }),
      finding({ verdict: 'probable', offset: 10 }),
    ].sort(bySeverity)
    expect(rows.map((f) => f.offset)).toEqual([10, 50])
  })
})

describe('KIND_LABEL', () => {
  it('names every kind, so no row can fall back to a machine identifier', () => {
    const kinds: Finding['kind'][] = [
      'zwj_family',
      'bidi',
      'tag_chars',
      'variation_selector',
      'space',
      'confusable',
      'stego_payload',
      'stylometry',
      'c2pa',
      'exif',
      'xmp',
      'iptc',
      'text_chunk',
      'doc_property',
      'generator_tag',
    ]
    for (const kind of kinds) {
      expect(KIND_LABEL[kind], kind).toBeTruthy()
      expect(KIND_LABEL[kind]).not.toContain('_')
    }
  })
})
