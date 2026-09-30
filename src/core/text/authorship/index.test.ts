import { describe, expect, it } from 'vitest'
import { detectAuthorship } from './index.ts'
import { detectAuthorship as fromText } from '../index.ts'
import { DISCLAIMER } from './report.ts'
import { AI_FR, HUMAN_FR } from '../../../test/authorship-samples.ts'

describe('detectAuthorship', () => {
  it('reads generated-sounding French as more likely AI than French reporting', () => {
    const ai = detectAuthorship(AI_FR)
    const human = detectAuthorship(HUMAN_FR)
    expect(ai.language.document).toBe('fr')
    expect(ai.score).toBeGreaterThan(human.score as number)
    expect(ai.verdict).not.toBe('likely_human')
    expect(human.verdict).not.toBe('likely_ai')
  })

  it('locates every finding by line and gives it a reason and a fix', () => {
    const report = detectAuthorship(AI_FR)
    expect(report.findings.length).toBeGreaterThan(5)
    for (const finding of report.findings) {
      expect(finding.line).toBeGreaterThanOrEqual(1)
      expect(finding.excerpt.length).toBeLessThanOrEqual(90)
      expect(finding.id).toBe(`${finding.patternId}@${finding.start}`)
      expect(finding.fixHint.length).toBeGreaterThan(0)
    }
    expect(report.findings.map((f) => f.patternId)).toContain('fr.lex.plongeons')
  })

  it('always carries the disclaimer and the calibration it used', () => {
    const report = detectAuthorship(HUMAN_FR)
    expect(report.disclaimer).toBe(DISCLAIMER)
    expect(report.calibration.id).toBe('provisional-0')
    expect(report.notEvidence.length).toBeGreaterThan(3)
  })

  it('abstains on forty words', () => {
    const short = HUMAN_FR.split(/\s+/).slice(0, 40).join(' ')
    expect(detectAuthorship(short)).toMatchObject({
      verdict: 'insufficient_evidence',
      abstainReason: 'too_short',
      score: null,
    })
  })

  it('abstains on a language it has no catalogue for', () => {
    const german = Array.from(
      { length: 8 },
      () =>
        'Der Gemeinderat hat sich am Dienstagabend getroffen, um den Haushalt für das kommende Jahr zu beraten. Die meiste Zeit ging es um das Dach der Grundschule.',
    ).join('\n\n')
    expect(detectAuthorship(german)).toMatchObject({
      verdict: 'insufficient_evidence',
      abstainReason: 'unsupported_language',
    })
  })

  it('never calls a text with chat residue likely human', () => {
    const report = detectAuthorship(`${HUMAN_FR}\n\nJ'espère que cela vous aide !`)
    expect(report.verdict).not.toBe('likely_human')
    expect(report.findings.some((f) => f.category === 'residue')).toBe(true)
  })

  it('reports placeholders and Markdown furniture in a plain-text file', () => {
    const report = detectAuthorship(`## Objet\n\n${HUMAN_FR}\n\nCordialement, [Votre nom]`, {
      format: 'Text',
    })
    const ids = report.findings.map((f) => f.patternId)
    expect(ids).toContain('any.residue.placeholder')
    expect(ids).toContain('any.format.markdown_heading')
  })

  it('takes an external signal into the score', () => {
    const plain = detectAuthorship(HUMAN_FR)
    const pushed = detectAuthorship(HUMAN_FR, {
      external: [{ id: 'binoculars', value: 1, weight: 5, label: 'Model perplexity' }],
    })
    expect(pushed.score).toBeGreaterThan(plain.score as number)
    expect(pushed.signals.at(-1)).toMatchObject({
      id: 'binoculars',
      evidenceLabel: 'EXTERNAL_MODEL',
    })
  })

  it('does not read script or style blocks of an HTML page as prose', () => {
    const page = `<html><head><style>body { color: red }</style><script>const plongeons = "dans un monde où"</script></head><body><p>${HUMAN_FR}</p></body></html>`
    const report = detectAuthorship(page, { format: 'HTML' })
    expect(report.findings.map((f) => f.patternId)).not.toContain('fr.lex.plongeons')
  })

  it('reports technical marks with their line', () => {
    const report = detectAuthorship(`${HUMAN_FR}\n\nVoir citeturn0search1 pour la source.`)
    expect(report.technicalMarks[0]).toMatchObject({ kind: 'generator_tag' })
    expect(report.technicalMarks[0]?.line).toBeGreaterThan(1)
    expect(report.verdict).not.toBe('likely_human')
  })

  it('lists every sentence, band or not, when asked for all spans', () => {
    const some = detectAuthorship(HUMAN_FR)
    const all = detectAuthorship(HUMAN_FR, { allSpans: true })
    expect(all.spans.length).toBe(all.sentences)
    expect(all.spans.length).toBeGreaterThan(some.spans.length)
  })

  it('is deterministic', () => {
    expect(detectAuthorship(AI_FR)).toEqual(detectAuthorship(AI_FR))
  })

  it('is exported from the text surface', () => {
    expect(fromText).toBe(detectAuthorship)
  })
})
