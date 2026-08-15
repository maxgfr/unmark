// The marks a chat window leaves in text you paste out of it.
//
// These are not style, and that distinction decides everything about how they
// are treated. `?utm_source=chatgpt.com` on a cited link is a tracking
// parameter that names the tool the text came from; it travels into every
// document the paragraph is pasted into, and it reaches the destination site's
// analytics when someone follows the link. That is the same category as an EXIF
// author field, so it is `confirmed`, it is removed by default, and it does not
// wait behind an opt-in the way the typography pass does.
//
// The line drawn here matters: only parameters whose *value* names an AI
// product are stripped. A plain `utm_source=newsletter` is the sender's own
// analytics on their own link, it says nothing about how the text was written,
// and removing it would be editing someone's link for reasons of our own.
//
// The citation furniture is the other half. ChatGPT's file and web citations
// survive a copy as private-use codepoints and bracket glyphs that render as
// nothing useful anywhere else. They are structurally unambiguous, so they are
// confirmed too.

import type { Finding } from '../report.ts'
import { splice, type Splice } from './frame.ts'

/**
 * Query parameters whose value names the tool that produced the text.
 *
 * Matched on the pair, never on the key alone.
 */
const AI_PARAMETER =
  /\b(utm_source|utm_medium|ref|referrer|source)=(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity(?:\.ai)?|claude\.ai|copilot(?:\.microsoft\.com)?|gemini\.google\.com|poe\.com)\b/gi

/**
 * A URL, matched loosely enough to find one inside prose or Markdown.
 *
 * The class excludes the punctuation that ends a link in running text, and the
 * typographic half of that list is not decoration. It used to stop only at
 * whitespace, angle brackets, straight quotes and closing brackets — so an em
 * dash was "part of the URL", and
 *
 *   the announcement—https://x/p?utm_source=chatgpt.com—it is short
 *
 * matched through to `—it`. Stripping the parameter rewrote the whole match as
 * the part before `?`, and the word went with it. This pass is on by default
 * and has no toggle: it was silently deleting words from the sentence a reader
 * had handed over to be inspected. Curly quotes and guillemets are the same
 * failure with a different character.
 *
 * The cost of being wrong the other way is a miss, not damage: a link that
 * genuinely contains one of these is matched only up to it, so its tracking
 * parameter is left in place. In practice those characters are percent-encoded
 * in a real URL, and a mark left behind is a smaller wrong than a word removed.
 *
 * Escapes rather than literals: U+2012-U+2015 is a range over the four dashes,
 * and a literal em dash inside a class is indistinguishable from one.
 */
const URL_PATTERN =
  /\bhttps?:\/\/[^\s<>"'\])}\u00ab\u00bb\u2012-\u2015\u2018\u2019\u201c\u201d\u2026]+/gi

/**
 * ChatGPT citation furniture.
 *
 * Three shapes, all of which survive a copy into a document:
 *   U+E200 … U+E201   the private-use delimiters around a `citeturn0search1`
 *   citeturn0search1  the same token with its delimiters already lost
 *   【4:0†source】      the bracket form, which renders as itself everywhere
 *   :contentReference[oaicite:0]{index=0}
 */
const CITATION_TOKENS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /[\u{E200}-\u{E20F}][^\u{E200}-\u{E20F}]{0,120}?[\u{E200}-\u{E20F}]/gu,
    label: 'a private-use-delimited citation token',
  },
  { pattern: /\bcite\s*turn\d+\w*/gi, label: 'a bare citation token' },
  { pattern: /【[^】\n]{0,80}?[†|][^】\n]{0,80}?】/gu, label: 'a bracket citation glyph' },
  { pattern: /:?contentReference\[oaicite:\d+]\{index=\d+}/gi, label: 'an oaicite reference' },
]

export interface ProvenanceResult {
  output: string
  findings: Finding[]
  /**
   * What this pass rewrote, so a caller piping passes together can read a later
   * offset back into the document it started from.
   */
  splices: Splice[]
}

interface Edit extends Splice {
  finding: Finding
}

/**
 * Strip the tracking parameter out of one URL, keeping everything else.
 *
 * Hand-written rather than going through `URL`, because the input is a string
 * lifted out of prose and may not be a URL the parser accepts — and because a
 * round trip through `URL` normalises escaping, reorders nothing but rewrites
 * plenty, which would show up as noise in a diff of someone's document.
 */
function stripParameters(url: string): { cleaned: string; removed: string[] } {
  const split = url.indexOf('?')
  if (split === -1) return { cleaned: url, removed: [] }

  const hashAt = url.indexOf('#', split)
  const query = url.slice(split + 1, hashAt === -1 ? undefined : hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)

  const removed: string[] = []
  const kept = query.split('&').filter((pair) => {
    AI_PARAMETER.lastIndex = 0
    if (!AI_PARAMETER.test(pair)) return true
    removed.push(pair)
    return false
  })

  if (removed.length === 0) return { cleaned: url, removed: [] }
  const rebuilt = kept.length > 0 ? `${url.slice(0, split)}?${kept.join('&')}` : url.slice(0, split)
  return { cleaned: rebuilt + hash, removed }
}

/** Remove the marks a chat window leaves behind, and say what each one was. */
export function cleanProvenance(text: string): ProvenanceResult {
  const edits: Edit[] = []

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index
    if (start === undefined) continue
    // A URL at the end of a sentence swallows the full stop. Trimming trailing
    // punctuation keeps it out of the rewritten link.
    const raw = match[0].replace(/[.,;:!?]+$/, '')
    const { cleaned, removed } = stripParameters(raw)
    if (removed.length === 0) continue

    edits.push({
      start,
      end: start + raw.length,
      to: cleaned,
      finding: {
        kind: 'generator_tag',
        verdict: 'confirmed',
        offset: start,
        length: raw.length,
        label: `Tracking parameter naming the tool that wrote this: ${removed.join(', ')}`,
        evidence: raw,
        replacement: cleaned,
      },
    })
  }

  for (const { pattern, label } of CITATION_TOKENS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      if (start === undefined) continue
      let end = start + match[0].length
      if (edits.some((edit) => start < edit.end && end > edit.start)) continue

      // Swallow one adjacent space when the token sat between two, so removing
      // it does not leave a double space behind. The first version left one and
      // a test asserted it, which turned a cosmetic flaw into a specification.
      if (/[^\S\n]/.test(text[start - 1] ?? '') && /[^\S\n]/.test(text[end] ?? '')) end += 1

      edits.push({
        start,
        end,
        to: '',
        finding: {
          kind: 'generator_tag',
          verdict: 'confirmed',
          offset: start,
          length: end - start,
          label: `Chat citation furniture: ${label}`,
          evidence: JSON.stringify(match[0]),
          replacement: '',
        },
      })
    }
  }

  if (edits.length === 0) return { output: text, findings: [], splices: [] }
  edits.sort((a, b) => a.start - b.start)

  // The same splicer the pipeline uses. A second hand-rolled loop here would be
  // a second answer to "what did this pass change", and the frame is built from
  // the one that is written down.
  const splices = edits.map(({ start, end, to }) => ({ start, end, to }))
  return {
    output: splice(text, splices).text,
    findings: edits.map((edit) => edit.finding),
    splices,
  }
}
