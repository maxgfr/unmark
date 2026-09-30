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

import type { Finding } from '../../report.ts'
import type { StyleReport } from '../stylometry.ts'
import type { Category, Tier } from './catalogue/index.ts'
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
}

export interface LocatedFinding extends Finding {
  line: number
  col: number
}

export interface AuthorshipReport {
  schemaVersion: 1
  engine: { name: 'unmark'; version: string }
  calibration: { id: string; calibrated: boolean; date: string | null }
  verdict: AuthorshipVerdict
  score: number | null
  confidence: Confidence
  abstainReason?: AbstainReason
  language: { document: Lang | 'und'; unsupportedShare: number }
  /** Words of unsealed prose: what the 150-word threshold counts. */
  words: number
  sentences: number
  thresholds: { human: number; ai: number }
  signals: Signal[]
  /** Sentences scoring in the low band or above, in document order. */
  spans: AuthorshipSpan[]
  findings: AuthorshipFinding[]
  technicalMarks: LocatedFinding[]
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

/** The verdict as the sentence a reader sees. */
export function verdictSentence(
  report: Pick<AuthorshipReport, 'verdict' | 'abstainReason'>,
): string {
  switch (report.verdict) {
    case 'likely_ai': {
      return 'Likely AI-written'
    }
    case 'uncertain': {
      return 'Uncertain: the signals are mixed'
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
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('\n', ' ')

const fixed = (value: number) => value.toFixed(2)

export interface RenderOptions {
  /** Sentences below this score are not listed. The verdict never changes. */
  minScore?: number
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
  out.push(
    `Engine: unmark ${report.engine.version} · calibration \`${report.calibration.id}\`` +
      (report.calibration.calibrated
        ? ` (${report.calibration.date ?? 'undated'})`
        : ' (not yet calibrated: thresholds are provisional)') +
      ` · thresholds ${fixed(report.thresholds.human)} / ${fixed(report.thresholds.ai)}`,
    '',
  )

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

  out.push('## Passages', '')
  if (listed.length === 0 && loose.length === 0) {
    out.push(`No passage scored ${fixed(minScore)} or more.`, '')
  } else {
    out.push(
      '| Line | Excerpt | Score | Pattern | Reason | Fix |',
      '| ---: | --- | ---: | --- | --- | --- |',
    )
    const rows: { line: number; row: string }[] = []
    for (const span of listed) {
      const own = report.findings.filter((finding) => inside(finding, span))
      const lead = [...own].sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity])[0]
      const patterns = own.length > 0 ? [...new Set(own.map((f) => f.patternId))] : span.reasons
      rows.push({
        line: span.line,
        row: `| ${span.line} | ${cell(span.excerpt)} | ${fixed(span.score)}${span.lowConfidence ? ' (short)' : ''} | ${cell(patterns.join(', '))} | ${cell(lead?.reason ?? featureReason(span.reasons))} | ${cell(lead?.fixHint ?? featureFix(span.reasons))} |`,
      })
    }
    for (const finding of loose) {
      rows.push({
        line: finding.line,
        row: `| ${finding.line} | ${cell(finding.excerpt)} | — | ${cell(finding.patternId)} | ${cell(finding.reason)} | ${cell(finding.fixHint)} |`,
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
      out.push(`| ${mark.line} | ${cell(mark.kind)} | ${mark.verdict} | ${cell(mark.label)} |`)
    }
    out.push('')
  }

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
    'em dashes doing the work of commas, colons and full stops',
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
