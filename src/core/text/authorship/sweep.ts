// Every sentence that carries a habit, however isolated, with what to write instead.
//
// `detect` answers "does this read as generated", and on a careful thesis it
// rightly finds too little to say so. That leaves the question a reviser
// actually has unanswered: which sentences, exactly, would read better
// rewritten? A relevé done by hand on one thesis found 36 of them where the
// detector had listed none. `sweep` is that relevé: each sentence with a habit
// — catalogue entries counted or not, stacked hedges, formulas recopied from
// one section to another, announcements, closing lines, triads, figures with
// no reference call, dashes, connectors in series — with its location, the
// habit, a confidence, whether the register explains it, the current text
// quoted exactly, and a rewrite that has been checked to keep every number and
// every reference call.
//
// Pure, like the rest of the core. Rewrites come from three places: the
// deterministic humanise pass, a model the caller runs (`applyRewrites`), or
// an agent handed the prompt; every one goes through the same gate.

import { buildBrief, verifyRewrite } from '../../rewrite.ts'
import { humanise } from '../humanise.ts'
import { detectAuthorship, type DetectOptions } from './index.ts'
import type { AuthorshipReport, AuthorshipSpan, Location } from './report.ts'
import { searchable } from './locate.ts'

export type HabitType =
  | 'stacked_hedge'
  | 'repeated_formula'
  | 'stock_formula'
  | 'marker_vocabulary'
  | 'structure'
  | 'residue'
  | 'phrasing'
  | 'closing_line'
  | 'recap_connector'
  | 'connector_series'
  | 'promise_without_follow_up'
  | 'triad'
  | 'unsourced_figure'
  | 'em_dash'

export type SweepConfidence = 'high' | 'medium' | 'low'

export interface SweepHabit {
  type: HabitType
  /** One line: what the habit is, here. */
  detail: string
  /** The catalogue entry, when one matched. */
  patternId?: string
  confidence: SweepConfidence
  /** The register explains it: an academic formula, a recap in an abstract. */
  register: boolean
}

export interface SweepRewrite {
  text: string
  /** Where it came from: the deterministic pass, a model, an agent's file. */
  source: 'rule' | 'model' | 'agent'
  /** Cleared the gate: same numbers, same reference calls, no new tell. */
  verified: boolean
  /** Why it did not, when it did not. Such a rewrite is never proposed. */
  failures?: string[]
}

export interface SweepRow {
  /** `S` and the sentence's position, stable for a given text. */
  id: string
  start: number
  end: number
  line: number
  location?: Location
  /** The heading it sits under, from the layout or the Markdown; empty when none. */
  section: string
  /** The sentence, exactly as it is in the analysed text. */
  text: string
  habits: SweepHabit[]
  /** The strongest habit. */
  type: HabitType
  confidence: SweepConfidence
  /** Every habit on the row is one the register explains. */
  registerExplained: boolean
  /** The quote found word for word (spaces normalised) in each source checked. */
  quote: { checked: string[]; found: string[] }
  rewrite?: SweepRewrite
}

export interface SweepResult {
  rows: SweepRow[]
  /** Rows by habit type. */
  counts: Partial<Record<HabitType, number>>
  report: AuthorshipReport
}

export const HABIT_LABEL: Record<HabitType, string> = {
  stacked_hedge: 'stacked hedges',
  repeated_formula: 'formula repeated across sections',
  stock_formula: 'stock formula',
  marker_vocabulary: 'marker vocabulary',
  structure: 'sentence structure',
  residue: 'chat residue',
  phrasing: 'wordy phrasing',
  closing_line: 'closing line',
  recap_connector: 'recap connector',
  connector_series: 'connectors in series',
  promise_without_follow_up: 'announcement without follow-up',
  triad: 'triad',
  unsourced_figure: 'figure without a reference call',
  em_dash: 'dashes',
}

const RANK: Record<SweepConfidence, number> = { high: 2, medium: 1, low: 0 }

// ------------------------------------------------------------------ detectors

