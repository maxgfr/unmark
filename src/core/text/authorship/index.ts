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

import type { Finding } from '../../report.ts'
import { VERSION } from '../../version.ts'
import { protectedMask } from '../regions.ts'
import { lineIndex } from '../lines.ts'
import { analyzeStyle } from '../stylometry.ts'
import { CALIBRATION, type Calibration } from './calibration.ts'
import { entriesFor, measure, scan, wordReuse, type Hit, type Register } from './features.ts'
import { UNWEIGHTED } from './catalogue/index.ts'
import { recaps } from './recap.ts'
import { blocksOf } from '../regions.ts'
import { technicalMarks } from './forensics.ts'
import { locator, type Layout } from './locate.ts'
import {
  DISCLAIMER,
  excerptOf,
  NOT_EVIDENCE,
  type AuthorshipFinding,
  type AuthorshipReport,
  type DocumentSource,
  type FileMark,
  type LanguageBlock,
  type Location,
  type Severity,
  type UnsupportedSegment,
} from './report.ts'
import { route, type LangOption, type Routing } from './route.ts'
import { segment, type Lang, type Segmentation } from './segment.ts'
import { builtInSignals, fromExternal, type EvidenceLabel, type ExternalSignal } from './signals.ts'
import { scoreSentences } from './spans.ts'
import { decide, MIN_WORDS, type AuthorshipVerdict, type Confidence } from './verdict.ts'

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
  /**
   * List the catalogue matches the tier rules did not count too, marked
   * `counted: false`. For `sweep`, which lists every habit however isolated.
   */
  allFindings?: boolean
  /** Paragraphs, sections and pages of the document the text came from. */
  layout?: Layout
  /** Marks of the file the text came from, from `inspect`. */
  fileMarks?: readonly FileMark[]
  /** Assess the whole text as one block, even when it changes language. */
  singleBlock?: boolean
  /** What the text was read from, carried into the report as it is. */
  document?: DocumentSource
  /** Also read the formulas of a register, tier 3: `academic`. */
  register?: Register
}

/** Markers of academic prose, per thousand words, above which the text reads as academic. */
const ACADEMIC_CUES =
  /\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]|\bet al\.|\b(?:95\s?%\s?CI|IC\s?(?:à\s)?95\s?%)|\bp\s?[<=>]\s?0[.,]\d/gu
const ACADEMIC_RATE = 2

/** The register a text reads as, from its citations and statistics. */
export function readsAcademic(text: string, words: number): boolean {
  if (words === 0) return false
  const cues = [...text.matchAll(ACADEMIC_CUES)].length
  return (cues / words) * 1000 >= ACADEMIC_RATE
}

/**
 * The marks of a container that belong in an authorship report.
 *
 * Everything confirmed, plus provenance whatever its verdict: a C2PA manifest
 * or a generator tag says which tool touched the file. Author names, editing
 * time and camera EXIF are left out: every .docx has them, and listing them
 * beside a verdict about writing would make an ordinary file look marked.
 */
