// What a chat window or a watermarking scheme leaves behind.
//
// Two classes with different weights, and the difference is the point.
//
// Technical marks are what unmark already finds — carriers, decoded payloads,
// citation furniture, tracking parameters, words that mix Latin and Cyrillic
// letters. They are read from the existing passes, never detected a second
// time, and keep the verdicts those passes gave them, `confirmed` included:
// a tag-character run spelling an account id is not a matter of style.
//
// Residue is text: "[Your Name]", "Bien sûr ! Voici", a Markdown heading in a
// .txt file. Strong evidence that a chat window was involved, and still only
// evidence — someone can paste their own template, or quote a chatbot on
// purpose. It never reaches `confirmed`.

import type { Finding, FindingKind } from '../../report.ts'
import { cleanText } from '../unicode.ts'
import { stegoFindings } from '../stego.ts'
import type { Pattern } from './catalogue/types.ts'

export { applies } from './catalogue/types.ts'

/** The existing finding kinds that count as a technical mark. */
const TECHNICAL: ReadonlySet<FindingKind> = new Set<FindingKind>([
  'zwj_family',
  'tag_chars',
  'variation_selector',
  'bidi',
  'generator_tag',
  'confusable',
])

/**
 * Every technical mark in `text`, straight from the passes that find them.
 *
 * `confusables: true` is what turns on the mixed-script check, and it only
 * flags a lookalike inside a word that also has Latin letters: a Russian word
 * is Russian, not a spoof. Preserved findings — an emoji joiner, a French
 * no-break space — are left out because they are not marks.
 */
export function technicalMarks(text: string): Finding[] {
  const { findings } = cleanText(text, { confusables: true })
  return [
    ...findings.filter(
      (finding) =>
        TECHNICAL.has(finding.kind) ||
        (finding.kind === 'space' && finding.verdict === 'confirmed'),
    ),
    ...stegoFindings(text),
  ].sort((a, b) => a.offset - b.offset)
}

export const FORENSIC_PATTERNS: readonly Pattern[] = [
  {
    id: 'any.residue.placeholder',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern:
      /\[(?:your|insert|enter|votre|vos|insérer|insérez|indiquer|nom|name|company|entreprise|prénom|adresse|address|titre|title|date|lieu|ville|city)(?:[ \p{L}'’-]{0,40})\]|\{\{ ?[\p{L}_][\p{L}\p{N}_. ]{0,40}\}\}/giu,
    reason: 'a template slot nobody filled in, as a model leaves them',
    fixHint: 'fill it in or delete it',
    samples: ['Best regards, [Your Name]', 'Fait à [Insérer la ville]', 'Bonjour {{prenom}},'],
    traps: ['as shown in [1]', 'he wrote [sic] twice', 'see [Smith 2019]'],
  },
  {
    id: 'any.format.markdown_bold',
    lang: 'any',
    tier: 1,
    category: 'formatting',
    pattern: /\*\*[^*\n]{1,80}\*\*/gu,
    reason: 'Markdown bold in a plain-text file: formatting copied out of a chat window',
    fixHint: 'remove the asterisks, or use the emphasis the destination supports',
    samples: ['The **key point** is cost.'],
    traps: ['2 * 3 * 4 = 24'],
    formats: ['Text'],
  },
  {
    id: 'any.format.markdown_heading',
    lang: 'any',
    tier: 1,
    category: 'formatting',
    pattern: /(?<=^|\n)#{1,6} \p{L}/gu,
    reason: 'a Markdown heading in a plain-text file: structure copied out of a chat window',
    fixHint: 'remove the hashes, or turn the heading into a sentence',
    samples: ['## Overview'],
    traps: ['Issue #12 is fixed.'],
    formats: ['Text'],
  },
]
