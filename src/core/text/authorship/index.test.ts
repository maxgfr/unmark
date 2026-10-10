import { describe, expect, it } from 'vitest'
import { detectAuthorship, fileMarksFrom } from './index.ts'
import { DISCLAIMER } from './report.ts'
import { CALIBRATION } from './calibration.ts'
import { AI_FR, HUMAN_EN, HUMAN_FR } from '../../../test/authorship-samples.ts'

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
    expect(report.calibration.id).toBe(CALIBRATION.id)
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

  it('locates passages of an HTML page at their real line and column, without tags', () => {
    const page = [
      '<!doctype html>',
      '<html><head><title>Rapport</title></head><body>',
      '<p>Plongeons dans le sujet sans tarder dès ce matin avec toute l’équipe.</p>',
      '<p>Le conseil a voté le budget mardi soir après deux heures de débat.</p>',
      '</body></html>',
    ].join('\n')
    const report = detectAuthorship(page, { format: 'HTML', lang: 'fr' })
    const finding = report.findings.find((f) => f.patternId === 'fr.lex.plongeons')
    expect(finding).toMatchObject({ line: 3, col: 4 })
    expect(report.spans.every((span) => !span.excerpt.includes('<'))).toBe(true)
  })

  it('treats each HTML block as its own paragraph', () => {
    // Two tier-2 phrases count only when they share a paragraph. On one line of
    // HTML, two <p> elements are still two paragraphs.
    const page = `<p>Le projet avance, notamment grâce à la région, depuis mars.</p><p>En outre, la ville participe au financement du chantier.</p>`
    const report = detectAuthorship(page, { format: 'HTML', lang: 'fr' })
    expect(report.findings.filter((f) => f.tier === 2)).toEqual([])
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
})

describe('a document in two languages', () => {
  const text = `${HUMAN_FR}\n\n${HUMAN_EN}\n\n${AI_FR}`

  it('is cut into blocks, each assessed with its own catalogue', () => {
    const report = detectAuthorship(text)
    expect(report.blocks.map((b) => b.lang)).toEqual(['fr', 'en', 'fr'])
    for (const block of report.blocks) {
      expect(block.words).toBeGreaterThanOrEqual(150)
      expect(block.score).not.toBeNull()
    }
    const [, english, generated] = report.blocks
    expect(text.slice(english?.start, english?.end)).toBe(HUMAN_EN)
    expect(generated?.score).toBeGreaterThan(english?.score as number)
  })

  it('combines the blocks by their words', () => {
    const report = detectAuthorship(text)
    const assessed = report.blocks.filter((b) => b.score !== null)
    const words = assessed.reduce((sum, b) => sum + b.words, 0)
    const mean = assessed.reduce((sum, b) => sum + (b.score as number) * b.words, 0) / words
    expect(report.score).toBeCloseTo(mean, 2)
  })

  it('keeps one block, and the plain verdict, for a text in one language', () => {
    const report = detectAuthorship(HUMAN_FR)
    expect(report.blocks).toHaveLength(1)
    expect(report.blocks[0]).toMatchObject({ lang: 'fr', verdict: report.verdict })
  })

  it('absorbs a short line in the other language', () => {
    const report = detectAuthorship(
      `${HUMAN_EN}\n\nMots-clés : implant, sclère, haptique.\n\n${HUMAN_EN}`,
    )
    expect(report.blocks).toHaveLength(1)
  })
})

describe('paragraphs in a language with no catalogue', () => {
  it('are listed with the language they were read as', () => {
    const german =
      'Die Untersuchung wurde an der Universitätsklinik durchgeführt, und alle Patienten haben vorher schriftlich eingewilligt, dass ihre Daten ausgewertet werden dürfen.'
    const report = detectAuthorship(`${HUMAN_EN}\n\n${german}`)
    expect(report.language.unsupported).toEqual([
      expect.objectContaining({ lang: 'de', words: expect.any(Number) }),
    ])
    expect(report.language.unsupported[0]?.excerpt).toMatch(/^Die Untersuchung/)
  })
})

describe('marks of the file the text came from', () => {
  const manifest = {
    kind: 'c2pa' as const,
    verdict: 'confirmed' as const,
    offset: 0,
    length: 0,
    label: 'caBX — C2PA provenance manifest',
    where: 'word/media/image24.png',
  }

  it('keeps provenance and confirmed marks, and leaves author names out', () => {
    const marks = fileMarksFrom([
      manifest,
      { kind: 'doc_property', verdict: 'probable', offset: 0, length: 0, label: 'Author names' },
      { kind: 'exif', verdict: 'informational', offset: 0, length: 0, label: 'EXIF' },
    ])
    expect(marks).toEqual([
      {
        origin: 'file',
        kind: 'c2pa',
        verdict: 'confirmed',
        label: manifest.label,
        where: manifest.where,
      },
    ])
  })

  it('are reported apart and hold the verdict above few signals (guard B)', () => {
    const plain = detectAuthorship(HUMAN_EN)
    const marked = detectAuthorship(HUMAN_EN, { fileMarks: fileMarksFrom([manifest]) })
    expect(marked.fileMarks).toHaveLength(1)
    expect(marked.technicalMarks).toEqual([])
    expect(marked.verdict).not.toBe('likely_human')
    if (plain.verdict === 'likely_human') expect(marked.verdict).toBe('uncertain')
  })
})

describe('a layout', () => {
  it('locates spans and findings by paragraph, section and page', () => {
    const text = `${HUMAN_FR}\n\n${AI_FR}`
    const second = text.indexOf(AI_FR)
    const report = detectAuthorship(text, {
      layout: {
        paragraphs: [
          { start: 0, end: second - 2, index: 1, section: '1. Introduction', page: 12 },
          { start: second, end: text.length, index: 7, section: '3. Conclusion', page: 46 },
        ],
      },
    })
    const late = report.findings.filter((f) => f.start >= second)
    expect(late.length).toBeGreaterThan(0)
    for (const finding of late)
      expect(finding.location).toEqual({ paragraph: 7, page: 46, section: '3. Conclusion' })
    for (const span of report.spans) expect(span.location?.page).toBeDefined()
  })
})
