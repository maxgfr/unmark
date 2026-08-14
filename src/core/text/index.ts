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
export { MIN_SENTENCES, MIN_WORDS } from './stylometry.ts'
export { humanise } from './humanise.ts'
export { normaliseTypography } from './typography.ts'
export { detectSpaceCadence } from './stego.ts'
export type { StegoDecoding, StyleReport, TextOptions }
export type { StyleMetric } from './stylometry.ts'
export type { StegoScheme } from './stego.ts'

export interface TextReport {
  /** Everything found, in document order: carriers, payloads, style tells. */
  findings: Finding[]
  /** Carriers matched but deliberately kept, with the reason on each. */
  preserved: Finding[]
  /** Payloads recovered from the carriers, most plausible first. */
  stego: StegoDecoding[]
  style: StyleReport
}

/** Read a document without changing it. */
export function inspectTextDocument(text: string, options?: TextOptions): TextReport {
  const { findings, preserved } = cleanText(text, options)
  return {
    findings: [...findings, ...preserved, ...stegoFindings(text), ...stylometryFindings(text)].sort(
      byPosition,
    ),
    preserved,
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
