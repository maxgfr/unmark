// Was this written by a model? An assessment, located, never a proof.
//
// The pipeline, each stage its own module and its own test:
//
//   segment     sentences of unsealed prose, with lines and columns
//   route       French or English, paragraph by paragraph
//   scan        every catalogue pattern once, filed under its sentence
//   forensics   technical marks from the existing passes
//   measure     five features per sentence
//   spans       a score and a band per sentence
//   signals     one number per habit family
//   verdict     three guards, and an abstention below 150 words
//   report      the same answer as data, Markdown and findings
//
// Pure and synchronous: no `node:`, no DOM, no network. A caller that can run
// a model hands its number in through `external`.

import { VERSION } from '../../version.ts'
import { protectedMask } from '../regions.ts'
import { lineIndex } from '../lines.ts'
import { analyzeStyle } from '../stylometry.ts'
import { CALIBRATION, type Calibration } from './calibration.ts'
import { measure, scan, wordReuse, type Hit } from './features.ts'
import { technicalMarks } from './forensics.ts'
import {
  DISCLAIMER,
  excerptOf,
  NOT_EVIDENCE,
  type AuthorshipFinding,
  type AuthorshipReport,
  type Severity,
} from './report.ts'
import { route, type LangOption } from './route.ts'
import { segment, type Segmentation } from './segment.ts'
import { builtInSignals, fromExternal, type EvidenceLabel, type ExternalSignal } from './signals.ts'
import { scoreSentences } from './spans.ts'
import { decide, MIN_WORDS } from './verdict.ts'

export interface DetectOptions {
  /** Force a language instead of detecting it per paragraph. */
  lang?: LangOption
  /** The container format, as `inspect` names it: `Text`, `Markdown`, `HTML`. */
  format?: string
  /** Signals computed outside the core, averaged in with their own weights. */
  external?: readonly ExternalSignal[]
  /** For the evaluation harness; everything else uses the shipped one. */
  calibration?: Calibration
  /** List every sentence in `spans`, not only those in a band. For evaluation. */
  allSpans?: boolean
}

/** Overwrite with spaces, newlines kept, so every offset and line still holds. */
const blank = (match: string) => match.replaceAll(/[^\n]/gu, ' ')

/** Elements whose content is not prose: dropped whole, like a fenced block. */
const NOT_PROSE = /<(script|style|pre|code|template|svg)\b[^>]{0,500}>[\s\S]*?<\/\1\s*>/giu
/** Tags that start or end a block; they become paragraph breaks. */
const BLOCK_TAG =
  /<\/?(?:p|div|h[1-6]|li|ul|ol|br|hr|section|article|header|footer|main|nav|aside|blockquote|table|tr|td|th|dl|dt|dd|figure|figcaption|title|head|body|html)\b[^>]{0,500}>/giu
const ANY_TAG = /<!--[\s\S]*?-->|<[!/]?[a-z][^>]{0,500}>/giu

/**
 * An HTML page as prose, at the same length as the page.
 *
 * Every tag is overwritten rather than removed, so a passage found here is
 * found at the same offset in the page, and lines are counted on the page
 * itself. A block tag turns into a paragraph break: two <p> on one line are
 * two paragraphs, which is what the tier-2 rule counts within.
 */
function htmlAsProse(html: string): string {
  return html
    .replaceAll(NOT_PROSE, blank)
    .replaceAll(BLOCK_TAG, (tag) => `\n\n${' '.repeat(Math.max(0, tag.length - 2))}`)
    .replaceAll(ANY_TAG, blank)
}

const severityOf = (hit: Hit): Severity =>
  hit.entry.category === 'residue'
    ? 'high'
    : hit.entry.category === 'formatting' || hit.entry.tier === 1
      ? 'medium'
      : 'low'

const labelOf = (hit: Hit): EvidenceLabel =>
  hit.entry.category === 'residue' || hit.entry.category === 'formatting'
    ? 'CHAT_RESIDUE'
    : 'STYLE_HEURISTIC'

/** The sentence around an offset, or failing that its line. */
function contextOf(text: string, seg: Segmentation, hit: Hit): [number, number] {
  const sentence = seg.sentences[hit.sentence]
  if (sentence) return [sentence.start, sentence.end]
  const from = text.lastIndexOf('\n', hit.start - 1) + 1
  const newline = text.indexOf('\n', hit.end)
  return [from, newline === -1 ? text.length : newline]
}

