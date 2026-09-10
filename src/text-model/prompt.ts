import type { Brief } from '../core/rewrite.ts'
import { proseLanguages, languageName } from '../core/text/language.ts'

/** Small local models follow a short editing request more reliably than a report template. */
export function localRewritePrompt(text: string, brief: Brief): string {
  const languages = proseLanguages(text)
  const language =
    languages.length === 1
      ? `Write only in ${languageName(languages[0]!)}. Do not translate the text.`
      : 'Keep the original language of every passage, including mixed-language text. Do not translate.'
  const targets = brief.tells.map((tell) => tell.fix)
  const style = targets.length ? `\nStyle edits: ${[...new Set(targets)].join('; ')}.` : ''
  return `Rewrite this text to read naturally, correcting awkward phrasing while keeping its meaning and tone. ${language} Use the same language as the source, never the language of these instructions. Do not add new ideas. Preserve every fact, name, number, date, URL, quotation and code fragment exactly as written. Keep approximately the same length. Return only the edited text, without commentary or wrapping it in quotes or code fences. If no changes are needed, copy the text exactly.${style}

Text:
${text}`
}
