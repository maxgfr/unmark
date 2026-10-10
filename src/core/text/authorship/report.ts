// The authorship report, as data and as a page a person reads.
//
// Two rules hold for every rendering of it, in the terminal, as Markdown, in
// the browser:
//
//   The verdict is a sentence, and the note that it is not proof sits right
//   under it — never in a footer, never behind a click.
//
//   The lowest verdict is "few AI-writing signals found". Nothing here ever
//   says a person wrote the text: absence of habits is not a signature.

import type { Finding, FindingKind, Placement, Verdict } from '../../report.ts'
import type { C2paOrigin } from '../../container/c2pa.ts'
import type { StyleReport } from '../stylometry.ts'
import type { Category, Tier } from './catalogue/index.ts'
import { describeLocation } from './locate.ts'
import type { Lang } from './segment.ts'
import type { Signal, EvidenceLabel } from './signals.ts'
import type { Band } from './spans.ts'
import type { AbstainReason, AuthorshipVerdict, Confidence } from './verdict.ts'

export const DISCLAIMER =
  'Not proof. This reads writing habits that generated text shares with many people: humans write like this too, and generated text can be edited to avoid every check here. Do not use it as the basis for an accusation, a grade or a disciplinary decision.'

/** What the engine deliberately does not count, said on every report. */
export const NOT_EVIDENCE: readonly string[] = [
  'The subject of the text, including a text about AI.',
  'A formal, administrative or academic register.',
  'Phrasing typical of a writer working in a second language.',
  'Clean spelling and grammar.',
  'Em dashes, or one stock phrase, on their own.',
  'Anything under 150 words of prose: there is no verdict at that length.',
]

export type Severity = 'high' | 'medium' | 'low'

/**
 * Where a passage sits in the document a reader holds, when that is known:
 * read from a .docx or a PDF, or from a PDF given with `--pages`.
 */
export interface Location {
  /**
   * 1-based ordinal of the paragraph in the source document: for a .docx,
   * among every paragraph of the body, as `inspect` counts a picture's.
   */
  paragraph?: number
  page?: number
  /** The heading it sits under, as written. */
  section?: string
}

/**
 * A stretch of consecutive paragraphs in one language, and its own verdict.
 *
 * A thesis with a French introduction, an English article and a French
 * conclusion is three blocks. Each is assessed with its own catalogue and its
 * own statistics; the document's verdict is their word-weighted combination.
 */
export interface LanguageBlock {
  /** `other` for a language with no catalogue. */
  lang: Lang | 'other'
  start: number
  end: number
  line: number
  endLine: number
  words: number
  verdict: AuthorshipVerdict
  score: number | null
  confidence: Confidence
  abstainReason?: AbstainReason
  location?: Location
  endLocation?: Location
}

/** A paragraph read as a language with no catalogue: what `unsupportedShare` counts. */
export interface UnsupportedSegment {
  /** ISO 639-1, as detected. */
  lang: string
  words: number
  line: number
  excerpt: string
  location?: Location
}

/**
 * A mark found in the file the text came from, not in the text: a C2PA
 * manifest on an embedded image, a generator tag. Reported apart because it
 * says something about the file's history, never about who wrote the prose.
 */
export interface FileMark {
  origin: 'file'
  kind: FindingKind
  verdict: Verdict
  label: string
  /** The part of the container it was found in: `word/media/image24.png`. */
  where?: string
  evidence?: string
  /** A picture's paragraph and caption: "Figure 4. …". */
  placement?: Placement
  /** For a C2PA manifest, what it declares: made by a model, or handled by a tool. */
  c2pa?: { origin: C2paOrigin; statement: string }
}

export interface AuthorshipFinding {
  /** `patternId@start`, stable for a given text. */
  id: string
  patternId: string
  category: Category
  tier: Tier
  start: number
  end: number
  line: number
  col: number
  /** At most 90 characters of the surrounding sentence, whitespace flattened. */
  excerpt: string
  reason: string
  fixHint: string
  evidenceLabel: EvidenceLabel
  severity: Severity
  /** Present, and false, on a match the tier rules did not count (`allFindings`). */
  counted?: false
  location?: Location
}