export function detectAuthorship(input: string, options: DetectOptions = {}): AuthorshipReport {
  const calibration = options.calibration ?? CALIBRATION
  const text = options.format === 'HTML' ? htmlAsProse(input) : input

  // Lines and columns always address the input as given, not its prose view.
  const seg = segment(text, protectedMask(text), lineIndex(input))
  const routing = route(text, seg, options.lang ?? 'auto')
  const hits = scan(text, seg, options.format)
  const marks = technicalMarks(input)
  const scored = scoreSentences(seg, measure(text, seg, hits, marks), hits)
  const style = analyzeStyle(text)
  const lang = routing.document === 'und' ? 'en' : routing.document

  const signals = [
    ...builtInSignals(
      { words: seg.words, lang, spans: scored, hits, marks, style, reuse: wordReuse(text, seg) },
      calibration,
    ),
    ...(options.external ?? []).map(fromExternal),
  ]

  const counted = hits.filter((hit) => hit.counted)
  const result = decide({
    words: seg.words,
    unsupported:
      routing.unsupportedShare > 0.5 || (routing.document === 'und' && seg.words >= MIN_WORDS),
    signals,
    residue: counted.some((hit) => hit.entry.category === 'residue'),
    technical: marks.length > 0,
    calibration,
  })

  const findings: AuthorshipFinding[] = counted.map((hit) => {
    const at = seg.index.locate(hit.start)
    const [from, to] = contextOf(text, seg, hit)
    return {
      id: `${hit.entry.id}@${hit.start}`,
      patternId: hit.entry.id,
      category: hit.entry.category,
      tier: hit.entry.tier,
      start: hit.start,
      end: hit.end,
      line: at.line,
      col: at.col,
      excerpt: excerptOf(text, hit.start, hit.end, from, to),
      reason: hit.entry.reason,
      fixHint: hit.entry.fixHint,
      evidenceLabel: labelOf(hit),
      severity: severityOf(hit),
    }
  })

  return {
    schemaVersion: 1,
    engine: { name: 'unmark', version: VERSION },
    calibration: { id: calibration.id, calibrated: calibration.calibrated, date: calibration.date },
    verdict: result.verdict,
    score: result.score,
    confidence: result.confidence,
    ...(result.abstainReason ? { abstainReason: result.abstainReason } : {}),
    language: {
      document: routing.document,
      unsupportedShare: Math.round(routing.unsupportedShare * 1000) / 1000,
    },
    words: seg.words,
    sentences: seg.sentences.length,
    thresholds: { ...calibration.thresholds },
    signals,
    spans: scored
      .filter((span) => options.allSpans === true || span.band !== 'none')
      .map((span) => ({
        start: span.start,
        end: span.end,
        line: span.line,
        col: span.col,
        endLine: span.endLine,
        words: span.words,
        score: span.score,
        band: span.band,
        lowConfidence: span.lowConfidence,
        reasons: span.reasons,
        excerpt: excerptOf(text, span.start, span.end, span.start, span.end),
        ...(span.lang ? { lang: span.lang } : {}),
      })),
    findings,
    technicalMarks: marks.map((mark) => ({ ...mark, ...seg.index.locate(mark.offset) })),
    style,
    notEvidence: NOT_EVIDENCE,
    disclaimer: DISCLAIMER,
  }
}

export {
  authorshipFindings,
  DISCLAIMER,
  NOT_EVIDENCE,
  renderMarkdown,
  toJSON,
  verdictSentence,
} from './report.ts'
export type {
  AuthorshipFinding,
  AuthorshipReport,
  AuthorshipSpan,
  LocatedFinding,
  RenderOptions,
} from './report.ts'
export type { AuthorshipVerdict, Confidence, AbstainReason } from './verdict.ts'
export type { ExternalSignal, Signal, EvidenceLabel } from './signals.ts'
export type { Calibration } from './calibration.ts'
export { CALIBRATION } from './calibration.ts'
export { MIN_WORDS as MIN_AUTHORSHIP_WORDS, weightedScore } from './verdict.ts'
export type { LangOption } from './route.ts'
export { formatOfPaste } from './paste.ts'
