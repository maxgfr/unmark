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

import { buildBrief, extractFacts, verifyRewrite } from '../../rewrite.ts'
import { humanise } from '../humanise.ts'
import { punctuationDashes } from './features.ts'
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
  /** For a formula repeated across sections: the words this sentence repeats. */
  phrase?: string
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
  /** The catalogue the sentence was read with. */
  lang?: 'fr' | 'en'
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
  // Not « ainsi que », « as well as »: it concludes nothing.
  fr: /(?<![\p{L}])(?:donc|ainsi(?!\s+qu)|par conséquent|dès lors)(?![\p{L}])/iu,
}
const CONNECTOR = {
  // « also » inside a clause is not a connector; « Also, » opening one is.
  en: /\b(?:however|nevertheless|nonetheless|moreover|furthermore|in addition|by contrast|conversely)\b|^\s*also\b/iu,
  // « de plus de 2,8 millions », « de plus en plus » and « de plus que » compare.
  fr: /(?<![\p{L}])(?:toutefois|néanmoins|cependant|pourtant|par ailleurs|en outre|de plus(?!\s+(?:de|d['’]|en|que|qu['’]))|en revanche|à l’inverse|à l'inverse)(?![\p{L}])/iu,
}
const PROMISE = {
  // Not the ordinal: « the first series », « its first year ».
  en: /\b(?:in the first place|on the one hand|(?<!\b(?:the|a|an|its|their|our|this|these|his|her|whose)\s)first(?:ly)?)\b/iu,
  fr: /(?<![\p{L}])(?:d['’]abord|tout d['’]abord|premièrement|en premier lieu|d['’]une part)(?![\p{L}])/iu,
}
const FOLLOW_UP = {
  en: /\b(?:second(?:ly)?|then|next|also|finally|on the other hand|in the second place)\b/iu,
  fr: /(?<![\p{L}])(?:ensuite|puis|deuxièmement|en second lieu|enfin|également|aussi|d['’]autre part)(?![\p{L}])/iu,
}
/**
 * Three items, the last one closing the clause. An aside between commas —
 * « The anchor, once displaced, may stay covered and remain stable » — has
 * the same punctuation; `triadIn` tells them apart by the items' lengths.
 */
const TRIAD = {
  en: /\b[\p{L}-]+(?: [\p{L}-]+){0,3}, (?:the |a |an |its |their )?[\p{L}-]+(?: [\p{L}-]+){0,3},? (?:and|or) (?:the |a |an |its |their )?[\p{L}-]+(?: [\p{L}-]+){0,3}(?=\s*(?:[.;:!?)]|$))/gu,
  fr: /(?<![\p{L}])[\p{L}’'-]+(?: [\p{L}’'-]+){0,3}, [\p{L}’'-]+(?: [\p{L}’'-]+){0,3},? (?:et|ou) [\p{L}’'-]+(?: [\p{L}’'-]+){0,3}(?=\s*(?:[.;:!?)]|$))/gu,
}
const LIST_JOIN = { en: /,\s+|,?\s+(?:and|or)\s+/u, fr: /,\s+|,?\s+(?:et|ou)\s+/u }