export interface AuthorshipSpan {
  start: number
  end: number
  line: number
  col: number
  endLine: number
  words: number
  score: number
  band: Band
  lowConfidence: boolean
  reasons: string[]
  excerpt: string
  lang?: Lang
  location?: Location
}

export interface LocatedFinding extends Finding {
  line: number
  col: number
  location?: Location
}

/** A key phrase copied word for word into two sections or more. */
export interface RecapLoop {
  phrase: string
  words: number
  /** A copy sits in an abstract or a summary, which restates the body by design. */
  summary: boolean
  occurrences: {
    start: number
    end: number
    line: number
    section: string
    location?: Location
  }[]
}

/**
 * How much of the catalogue applied to this text, so a score of 0 can be read
 * as "looked and found nothing" or as "out of the catalogue's reach".
 */
export interface Coverage {
  /** The register whose formulas were read: `academic` with `--register academic`. */
  register: 'general' | 'academic'
  /** Citations, "et al.", confidence intervals: the text reads as academic. */
  academicCues: boolean
  /** Catalogue entries read for the languages of this text. */
  patterns: number
  /** Entries that matched at least once, counted or not. */
  matched: number
  /** Entries whose matches counted. */
  counted: number
}

/** What the prose was read from, when it was not plain text. */
export interface DocumentSource {
  container: string
  paragraphs: number
  /** Paragraphs left out (tables, captions, references, contents, an oath), by reason. */
  skipped?: Partial<Record<string, number>>
  pages?: number
  unreadablePages?: number[]
  /** Pages were placed from this PDF (`--pages`). */
  pagesFrom?: string
  /** Paragraphs that could be placed on a page, out of `paragraphs`. */
  placed?: number
  paged?: boolean
}

export interface AuthorshipReport {
  schemaVersion: 1
  engine: { name: 'unmark'; version: string }
  calibration: { id: string; calibrated: boolean; date: string | null }
  verdict: AuthorshipVerdict
  score: number | null
  confidence: Confidence
  abstainReason?: AbstainReason
  language: {
    document: Lang | 'und'
    unsupportedShare: number
    /** The paragraphs behind `unsupportedShare`, each with its detected language. */
    unsupported: UnsupportedSegment[]
  }
  /** Consecutive paragraphs in one language; more than one in a mixed document. */
  blocks: LanguageBlock[]
  /** Words of unsealed prose: what the 150-word threshold counts. */
  words: number
  sentences: number
  /**
   * The thresholds applied. `human` is the fitted one raised to the floor;
   * `humanReachable` is false when no score could ever read as `likely_human`.
   */
  thresholds: { human: number; ai: number; humanReachable: boolean }
  signals: Signal[]
  /** Sentences scoring in the low band or above, in document order. */
  spans: AuthorshipSpan[]
  findings: AuthorshipFinding[]
  technicalMarks: LocatedFinding[]
  /** Marks of the container the text was read from. Empty for plain text. */
  fileMarks: FileMark[]
  /** What the prose was read from, when that was a .docx or a PDF. */
  document?: DocumentSource
  /** Key phrases recopied across sections (recap loops), each with every copy. */
  recaps: RecapLoop[]
  coverage: Coverage
  style: StyleReport
  notEvidence: readonly string[]
  disclaimer: string
}

const MAX_EXCERPT = 90

/**
 * A readable window of `[from, to)` around `[start, end)`.
 *
 * Flattened to one line because it lands in a table cell, and cut around the
 * match rather than from the left, so a long sentence still shows the words
 * the report is about.
 */
