import type { Brief } from '../core/rewrite.ts'

/** Small local models follow a short editing request more reliably than a report template. */
export function localRewritePrompt(text: string, brief: Brief): string {
  const targets = brief.tells.map((tell) => tell.fix)
  const style = targets.length ? `\nStyle edits: ${[...new Set(targets)].join('; ')}.` : ''
  return `Make minimal edits to this text so it is clear and natural. Use the same language and tone. Do not add new ideas. Preserve every fact, name, number, date, URL, quotation and code fragment exactly as written. Keep approximately the same length. Return only the edited text, without commentary or wrapping it in quotes or code fences. If no changes are needed, copy the text exactly.${style}

Text:
${text}`
}