export function fileMarksFrom(findings: readonly Finding[]): FileMark[] {
  return findings
    .filter(
      (f) =>
        f.verdict === 'confirmed' ||
        ((f.kind === 'c2pa' || f.kind === 'generator_tag') && f.verdict === 'probable'),
    )
    .map((f) => ({
      origin: 'file' as const,
      kind: f.kind,
      verdict: f.verdict,
      label: f.label,
      ...(f.where ? { where: f.where } : {}),
      ...(f.evidence ? { evidence: f.evidence } : {}),
      ...(f.placement ? { placement: f.placement } : {}),
      ...(f.c2pa ? { c2pa: { origin: f.c2pa.origin, statement: f.c2pa.statement } } : {}),
    }))
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
    : UNWEIGHTED.has(hit.entry.category) || hit.entry.category === 'register'
      ? 'low'
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

/** A run of paragraphs shorter than this does not make a block of its own. */
const MIN_RUN_WORDS = 60

interface Run {
  lang: Lang | 'other'
  first: number
  last: number
  words: number
  /** Words per language, for the run's majority once short runs are merged in. */
  byLang: Map<Lang | 'other', number>
}

/**
 * Consecutive paragraphs in one language, short interruptions absorbed.
 *
 * A keyword line or a one-line quotation in the other language would
 * otherwise cut an article into three blocks too short to assess. A run under
 * MIN_RUN_WORDS joins the run before it (or after it, at the start), and the
 * merged run takes the language most of its words are in.
 */
function languageRuns(routing: Routing, seg: Segmentation): Run[] {
  const words = seg.blocks.map(() => 0)
  for (const sentence of seg.sentences)
    words[sentence.paragraphIndex] = (words[sentence.paragraphIndex] ?? 0) + sentence.words

  // A paragraph too short to identify on its own is routed with the
  // document's language, but it is no evidence of where a block starts: it
  // joins the run it sits in.
  let runs: Run[] = []
  let neutral: { first: number; words: number } | undefined
  seg.blocks.forEach((_, index) => {
    const count = words[index] ?? 0
    if (count === 0) return
    const detected = routing.detected[index]
    const last = runs.at(-1)
    if (detected === undefined) {
      if (last) {
        last.last = index
        last.words += count
      } else neutral = { first: neutral?.first ?? index, words: (neutral?.words ?? 0) + count }
      return
    }
    const lang: Lang | 'other' = detected === 'fr' || detected === 'en' ? detected : 'other'
    if (last && last.lang === lang) {
      last.last = index
      last.words += count
      last.byLang.set(lang, (last.byLang.get(lang) ?? 0) + count)
    } else {
      runs.push({
        lang,
        first: neutral?.first ?? index,
        last: index,
        words: count + (neutral?.words ?? 0),
        byLang: new Map([[lang, count]]),
      })
      neutral = undefined
    }
  })
  if (neutral) {
    const lang = routing.document === 'und' ? 'other' : routing.document
    runs.push({
      lang,
      first: neutral.first,
      last: seg.blocks.length - 1,
      words: neutral.words,
      byLang: new Map([[lang, neutral.words]]),
    })
  }

  for (let changed = true; changed && runs.length > 1;) {
    changed = false
    const at = runs.findIndex((run) => run.words < MIN_RUN_WORDS)
    if (at === -1) break
    const run = runs[at] as Run
    const into = runs[at > 0 ? at - 1 : at + 1] as Run
    into.first = Math.min(into.first, run.first)
    into.last = Math.max(into.last, run.last)
    into.words += run.words
    for (const [lang, count] of run.byLang)
      into.byLang.set(lang, (into.byLang.get(lang) ?? 0) + count)
    into.lang = [...into.byLang.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? into.lang
    runs.splice(at, 1)
    changed = true
    // Two neighbours that now share a language are one run.
    const merged: Run[] = []
    for (const next of runs) {
      const previous = merged.at(-1)
      if (previous && previous.lang === next.lang) {
        previous.last = next.last
        previous.words += next.words
        for (const [lang, count] of next.byLang)
          previous.byLang.set(lang, (previous.byLang.get(lang) ?? 0) + count)
      } else merged.push(next)
    }
    runs = merged
  }
  return runs
}

/** Everything outside `[start, end)` blanked, offsets and lines kept. */
const only = (text: string, start: number, end: number) =>
  blank(text.slice(0, start)) + text.slice(start, end) + blank(text.slice(end))

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

/**
 * The document's verdict from its blocks' verdicts.
 *
 * The score is the word-weighted mean of the assessed blocks' scores. The
 * guards hold block by block: `likely_ai` needs a block that is itself
 * `likely_ai`, and "few signals" needs every assessed block to say so.
 */
function combineBlocks(
  blocks: readonly LanguageBlock[],
  thresholds: { human: number; ai: number; humanReachable: boolean },
  guarded: boolean,
): Pick<AuthorshipReport, 'verdict' | 'score' | 'confidence'> | undefined {
  const assessed = blocks.filter((b) => b.score !== null && b.lang !== 'other')
  if (assessed.length < 2) return undefined
  const words = assessed.reduce((sum, b) => sum + b.words, 0)
  const score = assessed.reduce((sum, b) => sum + (b.score as number) * b.words, 0) / words
  let verdict: AuthorshipVerdict = 'uncertain'
  if (score >= thresholds.ai && assessed.some((b) => b.verdict === 'likely_ai'))
    verdict = 'likely_ai'
  else if (
    thresholds.humanReachable &&
    score < thresholds.human &&
    !guarded &&
    assessed.every((b) => b.verdict === 'likely_human')
  )
    verdict = 'likely_human'
  const confidence = assessed.reduce<Confidence>(
    (low, b) => (CONFIDENCE_RANK[b.confidence] < CONFIDENCE_RANK[low] ? b.confidence : low),
    'high',
  )
  return { verdict, score: Math.round(score * 1000) / 1000, confidence }
}

export function detectAuthorship(input: string, options: DetectOptions = {}): AuthorshipReport {
  const calibration = options.calibration ?? CALIBRATION
  const text = options.format === 'HTML' ? htmlAsProse(input) : input

  // Lines and columns always address the input as given, not its prose view.
  const seg = segment(text, protectedMask(text), lineIndex(input))
  const routing = route(text, seg, options.lang ?? 'auto')
  const register = options.register ?? 'general'
  const hits = scan(text, seg, options.format, register)
  const marks = technicalMarks(input)
  const scored = scoreSentences(seg, measure(text, seg, hits, marks), hits)
  const style = analyzeStyle(text)
  const lang = routing.document === 'und' ? 'en' : routing.document
  const fileMarks = [...(options.fileMarks ?? [])]
  const where = options.layout ? locator(text, options.layout) : () => undefined
  const located = (start: number, end?: number) => {
    const location = where(start, end)
    return location ? { location } : {}
  }

  // The forensic signal reads the prose. When the file carries marks of its
  // own, its line says so rather than "no technical mark" beside a verdict
  // held at uncertain by those very marks.
  const filed = (signal: ReturnType<typeof builtInSignals>[number]) =>
    signal.id === 'forensic' && fileMarks.length > 0
      ? {
          ...signal,
          detail: `${signal.value === 0 ? 'nothing in the prose itself, no chat residue and no hidden character' : signal.detail}; the file carries ${fileMarks.length} mark${fileMarks.length === 1 ? '' : 's'} of its own (see File marks)`,
        }
      : signal
  const signals = [
    ...builtInSignals(
      { words: seg.words, lang, spans: scored, hits, marks, style, reuse: wordReuse(text, seg) },
      calibration,
    ).map(filed),
    ...(options.external ?? []).map(fromExternal),
  ]

  const counted = hits.filter((hit) => hit.counted)
  const residue = counted.some((hit) => hit.entry.category === 'residue')
  // Guard B reads the file's marks too: a confirmed manifest on an embedded
  // image says nothing about the prose, but "few signals" is still not a thing
  // to say about a file carrying one.
  const technical = marks.length > 0 || fileMarks.some((mark) => mark.verdict === 'confirmed')
  const result = decide({
    words: seg.words,
    unsupported:
      routing.unsupportedShare > 0.5 || (routing.document === 'und' && seg.words >= MIN_WORDS),
    signals,
    residue,
    technical,
    calibration,
  })
  const thresholds = {
    human: result.human,
    ai: calibration.thresholds.ai,
    humanReachable: result.humanReachable,
  }

  const listedHits = options.allFindings === true ? hits : counted
  const findings: AuthorshipFinding[] = listedHits.map((hit) => {
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
      ...(hit.counted ? {} : { counted: false }),
      ...located(hit.start, hit.end),
    }
  })

  // Language blocks. One block is the document; several are each assessed on
  // their own, and the document's verdict becomes their combination.
  const runs = options.singleBlock === true ? [] : languageRuns(routing, seg)
  const blocks: LanguageBlock[] = runs.map((run) => {
    const start = seg.blocks[run.first]?.start ?? 0
    const end = seg.blocks[run.last]?.end ?? text.length
    const base = {
      lang: run.lang,
      start,
      end,
      line: seg.index.locate(start).line,
      endLine: seg.index.locate(end).line,
      words: run.words,
      ...(where(start) ? { location: where(start) as Location } : {}),
      ...(where(Math.max(start, end - 1))
        ? { endLocation: where(Math.max(start, end - 1)) as Location }
        : {}),
    }
    if (runs.length === 1) {
      return {
        ...base,
        verdict: result.verdict,
        score: result.score,
        confidence: result.confidence,
      }
    }
    if (run.lang === 'other' || run.words < MIN_WORDS) {
      return {
        ...base,
        verdict: 'insufficient_evidence' as const,
        score: null,
        confidence: 'low' as const,
        abstainReason:
          run.lang === 'other' ? ('unsupported_language' as const) : ('too_short' as const),
      }
    }
    const { layout: _layout, ...rest } = options
    const own = detectAuthorship(only(input, start, end), {
      ...rest,
      lang: run.lang,
      singleBlock: true,
    })
    return {
      ...base,
      verdict: own.verdict,
      score: own.score,
      confidence: own.confidence,
      ...(own.abstainReason ? { abstainReason: own.abstainReason } : {}),
    }
  })
  const combined =
    result.verdict === 'insufficient_evidence' && result.abstainReason === 'too_short'
      ? undefined
      : combineBlocks(blocks, thresholds, residue || technical)

  const unsupported: UnsupportedSegment[] = []
  seg.blocks.forEach((block, index) => {
    const detected = routing.detected[index]
    if (!detected || detected === 'fr' || detected === 'en') return
    const own = seg.sentences.filter((s) => s.paragraphIndex === index)
    const count = own.reduce((sum, s) => sum + s.words, 0)
    if (count === 0) return
    unsupported.push({
      lang: detected,
      words: count,
      line: seg.index.locate(block.start).line,
      excerpt: excerptOf(text, block.start, block.end, block.start, block.end),
      ...located(block.start, block.end),
    })
  })

  // The formulas of a register, found alone, are named as what they are.
  const isolated = new Map<string, { sample: string; count: number }>()
  for (const hit of hits) {
    if (hit.entry.category !== 'register' || hit.counted) continue
    const phrase = text.slice(hit.start, hit.end).replaceAll(/\s+/gu, ' ').toLowerCase()
    const entry = isolated.get(hit.entry.id) ?? { sample: phrase, count: 0 }
    entry.count += 1
    isolated.set(hit.entry.id, entry)
  }
  const notEvidence =
    isolated.size === 0
      ? NOT_EVIDENCE
      : [
          ...NOT_EVIDENCE,
          `Formulas of the academic register, each on its own here and so not counted: ${[...isolated.values()].map((e) => `“${e.sample}”${e.count > 1 ? ` ×${e.count}` : ''}`).join(', ')}.`,
        ]

  const langs = new Set<string>(['any', ...routing.paragraphs.filter(Boolean)] as string[])
  const read = entriesFor(register).filter((entry) => langs.has(entry.lang))
  const coverage = {
    register,
    academicCues: readsAcademic(text, seg.words),
    patterns: read.length,
    matched: new Set(hits.map((hit) => hit.entry.id)).size,
    counted: new Set(hits.filter((hit) => hit.counted).map((hit) => hit.entry.id)).size,
  }

  const headings = blocksOf(text)
    .filter((block) => block.kind === 'heading')
    .map((block) => ({
      start: block.start,
      title: text
        .slice(block.start, block.end)
        .replace(/^#+\s*/u, '')
        .trim(),
    }))
  const sectionOf = (offset: number, paragraph: number): string => {
    if (options.layout) return where(offset)?.section ?? '(before the first heading)'
    const heading = headings.findLast((h) => h.start <= offset)
    return heading?.title ?? `¶${paragraph + 1}`
  }
  const loops = options.singleBlock
    ? []
    : recaps(text, seg, sectionOf, options.layout ? '(before the first heading)' : undefined).map(
        (recap) => ({
          ...recap,
          occurrences: recap.occurrences.map((o) => ({
            ...o,
            line: seg.index.locate(o.start).line,
            ...located(o.start, o.end),
          })),
        }),
      )

  return {
    schemaVersion: 1,
    engine: { name: 'unmark', version: VERSION },
    calibration: { id: calibration.id, calibrated: calibration.calibrated, date: calibration.date },
    verdict: combined?.verdict ?? result.verdict,
    score: combined?.score ?? result.score,
    confidence: combined?.confidence ?? result.confidence,
    ...(result.abstainReason && !combined ? { abstainReason: result.abstainReason } : {}),
    language: {
      document: routing.document,
      unsupportedShare: Math.round(routing.unsupportedShare * 1000) / 1000,
      unsupported,
    },
    blocks,
    words: seg.words,
    sentences: seg.sentences.length,
    thresholds,
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
        ...located(span.start, span.end),
      })),
    findings,
    technicalMarks: marks.map((mark) => ({
      ...mark,
      ...seg.index.locate(mark.offset),
      ...located(mark.offset),
    })),
    fileMarks,
    ...(options.document
      ? {
          document: {
            ...options.document,
            ...(options.layout?.pages
              ? {
                  placed: options.layout.paragraphs.filter(
                    (p) => where(p.start, p.end)?.page !== undefined,
                  ).length,
                }
              : {}),
          },
        }
      : {}),
    recaps: loops,
    coverage,
    style,
    notEvidence,
    disclaimer: DISCLAIMER,
  }
}