export function excerptOf(
  text: string,
  start: number,
  end: number,
  from: number,
  to: number,
): string {
  const flat = (s: string) => s.replaceAll(/\s+/gu, ' ')
  // Only a neighbourhood of the match is ever shown. Flattening the whole
  // passage first made every excerpt of a one-megabyte line cost a megabyte.
  const slack = 4 * MAX_EXCERPT
  if (to - from > 2 * slack + (end - start)) {
    return excerptOf(text, start, end, Math.max(from, start - slack), Math.min(to, end + slack))
  }
  const whole = flat(text.slice(from, to)).trim()
  if (whole.length <= MAX_EXCERPT) return whole

  const room = MAX_EXCERPT - 2
  const matchLength = Math.min(end - start, room)
  const before = Math.floor((room - matchLength) / 2)
  let left = Math.max(from, start - before)
  const right = Math.min(to, left + room)
  left = Math.max(from, right - room)
  return `${left > from ? '…' : ''}${flat(text.slice(left, right)).trim()}${right < to ? '…' : ''}`
}

const LANGUAGE: Record<Lang | 'und', string> = { fr: 'French', en: 'English', und: 'undetermined' }

/** Nothing at all was found: a score of zero and no catalogue finding. */
export const foundNothing = (
  report: Partial<Pick<AuthorshipReport, 'score' | 'findings' | 'spans'>>,
): boolean =>
  report.score === 0 &&
  (report.findings?.length ?? 0) === 0 &&
  (report.spans ?? []).every((span) => span.band === 'none')

/** Said under every verdict that rests on finding nothing. */
export const ABSENCE_NOTE =
  'The absence of signals is not proof that a person wrote the text: it only says the habits this engine reads were not found.'

/** Said whenever the calibration leaves `likely_human` out of reach. */
export const UNREACHABLE_NOTE =
  'The verdict `likely_human` is unreachable with this calibration: its human threshold is not below its AI threshold.'

/** The verdict as the sentence a reader sees. */
export function verdictSentence(
  report: Pick<AuthorshipReport, 'verdict' | 'abstainReason'> &
    Partial<
      Pick<
        AuthorshipReport,
        'score' | 'findings' | 'spans' | 'thresholds' | 'technicalMarks' | 'fileMarks'
      >
    >,
): string {
  switch (report.verdict) {
    case 'likely_ai': {
      return 'Likely AI-written'
    }
    case 'uncertain': {
      // "Not enough to call it either way" read as a suspicion on a text where
      // nothing at all had been found. Uncertain then only means a guard held
      // the verdict back — a technical mark, or a calibration that cannot say
      // `likely_human` — and the sentence says what was actually found.
      if (foundNothing(report)) return 'No AI-writing signal found'
      // Guard B held back "few signals" because of a mark: say both halves.
      const marked =
        (report.technicalMarks?.length ?? 0) > 0 ||
        (report.fileMarks ?? []).some((mark) => mark.verdict === 'confirmed')
      if (
        marked &&
        report.score !== null &&
        report.score !== undefined &&
        report.thresholds?.humanReachable === true &&
        report.score < report.thresholds.human
      )
        return 'Few AI-writing signals in the prose, but the file carries a technical mark'
      return 'Uncertain: not enough to call it either way'
    }
    case 'likely_human': {
      return 'Few AI-writing signals found'
    }
    default: {
      return report.abstainReason === 'unsupported_language'
        ? 'Not assessed: the prose is mostly in a language other than French or English'
        : 'Not enough text to assess (under 150 words of prose)'
    }
  }
}

const cell = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', ' ')

const fixed = (value: number) => value.toFixed(2)

export interface RenderOptions {
  /** Sentences below this score are not listed. The verdict never changes. */
  minScore?: number
  /** The spans are the n highest-scoring sentences (`--top`), not a band. */
  top?: number
}

/** How much of the catalogue applied, in one sentence. */
export function coverageSentence(coverage: Coverage): string {
  const base = `Catalogue: ${coverage.patterns} patterns read${coverage.register === 'academic' ? ', the academic register included' : ''}; ${coverage.matched} matched, ${coverage.counted} counted.`
  return coverage.register === 'general' && coverage.academicCues
    ? `${base} The text reads as academic (citations, statistics): --register academic also reads that register's formulas.`
    : base
}