/** A list of three parallel items in `body`, or undefined. */
function triadIn(body: string, lang: Lang): RegExpExecArray | undefined {
  for (const match of body.matchAll(TRIAD[lang])) {
    // The first item opens the list: one that follows a comma is the tail of an aside.
    if (body.slice(0, match.index).trimEnd().endsWith(',')) continue
    const items = match[0].split(LIST_JOIN[lang]).map((item) => item.split(/\s+/u).length)
    if (items.length !== 3) continue
    if (Math.max(...items) > 2 * Math.min(...items)) continue
    return match as RegExpExecArray
  }
  return undefined
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
/**
 * Sections that define what was measured — methods, endpoints, data
 * collected, a figure's legend. A phrase recurring from one of these is the
 * study's own definition carried through the paper: precision, not a habit.
 */
const DEFINING =
  /method|méthode|matériel|endpoint|critère|outcome measure|data collect|données recueillies|statisti|d[ée]finition|figure|tableau|table|annex|appendix|l[ée]gende|legend|selection|sélection/iu

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
    const triad = triadIn(body, lang)
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
    if (punctuationDashes(body).length > 0) {
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
  const result = analyse(text, options)
  for (const row of result.rows) {
    const rule = ruleRewrite(row.text)
    if (rule) row.rewrite = checkRewrite(row.text, rule, 'rule', row)
  }
  return result
}

/** The rows of a sweep, without rewrites: what the rewrite gate re-reads too. */
function analyse(text: string, options: SweepOptions): SweepResult {
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

  // A formula of the register is register once; written three times in one
  // document — « To our knowledge » in the discussion, again two paragraphs
  // on, again in the conclusion — it is a habit the register no longer explains.
  const formulas = new Map<string, number>()
  for (const finding of report.findings)
    if (FINDING_TYPE(finding.category) === 'stock_formula')
      formulas.set(finding.patternId, (formulas.get(finding.patternId) ?? 0) + 1)
  const recurring = (patternId: string) => (formulas.get(patternId) ?? 0) >= 3

  for (const finding of report.findings) {
    const type = FINDING_TYPE(finding.category)
    const confidence: SweepConfidence =
      type === 'stock_formula'
        ? recurring(finding.patternId)
          ? 'medium'
          : 'low'
        : type === 'phrasing'
          ? 'low'
          : // A dense stretch — three hedged sentences among five — is the
            // « five could in two paragraphs » a relevé lists first.
            type === 'stacked_hedge'
            ? 'medium'
            : finding.counted === false
              ? 'low'
              : finding.tier === 1 || type === 'residue'
                ? 'high'
                : 'medium'
    add(indexOf(finding.start), {
      type,
      // A tier-3 entry's reason speaks of the sentence it is counted beside;
      // listed alone, that would claim another flag the sentence does not have.
      detail:
        type === 'stock_formula' && recurring(finding.patternId)
          ? `a formula of the register, written ${formulas.get(finding.patternId)} times in the document`
          : finding.counted === false && finding.tier === 3
            ? `${type === 'stock_formula' ? 'a formula of the register' : 'a word that counts only beside another habit'} (« ${text.slice(finding.start, finding.end).replaceAll(/\s+/gu, ' ')} »), alone here, so detect does not count it`
            : finding.reason,
      patternId: finding.patternId,
      confidence,
      register: type === 'stock_formula' && !recurring(finding.patternId),
    })
  }

  for (const recap of report.recaps) {
    const copies = recap.occurrences.length
    const sections = [...new Set(recap.occurrences.map((o) => o.section))]
    // A definition from the methods carried through the paper is precision.
    // What reads as a habit is a formula recopied three times or more into a
    // section that argues — the slogan of the results that returns, word for
    // word, in the conclusion.
    const defined = recap.occurrences.some((o) => DEFINING.test(o.section))
    const argued = recap.occurrences.some((o) => ARGUING.test(o.section))
    for (const occurrence of recap.occurrences) {
      const own = text.slice(occurrence.start, occurrence.end).replaceAll(/\s+/gu, ' ')
      add(indexOf(occurrence.start), {
        type: 'repeated_formula',
        detail: `"${own}" appears ${copies} times, in ${sections.join(', ')}`,
        phrase: own,
        confidence: copies >= 3 && argued && !defined ? 'medium' : 'low',
        // An abstract restates the body, and methods and results restate each
        // other, by design.
        register:
          defined ||
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
      lang: sentence.lang,
      text: quote,
      habits: ordered,
      type: lead.type,
      confidence: lead.confidence,
      registerExplained: ordered.every((h) => h.register),
      quote: { checked, found },
    }
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
 * Habits a sentence carries on its own, read the way the sweep reads it: in a
 * section that argues, with the academic register. Context-bound habits — a
 * closing line, connectors across two sentences — cannot show here.
 */
function ownHabits(sentence: string, lang: 'fr' | 'en' | undefined) {
  const { rows, report } = analyse(`## Discussion\n\n${sentence}`, {
    ...(lang ? { lang } : {}),
    register: 'academic',
  })
  return {
    types: new Set(rows.flatMap((row) => row.habits.map((h) => h.type))),
    patterns: new Set(report.findings.map((f) => f.patternId)),
  }
}

/** Habits a rewrite of one sentence cannot be expected to clear on its own. */
const IN_CONTEXT: ReadonlySet<HabitType> = new Set<HabitType>([
  'closing_line',
  'connector_series',
  'unsourced_figure',
])

/** A row whose only habit is a figure without its call: the author alone can add it. */
export const needsAuthor = (row: Pick<SweepRow, 'habits'>): boolean =>
  row.habits.length > 0 && row.habits.every((h) => h.type === 'unsourced_figure')

/**
 * A rewrite through the gate: the same numbers, the same reference calls, the
 * same names and quotations, the habit gone, and no tell the sentence did not
 * have. An empty rewrite deletes the sentence, which is allowed only when it
 * carries no figure and no reference call.
 */
export function checkRewrite(
  original: string,
  rewrite: string,
  source: SweepRewrite['source'],
  row?: Pick<SweepRow, 'habits' | 'lang'>,
): SweepRewrite {
  const rejected = (failures: string[]): SweepRewrite => ({
    text: rewrite,
    source,
    verified: false,
    failures,
  })

  if (rewrite.trim() === '') {
    const facts = extractFacts(original)
    const lost = [
      ...facts.numbers.map((n) => `number ${n}`),
      ...facts.citations.map((c) => `reference call ${c}`),
    ]
    return lost.length > 0
      ? rejected([`deleting the sentence would lose ${lost.join(', ')}`])
      : { text: '', source, verified: true }
  }
  if (normaliseSpaces(rewrite) === normaliseSpaces(original))
    return rejected(['unchanged: the rewrite is the sentence as it was'])

  const verdict = verifyRewrite(original, rewrite, buildBrief(original))
  const failures = verdict.failures.map((f) => `${f.what}: ${f.detail}`)

  const before = ownHabits(original, row?.lang)
  const after = ownHabits(rewrite, row?.lang)
  const targets = row?.habits ?? [...before.types].map((type) => ({ type }) as SweepHabit)
  for (const habit of targets) {
    if (IN_CONTEXT.has(habit.type)) continue
    const kept =
      habit.type === 'repeated_formula'
        ? habit.phrase !== undefined &&
          normaliseSpaces(rewrite).toLowerCase().includes(habit.phrase.toLowerCase())
        : after.types.has(habit.type)
    if (kept) failures.push(`${HABIT_LABEL[habit.type]}: still in the rewrite`)
  }
  for (const type of after.types)
    if (!before.types.has(type) && !targets.some((h) => h.type === type))
      failures.push(`${HABIT_LABEL[type]}: introduced by the rewrite`)
  for (const pattern of after.patterns)
    if (!before.patterns.has(pattern)) failures.push(`${pattern}: introduced by the rewrite`)

  const unique = [...new Set(failures)]
  return unique.length === 0 ? { text: rewrite, source, verified: true } : rejected(unique)
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
    return { ...row, rewrite: checkRewrite(row.text, candidate.trim(), source, row) }
  })
}

/** `[{id, rewrite}]` from a parsed JSON value, and how many items were not that shape. */
export function rewritesFrom(value: unknown): {
  rewrites: { id: string; rewrite: string }[]
  ignored: number
} {
  if (!Array.isArray(value)) return { rewrites: [], ignored: 0 }
  const rewrites = value.flatMap((item) =>
    item &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    typeof item.rewrite === 'string'
      ? [{ id: item.id as string, rewrite: item.rewrite as string }]
      : [],
  )
  return { rewrites, ignored: value.length - rewrites.length }
}

/** What became of an agent's or a model's answers once applied. */
export function summariseRewrites(
  rows: readonly SweepRow[],
  rewrites: readonly { id: string; rewrite?: string }[],
): { verified: number; rejected: number; unknown: string[] } {
  const asked = new Set(rewrites.map((r) => r.id))
  const known = new Set(rows.map((row) => row.id))
  let verified = 0
  let rejected = 0
  for (const row of rows) {
    if (!asked.has(row.id) || !row.rewrite || row.rewrite.source === 'rule') continue
    if (row.rewrite.verified) verified += 1
    else rejected += 1
  }
  return { verified, rejected, unknown: [...asked].filter((id) => !known.has(id)) }
}

/** The prompt an agent or a model answers with `[{ "id": …, "rewrite": … }]`. */
export function sweepPrompt(rows: readonly SweepRow[]): string {
  const pending = rows.filter((row) => !row.rewrite?.verified && !needsAuthor(row))
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
          : needsAuthor(row)
            ? '*add the reference call: only the author knows it*'
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
