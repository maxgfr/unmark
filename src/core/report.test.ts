import { describe, expect, it } from 'vitest'
import { byPosition, isRemovable, worstVerdict, type Finding } from './report.ts'

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