/** The report as Markdown, for a file, a pull request or a skill to rework. */
export function renderMarkdown(report: AuthorshipReport, options: RenderOptions = {}): string {
  const minScore = options.minScore ?? 0.35
  const out: string[] = ['# Authorship assessment', '']

  const facts = [
    `**${verdictSentence(report)}**`,
    ...(report.score === null ? [] : [`score ${fixed(report.score)}`]),
    `confidence ${report.confidence}`,
    LANGUAGE[report.language.document],
    `${report.words} words`,
  ]
  out.push(facts.join(' · '), '', `> ${report.disclaimer}`, '')
  if (report.verdict === 'likely_human' || foundNothing(report)) out.push(`> ${ABSENCE_NOTE}`, '')
  if (!report.thresholds.humanReachable) out.push(`> ${UNREACHABLE_NOTE}`, '')
  out.push(
    `Engine: unmark ${report.engine.version} · calibration \`${report.calibration.id}\`` +
      (report.calibration.calibrated
        ? ` (${report.calibration.date ?? 'undated'})`
        : ' (not yet calibrated: thresholds are provisional)') +
      ` · thresholds ${fixed(report.thresholds.human)} / ${fixed(report.thresholds.ai)}`,
    '',
  )
  if (report.document) out.push(`Read from: ${documentSentence(report.document)}`, '')

  if (report.blocks.length > 1) {
    out.push(
      '## Blocks',
      '',
      'Consecutive paragraphs in one language, each assessed with its own catalogue; the verdict above is their word-weighted combination.',
      '',
      '| Language | From | To | Words | Verdict | Score |',
      '| --- | --- | --- | ---: | --- | ---: |',
    )
    for (const block of report.blocks) {
      out.push(
        `| ${BLOCK_LANGUAGE[block.lang]} | ${cell(describeLocation(block.location) ?? `line ${block.line}`)} | ${cell(describeLocation(block.endLocation) ?? `line ${block.endLine}`)} | ${block.words} | ${cell(verdictSentence(block))} | ${block.score === null ? '—' : fixed(block.score)} |`,
      )
    }
    out.push('')
  }

  out.push('## Why', '')
  for (const signal of report.signals) {
    const value = signal.value === null ? 'not measured' : fixed(signal.value)
    out.push(`- ${signal.label}: ${value} — ${signal.detail}`)
  }
  out.push('')

  const listed = report.spans.filter((span) => span.score >= minScore)
  const inside = (finding: AuthorshipFinding, span: AuthorshipSpan) =>
    finding.start >= span.start && finding.start < span.end
  const loose = report.findings.filter(
    (finding) =>
      (finding.category === 'residue' || finding.category === 'formatting') &&
      !listed.some((span) => inside(finding, span)),
  )

  const located = [...listed, ...loose].some((item) => item.location !== undefined)
  const place = (item: { line: number; location?: Location }) =>
    cell(describeLocation(item.location) ?? `line ${item.line}`)
  const at = (item: { line: number; location?: Location }) =>
    located ? place(item) : String(item.line)

  out.push(options.top === undefined ? '## Passages' : `## Top ${options.top} sentences`, '')
  if (options.top !== undefined)
    out.push(
      'The sentences scoring highest, whatever their band: material for a judge, not evidence.',
      '',
    )
  if (listed.length === 0 && loose.length === 0) {
    out.push(`No passage scored ${fixed(minScore)} or more.`, '')
  } else {
    out.push(
      `| ${located ? 'Where' : 'Line'} | Excerpt | Score | Pattern | Reason | Fix |`,
      `| ${located ? '---' : '---:'} | --- | ---: | --- | --- | --- |`,
    )
    const rows: { line: number; row: string }[] = []
    for (const span of listed) {
      const own = report.findings.filter((finding) => inside(finding, span))
      const lead = [...own].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])[0]
      const patterns = own.length > 0 ? [...new Set(own.map((f) => f.patternId))] : span.reasons
      rows.push({
        line: span.line,
        row: `| ${at(span)} | ${cell(span.excerpt)} | ${fixed(span.score)}${span.lowConfidence ? ' (short)' : ''} | ${cell(patterns.join(', '))} | ${cell(lead?.reason ?? featureReason(span.reasons))} | ${cell(lead?.fixHint ?? featureFix(span.reasons))} |`,
      })
    }
    for (const finding of loose) {
      rows.push({
        line: finding.line,
        row: `| ${at(finding)} | ${cell(finding.excerpt)} | — | ${cell(finding.patternId)} | ${cell(finding.reason)} | ${cell(finding.fixHint)} |`,
      })
    }
    out.push(...rows.sort((a, b) => a.line - b.line).map((r) => r.row), '')
  }

  if (report.technicalMarks.length > 0) {
    out.push(
      '## Technical marks',
      '',
      '| Line | Mark | Verdict | Detail |',
      '| ---: | --- | --- | --- |',
    )
    for (const mark of report.technicalMarks) {
      out.push(`| ${place(mark)} | ${cell(mark.kind)} | ${mark.verdict} | ${cell(mark.label)} |`)
    }
    out.push('')
  }

  if (report.fileMarks.length > 0) {
    out.push(
      '## File marks',
      '',
      'Found in the file the text was read from, not in the prose: they say which tools handled the file, never who wrote the text.',
      '',
      '| Part | Placement | Mark | Verdict | Detail |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const mark of report.fileMarks) {
      const placement = mark.placement
        ? [`paragraph ${mark.placement.paragraph}`, mark.placement.caption]
            .filter(Boolean)
            .join(', ')
        : '—'
      out.push(
        `| ${cell(mark.where ?? '—')} | ${cell(placement)} | ${cell(mark.kind)} | ${mark.verdict} | ${cell(mark.label)} |`,
      )
    }
    out.push('')
  }

  if (report.language.unsupported.length > 0) {
    out.push(
      '## Not assessed',
      '',
      `${Math.round(report.language.unsupportedShare * 100)} % of the words are in paragraphs read as a language with no catalogue:`,
      '',
      '| Where | Language | Words | Excerpt |',
      '| --- | --- | ---: | --- |',
      ...report.language.unsupported.map(
        (segment) =>
          `| ${place(segment)} | ${segment.lang} | ${segment.words} | ${cell(segment.excerpt)} |`,
      ),
      '',
    )
  }

  if (report.recaps.length > 0) {
    out.push(
      '## Repeated formulas',
      '',
      'The same phrase copied word for word into several sections.',
      '',
      '| Phrase | Copies | Where |',
      '| --- | ---: | --- |',
    )
    for (const recap of report.recaps) {
      out.push(
        `| « ${cell(recap.phrase)} »${recap.summary ? ' (one copy in a summary)' : ''} | ${recap.occurrences.length} | ${cell(recap.occurrences.map((o) => describeLocation(o.location) ?? `line ${o.line}`).join(' · '))} |`,
      )
    }
    out.push('')
  }

  const unweighted = report.findings.filter(
    (f) => f.category === 'hedging' || f.category === 'phrasing',
  )
  if (unweighted.length > 0) {
    out.push(
      '## Hedging and wordy phrasing',
      '',
      'Reported, located, and not scored: the calibration has not measured them yet.',
      '',
      `| ${located ? 'Where' : 'Line'} | Excerpt | Pattern | Fix |`,
      '| --- | --- | --- | --- |',
      ...unweighted.map(
        (f) => `| ${at(f)} | ${cell(f.excerpt)} | ${cell(f.patternId)} | ${cell(f.fixHint)} |`,
      ),
      '',
    )
  }

  out.push(coverageSentence(report.coverage), '')
  out.push('## What is not evidence', '', ...report.notEvidence.map((line) => `- ${line}`), '')

  out.push('## How to fix', '')
  // Grouped by what to do rather than by pattern: nine patterns that all say
  // "cut the connector" are one piece of advice, not nine.
  const byFix = new Map<string, { count: number; patterns: Set<string> }>()
  for (const finding of report.findings) {
    const entry = byFix.get(finding.fixHint) ?? { count: 0, patterns: new Set<string>() }
    entry.count += 1
    entry.patterns.add(finding.patternId)
    byFix.set(finding.fixHint, entry)
  }
  const groups = [...byFix.entries()].sort((a, b) => b[1].count - a[1].count)
  for (const [fix, { count, patterns }] of groups) {
    out.push(`- ${fix} — ${count}×: ${[...patterns].map((id) => `\`${id}\``).join(', ')}`)
  }
  if (groups.length > 0) out.push('')
  out.push(
    'For a checked rewrite: `unmark brief` lists what must change and what must survive, `unmark rewrite` does it, `unmark verify` rejects a rewrite that broke a fact. Run `unmark detect` again afterwards.',
    '',
  )

  return out.join('\n')
}

const SEVERITY: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

const BLOCK_LANGUAGE: Record<LanguageBlock['lang'], string> = {
  fr: 'French',
  en: 'English',
  other: 'other',
}

/** What the prose was read from and what was left out, in one sentence. */
export function documentSentence(source: DocumentSource): string {
  const skipped = Object.entries(source.skipped ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([reason, count]) => `${count} ${reason}`)
  return [
    `${source.container}, ${source.paragraphs} paragraphs`,
    ...(source.pages === undefined ? [] : [`${source.pages} pages`]),
    ...(skipped.length > 0 ? [`left out: ${skipped.join(', ')}`] : []),
    ...(source.pagesFrom
      ? [
          `${source.placed ?? 0} of ${source.paragraphs} paragraphs placed on a page of ${source.pagesFrom}`,
        ]
      : []),
    ...(source.unreadablePages?.length
      ? [`unreadable pages: ${source.unreadablePages.join(', ')}`]
      : []),
  ].join(' · ')
}

const FEATURE_TEXT: Record<string, [string, string]> = {
  'feature.repetition': [
    'repeats phrasing from the sentences around it',
    'say it once, in the place it matters',
  ],
  'feature.diversity': [
    'narrower vocabulary than the language usually has',
    'use the specific word each time instead of the general one',
  ],
  'feature.typography': [
    'dashes doing the work of commas, colons and full stops',
    'recast the sentence; a period, a comma or a colon each fit different cases',
  ],
}

const featureReason = (reasons: readonly string[]) =>
  reasons.map((r) => FEATURE_TEXT[r]?.[0]).find(Boolean) ??
  (reasons.some((r) => r.startsWith('mark.'))
    ? 'carries a technical mark'
    : 'several weak habits together')

const featureFix = (reasons: readonly string[]) =>
  reasons.map((r) => FEATURE_TEXT[r]?.[1]).find(Boolean) ??
  (reasons.some((r) => r.startsWith('mark.'))
    ? 'run `unmark clean` on the text'
    : 'rewrite the sentence')

/** The report as JSON, stable key order, for scripts and for the skill. */
export const toJSON = (report: AuthorshipReport): string => JSON.stringify(report, undefined, 2)

/**
 * The findings as ordinary `Finding`s, for surfaces that list those.
 *
 * Kind `ai_style`, which `isRemovable` excludes: they show as reported and a
 * clean pass never touches them. No `replacement`, because none is right —
 * `noFix` carries what a writer would do instead.
 */
export function authorshipFindings(report: AuthorshipReport): Finding[] {
  return report.findings.map((finding) => ({
    kind: 'ai_style',
    verdict: finding.severity === 'high' || finding.tier === 1 ? 'probable' : 'informational',
    offset: finding.start,
    length: finding.end - finding.start,
    label: `${finding.patternId}: ${finding.reason}`,
    evidence: finding.excerpt,
    noFix: finding.fixHint,
  }))
}

/**
 * The n sentences scoring highest, in document order (`--top`).
 *
 * Ties — most often at 0.00 on a careful text — are broken by how many habits
 * the sentence carries, counted or not, so a sentence with two stacked hedges
 * comes before one with nothing at all.
 */
export function topSpans(report: AuthorshipReport, n: number): AuthorshipSpan[] {
  const habits = (span: AuthorshipSpan) =>
    report.findings.filter((f) => f.start >= span.start && f.start < span.end).length
  return [...report.spans]
    .sort((a, b) => b.score - a.score || habits(b) - habits(a) || a.start - b.start)
    .slice(0, n)
    .sort((a, b) => a.start - b.start)
}