const CITATION =
  /\[\d{1,4}(?:\s*[,;–—-]\s*\d{1,4})*\]|\((?:[\p{Lu}][\p{L}'’-]+[^()]{0,40}?(?:19|20)\d{2})\)/u
const DIGIT = /\d/u
const RECAP = {
  en: /\b(?:therefore|thus|hence|consequently)\b/iu,
  fr: /(?<![\p{L}])(?:donc|ainsi|par conséquent|dès lors)(?![\p{L}])/iu,
}
const CONNECTOR = {
  en: /\b(?:however|nevertheless|nonetheless|moreover|furthermore|in addition|by contrast|conversely|also)\b/iu,
  fr: /(?<![\p{L}])(?:toutefois|néanmoins|cependant|pourtant|par ailleurs|en outre|de plus|en revanche|à l’inverse|à l'inverse)(?![\p{L}])/iu,
}
const PROMISE = {
  en: /\b(?:first(?:ly)?|in the first place|on the one hand)\b/iu,
  fr: /(?<![\p{L}])(?:d['’]abord|tout d['’]abord|premièrement|en premier lieu|d['’]une part)(?![\p{L}])/iu,
}
const FOLLOW_UP = {
  en: /\b(?:second(?:ly)?|then|next|also|finally|on the other hand|in the second place)\b/iu,
  fr: /(?<![\p{L}])(?:ensuite|puis|deuxièmement|en second lieu|enfin|également|aussi|d['’]autre part)(?![\p{L}])/iu,
}
const TRIAD = {
  en: /\b[\p{L}-]+(?: [\p{L}-]+){0,3}, (?:the |a |an |its |their )?[\p{L}-]+(?: [\p{L}-]+){0,3},? (?:and|or) (?:the |a |an |its |their )?[\p{L}-]+/u,
  fr: /(?<![\p{L}])[\p{L}’'-]+(?: [\p{L}’'-]+){0,3}, [\p{L}’'-]+(?: [\p{L}’'-]+){0,3},? (?:et|ou) [\p{L}’'-]+/u,
}
/** A figure with a decimal or a unit: the kind a reader expects a source for. */
const FIGURE =
  /\d+(?:[.,]\d+)?\s?(?:%|mm|µm|μm|cm|mg|ml|ans?|years?|mois|months?|yeux|eyes|patients?|cas|cases)(?![\p{L}])|\d+[.,]\d+/u
const OWN_DATA =
  /\b(?:our|we|this study|this series|this cohort|the present study)\b|(?<![\p{L}])(?:notre|nos|nous|cette étude|cette série|cette cohorte)(?![\p{L}])/iu
const DATA_SECTION =
  /result|résultat|method|méthode|matériel|population|statisti|abstract|résumé|endpoint|critère|data|donnée|table|figure|tableau|selection|sélection|design|technique|title page/iu
/** Sections that argue rather than report. */
const ARGUING = /discussion|conclusion|limit|perspective|introduction/iu
/** A dash used as punctuation: spaced, or a pair; not a range between two numbers. */
const DASH = /(?<!\d)\s[—–]\s|—/u

type Lang = 'fr' | 'en'

interface Sentence {
  span: AuthorshipSpan
  paragraph: number
  lang: Lang
}

/** The paragraph each offset is in: blocks separated by a blank line. */
function paragraphStarts(text: string): number[] {
  const starts = [0]
  for (const match of text.matchAll(/\n[^\S\n]*\n\s*/gu)) starts.push(match.index + match[0].length)
  return starts
}

function paragraphOf(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) low = mid
    else high = mid - 1
  }
  return low
}

const words = (text: string) => text.split(/\s+/u).filter(Boolean).length

function sentenceHabits(
  sentences: readonly Sentence[],
  text: string,
  sectionKey: (s: Sentence) => string,
): Map<number, SweepHabit[]> {
  const out = new Map<number, SweepHabit[]>()
  const add = (index: number, habit: SweepHabit) => {
    const list = out.get(index) ?? []
    if (!list.some((h) => h.type === habit.type)) list.push(habit)
    out.set(index, list)
  }

  // Sections that cite the literature — an introduction, a discussion — are
  // where a closing verdict or a figure with no source stands out. A results
  // section reports the study's own data, uncited by nature, and its figures
  // are the study's own wherever they are repeated.
  const bodyOf = (s: Sentence) => text.slice(s.span.start, s.span.end)
  const citing = new Set(sentences.filter((s) => CITATION.test(bodyOf(s))).map(sectionKey))
  const own = new Set<string>()
  for (const s of sentences) {
    if (citing.has(sectionKey(s))) continue
    for (const match of bodyOf(s).matchAll(/\d+(?:[.,]\d+)?/gu)) own.add(match[0].replace(',', '.'))
  }

  sentences.forEach((sentence, index) => {
    const body = text.slice(sentence.span.start, sentence.span.end)
    const { lang } = sentence
    const cited = CITATION.test(body)
    const inCiting = citing.has(sectionKey(sentence))
    const same = sentences.filter((s) => s.paragraph === sentence.paragraph)
    const last = same.at(-1) === sentence
    const section = sectionKey(sentence)

    // A closing line: the last sentence of a paragraph whose others carry the
    // data, itself carrying none — a verdict or a moral after the facts.
    if (
      inCiting &&
      last &&
      same.length >= 2 &&
      words(body) <= 20 &&
      !DIGIT.test(body) &&
      !cited &&
      same.some(
        (s) =>
          s !== sentence &&
          (DIGIT.test(text.slice(s.span.start, s.span.end)) ||
            CITATION.test(text.slice(s.span.start, s.span.end))),
      )
    ) {
      add(index, {
        type: 'closing_line',
        detail: 'ends the paragraph on a verdict with no figure or reference behind it',
        confidence: 'low',
        register: false,
      })
    }
    // A paragraph of one short sentence, set apart for effect.
    if (
      inCiting &&
      same.length === 1 &&
      words(body) >= 5 &&
      words(body) <= 14 &&
      !cited &&
      /[.!]$/u.test(body.trim()) &&
      !/:/u.test(body)
    ) {
      const previous = sentences[index - 1]
      if (previous && previous.paragraph === sentence.paragraph - 1)
        add(index, {
          type: 'closing_line',
          detail: 'a one-sentence paragraph restating what came before, for effect',
          confidence: 'low',
          register: false,
        })
    }
    if (RECAP[lang].test(body)) {
      add(index, {
        type: 'recap_connector',
        detail: `"${RECAP[lang].exec(body)?.[0]}" restates the paragraph as its conclusion`,
        confidence: 'low',
        register: true,
      })
    }
    const next = sentences[index + 1]
    if (next && next.paragraph === sentence.paragraph && CONNECTOR[lang].test(body)) {
      const following = text.slice(next.span.start, next.span.end)
      if (CONNECTOR[lang].test(following)) {
        const habit: SweepHabit = {
          type: 'connector_series',
          detail: `"${CONNECTOR[lang].exec(body)?.[0]}" then "${CONNECTOR[lang].exec(following)?.[0]}" in consecutive sentences`,
          confidence: 'low',
          register: false,
        }
        add(index, habit)
        add(index + 1, habit)
      }
    }
    const promise = PROMISE[lang].exec(body)
    if (promise) {
      const after = same
        .filter((s) => s.span.start > sentence.span.start)
        .map((s) => text.slice(s.span.start, s.span.end))
        .join(' ')
      const rest = body.slice((promise.index ?? 0) + promise[0].length)
      if (!FOLLOW_UP[lang].test(rest) && !FOLLOW_UP[lang].test(after))
        add(index, {
          type: 'promise_without_follow_up',
          detail: `"${promise[0]}" announces a sequence that never comes`,
          confidence: 'low',
          register: false,
        })
    }
    // A triad in a discussion is a cadence; in methods it is the list of what
    // was measured. After a colon it is an enumeration either way.
    const triad = TRIAD[lang].exec(body)
    if (
      triad &&
      (inCiting || ARGUING.test(section)) &&
      !DIGIT.test(body) &&
      !cited &&
      !body.slice(0, triad.index).includes(':')
    ) {
      add(index, {
        type: 'triad',
        detail: 'a list of three with no data behind it, a cadence more than a count',
        confidence: 'low',
        register: false,
      })
    }
    const figure = FIGURE.exec(body)?.[0]
    const value = figure ? /\d+(?:[.,]\d+)?/u.exec(figure)?.[0]?.replace(',', '.') : undefined
    if (
      figure &&
      value &&
      inCiting &&
      !cited &&
      !own.has(value) &&
      !OWN_DATA.test(body) &&
      !DATA_SECTION.test(section) &&
      !/\b(?:CI|IC)\b/u.test(body)
    ) {
      add(index, {
        type: 'unsourced_figure',
        detail: `"${figure}" with no reference call in the sentence`,
        confidence: 'low',
        register: false,
      })
    }
    if (DASH.test(body)) {
      add(index, {
        type: 'em_dash',
        detail: 'dashes doing the work of commas, colons or brackets',
        confidence: 'low',
        register: false,
      })
    }
  })
  return out
}

// ------------------------------------------------------------------ rows

const FINDING_TYPE = (category: string): HabitType =>
  category === 'hedging'
    ? 'stacked_hedge'
    : category === 'register'
      ? 'stock_formula'
      : category === 'lexicon'
        ? 'marker_vocabulary'
        : category === 'residue' || category === 'formatting'
          ? 'residue'
          : category === 'phrasing'
            ? 'phrasing'
            : 'structure'

export interface SweepOptions extends DetectOptions {
  /**
   * Texts each quote must be found in, by name: the .docx, the PDF. `loose`
   * compares letters and digits only, for a PDF whose extraction changes
   * spacing, hyphenation and ligatures; otherwise spaces alone are normalised.
   */
  sources?: Record<string, { text: string; loose?: boolean }>
}

/** Whitespace of every kind folded to one space, soft hyphens dropped. */
export const normaliseSpaces = (text: string): string =>
  text
    .replaceAll('\u00ad', '')
    .replaceAll(/[\s\u00a0\u202f\u2009]+/gu, ' ')
    .trim()

/** Sweep a text: every sentence with a habit, located, quoted, with a checked rewrite. */
export function sweep(text: string, options: SweepOptions = {}): SweepResult {
  const { sources, ...detect } = options
  const report = detectAuthorship(text, {
    ...detect,
    register: detect.register ?? 'academic',
    allSpans: true,
    allFindings: true,
  })
  const starts = paragraphStarts(text)
  const sentences: Sentence[] = report.spans
    .filter((span) => span.lang)
    .map((span) => ({ span, paragraph: paragraphOf(starts, span.start), lang: span.lang as Lang }))
  const indexOf = (offset: number) =>
    sentences.findIndex((s) => offset >= s.span.start && offset < s.span.end)

  // The section each sentence is in: from the layout, else the Markdown
  // heading above it.
  const headings = [...text.matchAll(/^#{1,6}[^\S\n]+(.+)$/gmu)].map((m) => ({
    at: m.index,
    title: (m[1] ?? '').trim(),
  }))
  const sectionKey = (s: Sentence) =>
    s.span.location?.section ??
    headings.findLast((h) => h.at <= s.span.start)?.title ??
    (headings.length === 0 ? '' : '(before the first heading)')

  const habits = sentenceHabits(sentences, text, sectionKey)
  const add = (index: number, habit: SweepHabit) => {
    if (index === -1) return
    const list = habits.get(index) ?? []
    const same = list.find((h) => h.type === habit.type)
    if (same) {
      if (RANK[habit.confidence] > RANK[same.confidence]) same.confidence = habit.confidence
      if (!habit.register) same.register = false
    } else list.push({ ...habit })
    habits.set(index, list)
  }

  for (const finding of report.findings) {
    const type = FINDING_TYPE(finding.category)
    const confidence: SweepConfidence =
      type === 'stock_formula' || type === 'phrasing'
        ? 'low'
        : finding.patternId.endsWith('.dense')
          ? 'low'
          : type === 'stacked_hedge'
            ? 'medium'
            : finding.counted === false
              ? 'low'
              : finding.tier === 1 || type === 'residue'
                ? 'high'
                : 'medium'
    add(indexOf(finding.start), {
      type,
      detail: finding.reason,
      patternId: finding.patternId,
      confidence,
      register: type === 'stock_formula',
    })
  }

  for (const recap of report.recaps) {
    const copies = recap.occurrences.length
    const sections = [...new Set(recap.occurrences.map((o) => o.section))]
    for (const occurrence of recap.occurrences) {
      add(indexOf(occurrence.start), {
        type: 'repeated_formula',
        detail: `"${recap.phrase}" appears ${copies} times, in ${sections.join(', ')}`,
        confidence: copies >= 3 ? 'medium' : 'low',
        // An abstract restates the body, and methods and results restate each
        // other, by design.
        register:
          (recap.summary && copies === 2) ||
          recap.occurrences.every((o) => DATA_SECTION.test(o.section)),
      })
    }
  }

  // Each source normalised once, not once per row.
  const prepared = Object.entries(sources ?? {}).map(([name, source]) => ({
    name,
    loose: source.loose === true,
    text: source.loose ? searchable(source.text) : normaliseSpaces(source.text),
  }))

  const rows: SweepRow[] = []
  for (const [index, list] of [...habits.entries()].sort((a, b) => a[0] - b[0])) {
    const sentence = sentences[index]
    if (!sentence || list.length === 0) continue
    const ordered = [...list].sort((a, b) => RANK[b.confidence] - RANK[a.confidence])
    const lead = ordered[0] as SweepHabit
    const quote = text.slice(sentence.span.start, sentence.span.end)
    const checked = prepared.map((source) => source.name)
    const found = prepared
      .filter((source) =>
        source.text.includes(source.loose ? searchable(quote) : normaliseSpaces(quote)),
      )
      .map((source) => source.name)
    const row: SweepRow = {
      id: `S${sentence.span.start}`,
      start: sentence.span.start,
      end: sentence.span.end,
      line: sentence.span.line,
      ...(sentence.span.location ? { location: sentence.span.location } : {}),
      section: sectionKey(sentence),
      text: quote,
      habits: ordered,
      type: lead.type,
      confidence: lead.confidence,
      registerExplained: ordered.every((h) => h.register),
      quote: { checked, found },
    }
    const rule = ruleRewrite(quote)
    if (rule) row.rewrite = checkRewrite(quote, rule, 'rule')
    rows.push(row)
  }

  const counts: Partial<Record<HabitType, number>> = {}
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1
  return { rows, counts, report }
}

// ------------------------------------------------------------------ rewrites

/** French hedges with one right shorter form, beside humanise's English ones. */
const FRENCH_RULES: [RegExp, string][] = [
  [
    /(pourrai(?:t|ent)|peu(?:t|vent)) (?:potentiellement|éventuellement|possiblement|peut-être)(?![\p{L}])/giu,
    '$1',
  ],
  [
    /(sembl(?:e|ent|erait|eraient)) (?:potentiellement|éventuellement|possiblement)(?![\p{L}])/giu,
    '$1',
  ],
  [/(?<![\p{L}])il semblerait que /gu, 'il semble que '],
  [/(?<![\p{L}])Il semblerait que /gu, 'Il semble que '],
]

/** The deterministic rewrite of a sentence, or undefined when no rule applies. */
export function ruleRewrite(sentence: string): string | undefined {
  let out = humanise(sentence).output
  for (const [pattern, to] of FRENCH_RULES) out = out.replace(pattern, to)
  out = out.trim()
  return out !== sentence.trim() && out.length > 0 ? out : undefined
}

/**
 * A rewrite through the gate: the same numbers, the same reference calls, the
 * same names and quotations, and no tell the sentence did not have.
 */
export function checkRewrite(
  original: string,
  rewrite: string,
  source: SweepRewrite['source'],
): SweepRewrite {
  const verdict = verifyRewrite(original, rewrite, buildBrief(original))
  return verdict.ok
    ? { text: rewrite, source, verified: true }
    : {
        text: rewrite,
        source,
        verified: false,
        failures: verdict.failures.map((f) => `${f.what}: ${f.detail}`),
      }
}

/**
 * Rewrites from a model or an agent, `[{ id, rewrite }]`, each checked and
 * attached to its row. A row that already has a verified rule rewrite keeps
 * it; one whose new rewrite fails keeps the failure, and nothing is proposed.
 */
export function applyRewrites(
  rows: readonly SweepRow[],
  rewrites: readonly { id: string; rewrite: string }[],
  source: 'model' | 'agent',
): SweepRow[] {
  const byId = new Map(rewrites.map((r) => [r.id, r.rewrite]))
  return rows.map((row) => {
    const candidate = byId.get(row.id)
    if (candidate === undefined || row.rewrite?.verified) return row
    return { ...row, rewrite: checkRewrite(row.text, candidate.trim(), source) }
  })
}

/** The prompt an agent or a model answers with `[{ "id": …, "rewrite": … }]`. */
export function sweepPrompt(rows: readonly SweepRow[]): string {
  const pending = rows.filter((row) => !row.rewrite?.verified)
  return `Rewrite each sentence below so it no longer carries the habit named, in the same language and register.

RULES
1. Keep every number, unit, date, name and reference call ([1], [17,18], (Smith 2019)) exactly as written. Add none.
2. Change as little as the habit needs. Do not merge sentences or add content.
3. When the right fix is to delete the sentence, answer with an empty rewrite.
4. Answer with JSON only: an array of {"id": "...", "rewrite": "..."}, one per sentence.

SENTENCES
${JSON.stringify(
  pending.map((row) => ({
    id: row.id,
    habit: row.habits.map((h) => `${HABIT_LABEL[h.type]}: ${h.detail}`).join('; '),
    sentence: row.text,
  })),
  undefined,
  2,
)}`
}

// ------------------------------------------------------------------ rendering

const cell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ')

/** "p. 29, §2.6.3" or "line 412". */
const placeOf = (row: SweepRow, describe: (l: Location | undefined) => string | undefined) =>
  describe(row.location) ?? `line ${row.line}`

/** The sweep as Markdown: current text → replace with, grouped by section. */
export function renderSweep(
  result: SweepResult,
  describe: (location: Location | undefined) => string | undefined,
): string {
  const { rows } = result
  const out = ['# Sweep', '']
  out.push(
    `${rows.length} sentences carry a habit. Not proof of anything: a list of sentences that would read better rewritten, whoever wrote them.`,
    '',
  )
  const counts = Object.entries(result.counts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
  if (counts.length > 0) {
    out.push(
      counts.map(([type, count]) => `${HABIT_LABEL[type as HabitType]} ${count}`).join(' · '),
      '',
    )
  }
  const sections = new Map<string, SweepRow[]>()
  for (const row of rows) {
    const key = row.section || 'Text'
    const list = sections.get(key) ?? []
    list.push(row)
    sections.set(key, list)
  }
  for (const [section, list] of sections) {
    out.push(`## ${section}`, '')
    out.push(
      '| Where | Current text | Replace with | Habit | Confidence | Register |',
      '| --- | --- | --- | --- | --- | --- |',
    )
    for (const row of list) {
      const replace = row.rewrite?.verified
        ? row.rewrite.text || '*delete the sentence*'
        : row.rewrite
          ? `*rewrite rejected: ${row.rewrite.failures?.[0] ?? 'failed the gate'}*`
          : '—'
      const quoted =
        row.quote.checked.length > 0 && row.quote.found.length < row.quote.checked.length
          ? ' ⚠ not found in the source'
          : ''
      out.push(
        `| ${cell(placeOf(row, describe))} | « ${cell(row.text)} »${quoted} | ${cell(replace)} | ${cell(row.habits.map((h) => HABIT_LABEL[h.type]).join(', '))} | ${row.confidence} | ${row.registerExplained ? 'explains it' : '—'} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}
