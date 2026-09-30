import { describe, expect, it } from 'vitest'
import { applies, FORENSIC_PATTERNS, technicalMarks } from './forensics.ts'
import { matchesOf } from './catalogue/index.ts'
import { encodeStego } from '../stego.ts'

const entry = (id: string) => {
  const found = FORENSIC_PATTERNS.find((p) => p.id === id)
  if (!found) throw new Error(id)
  return found
}

describe('technicalMarks', () => {
  it('reuses the existing carrier findings, verdicts included', () => {
    const marks = technicalMarks(`Quarterly results.${encodeStego('leak-1', 'zero-width')}`)
    expect(marks.some((m) => m.kind === 'zwj_family' && m.verdict === 'confirmed')).toBe(true)
    expect(marks.some((m) => m.kind === 'stego_payload')).toBe(true)
  })

  it('reports chat citation furniture as a generator tag', () => {
    const marks = technicalMarks('The figure rose citeturn0search1 last year.')
    expect(marks.map((m) => m.kind)).toContain('generator_tag')
  })

  it('reports a word that mixes Latin and Cyrillic letters', () => {
    const marks = technicalMarks('Log in to your pаypal account.')
    expect(marks.map((m) => m.kind)).toEqual(['confusable'])
  })

  it('leaves a genuinely Cyrillic word and French typography alone', () => {
    expect(technicalMarks('Le mot пароль veut dire : mot de passe !')).toEqual([])
  })
})

describe('forensic patterns', () => {
  it('finds unfilled placeholders in either language', () => {
    const placeholder = entry('any.residue.placeholder')
    for (const text of [
      'Signed, [Your Name]',
      'Fait à [Insérer la ville]',
      'Bonjour {{prenom}},',
    ]) {
      expect(matchesOf(placeholder, text), text).toHaveLength(1)
    }
  })

  it('reads Markdown furniture as residue only in a plain-text file', () => {
    const bold = entry('any.format.markdown_bold')
    expect(applies(bold, 'Text')).toBe(true)
    expect(applies(bold, 'Markdown')).toBe(false)
    expect(applies(bold, undefined)).toBe(false)
  })
})
