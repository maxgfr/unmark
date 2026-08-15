// The text half of the core, as one surface.
//
// The three modules underneath answer different questions and are deliberately
// separate — what is in here, what does it say, and what does the prose look
// like — but a caller almost always wants all three at once, in one ordered
// report. This is that report, and it is what both the page and the CLI call.

import { byPosition, type CleanResult, type Finding } from '../report.ts'
import { cleanText, inspectText, isLoadBearing, type TextOptions } from './unicode.ts'
import { decodeStego, encodeStego, stegoFindings, type StegoDecoding } from './stego.ts'
import { analyzeStyle, stylometryFindings, type StyleReport } from './stylometry.ts'
import { identity, splice } from './frame.ts'
import { tidySeam } from './humanise.ts'

export {
  analyzeStyle,
  cleanText,
  decodeStego,
  encodeStego,
  inspectText,
  isLoadBearing,
  stegoFindings,
  stylometryFindings,
}
export { distinctSignals, MIN_PARAGRAPHS, MIN_SENTENCES, MIN_WORDS } from './stylometry.ts'
export { humanise } from './humanise.ts'
export { normaliseTypography } from './typography.ts'
export { cleanProvenance } from './provenance.ts'
export { blocksOf, paragraphsOf, protectedMask } from './regions.ts'
export { detectSpaceCadence } from './stego.ts'
export type { StegoDecoding, StyleReport, TextOptions }
export type { StyleLayer, StyleMetric } from './stylometry.ts'
export type { StegoScheme } from './stego.ts'

/**
 * The one-button preset.
 *
 * Marks come off whatever the options say — that is what a clean is. This turns
 * on the two passes that are about how the writing *reads*, which are off by
 * default because they rewrite the author's prose. Naming it once here keeps
 * the page's button and the CLI's `--plain` from drifting into two presets.
 *
 * It does not remove a statistical watermark, and every surface that offers it
 * has to say so on the same screen.
 */
export const PLAIN: TextOptions = { typography: true, humanise: true }

export interface TextReport {
  /** Everything found, in document order: carriers, payloads, style tells. */
  findings: Finding[]
  /** Carriers matched but deliberately kept, with the reason on each. */
  preserved: Finding[]
  /**
   * The stripped document, from the same pass the findings came out of.
   *
   * Carried on the report rather than left to the caller, because the caller
   * that wanted both ran `cleanText` a second time to get it — and `cleanText`
   * is the expensive half. Measured on 139k characters of ordinary prose: 361
   * ms of the report's 422, paid twice on every rebuild. `useDeferredValue`
   * does not help with that; a single synchronous pass is uninterruptible
   * however it is scheduled.
   */
  cleaned: CleanResult<string>
  /** Payloads recovered from the carriers, most plausible first. */
  stego: StegoDecoding[]
  style: StyleReport
}

/**
 * Rewrite exactly these spans of `text`, and nothing else.
 *
 * The counterpart to the options on `cleanText`: those say "every em dash in
 * this document", and this says "that one". It takes the document as it
 * arrived, because that is the frame every text finding is now in — the caller
 * passes the string it showed the reader, never the cleaned one.
 *
 * Applying all of one pass's findings gives that pass's own output, and there
 * is a test holding the two together. That equality is the point: an interface
 * offering both a toggle and a per-finding button must not have them disagree
 * about the same character.
 *
 * A finding with no `replacement` is skipped rather than throwing. Nothing
 * should be offering to apply one, but a core function that explodes on a
 * report-only finding is a trap laid for the next caller.
 */
export function applyFindings(text: string, findings: readonly Finding[]): string {
  const editable = findings.filter((f) => f.replacement !== undefined && f.scope !== 'document')
  if (editable.length === 0) return text

  const ordered = [...editable].sort(byPosition)
  let stage = splice(
    text,
    ordered.map((f) => ({
      start: f.offset,
      end: f.offset + f.length,
      to: f.replacement as string,
    })),
    identity(text.length),
  )

  // Only a deleted phrase gets its seam tidied, and the kind is what says so.
  // `humanise` closes the gap a removed phrase leaves — a doubled space, a
  // stranded comma, a sentence now opening in lower case — and applying one of
  // its findings has to do the same or the button and the toggle produce two
  // different documents. A deleted zero-width carrier gets none of it: the
  // spaces either side of it were already the author's.
  const seams: number[] = []
  let drift = 0
  for (const finding of ordered) {
    const replacement = finding.replacement as string
    const at = finding.offset - drift + replacement.length
    drift += finding.length - replacement.length
    if (finding.kind === 'ai_phrase' && replacement.length === 0) seams.push(at)
  }

  for (let index = seams.length - 1; index >= 0; index -= 1) {
    stage = tidySeam(stage.text, stage.frame, seams[index] as number)
  }

  return stage.text
}

/** Read a document without changing it. */
export function inspectTextDocument(text: string, options?: TextOptions): TextReport {
  const cleaned = cleanText(text, options)
  const { findings, preserved } = cleaned
  return {
    findings: [...findings, ...preserved, ...stegoFindings(text), ...stylometryFindings(text)].sort(
      byPosition,
    ),
    preserved,
    cleaned,
    stego: decodeStego(text),
    style: analyzeStyle(text),
  }
}

/**
 * Strip a document, and decode what was in it first.
 *
 * The decode happens against the *original* text: once the carriers are gone
 * there is nothing left to read, so a clean pass that did not decode first
 * would destroy the evidence it was asked to find.
 */
export function cleanTextDocument(
  text: string,
  options?: TextOptions,
): CleanResult<string> & { stego: StegoDecoding[]; style: StyleReport } {
  const stego = decodeStego(text)
  const result = cleanText(text, options)
  return { ...result, stego, style: analyzeStyle(text) }
}