export {
  ABSENCE_NOTE,
  authorshipFindings,
  coverageSentence,
  DISCLAIMER,
  documentSentence,
  foundNothing,
  NOT_EVIDENCE,
  renderMarkdown,
  toJSON,
  topSpans,
  UNREACHABLE_NOTE,
  verdictSentence,
} from './report.ts'
export type {
  AuthorshipFinding,
  AuthorshipReport,
  AuthorshipSpan,
  DocumentSource,
  FileMark,
  LanguageBlock,
  Coverage,
  LocatedFinding,
  Location,
  RecapLoop,
  RenderOptions,
  UnsupportedSegment,
} from './report.ts'
export type { Layout, LayoutParagraph, PageText } from './locate.ts'
export type { Register } from './features.ts'
export {
  describeLocation,
  layoutFromPages,
  searchable,
  sectionLabel,
  withoutFolio,
} from './locate.ts'
export type { AuthorshipVerdict, Confidence, AbstainReason } from './verdict.ts'
export type { ExternalSignal, Signal, EvidenceLabel } from './signals.ts'
export type { Calibration } from './calibration.ts'
export { CALIBRATION } from './calibration.ts'
export { HUMAN_FLOOR, MIN_WORDS as MIN_AUTHORSHIP_WORDS, weightedScore } from './verdict.ts'
export type { LangOption } from './route.ts'
export { formatOfPaste } from './paste.ts'
