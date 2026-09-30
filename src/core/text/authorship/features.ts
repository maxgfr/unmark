// What each sentence is doing, measured.
//
// Two passes, both linear in the length of the text.
//
// `scan` runs every catalogue pattern exactly once over the whole document —
// not once per sentence, which on a long text is the difference between a
// report and a hang — and files each match under its sentence by binary
// search. Tier rules are applied there, so everything downstream reads only
// the hits that count.
//
// `measure` turns hits and the token stream into five numbers per sentence.
// Repetition and diversity use windows that slide forward with the sentences,
// so each token enters and leaves a window once.

import type { Finding, FindingKind } from '../../report.ts'
import { CATALOGUE, applies, matchesOf, type Pattern } from './catalogue/index.ts'
import { tokens, type Lang, type Segmentation } from './segment.ts'

export interface Hit {
  entry: Pattern
  start: number
  end: number
  /** Index into `seg.sentences`, or -1 for a match outside every kept sentence. */
  sentence: number
  /** Whether the tier rules let it count. */
  counted: boolean
  /** What it adds to its component when it counts. */
  weight: number
}

export interface SentenceFeatures {
  /** Flagged vocabulary, 0–1. */
  phrase: number
  /** Structural and discourse habits, 0–1. */
  structure: number
  /** Share of the sentence's word trigrams repeated in the 100 words around it. */
  repetition: number
  /** How far vocabulary diversity falls below the language's baseline, 0–1. */
  diversity: number
  /** Em dashes, 0–1. */
  typography: number
  residue: boolean
  /** An invisible carrier or a decoded payload inside the sentence. */
  carrier: boolean
  mixedScript: boolean
  /** Technical-mark kinds inside the sentence. */
  marks: FindingKind[]
}

const TIER_WEIGHT = { 1: 1, 2: 0.75, 3: 0.25 } as const

/** Binary search: the sentence containing `offset`, or -1. */
function sentenceAt(seg: Segmentation, offset: number): number {
  const { sentences } = seg
  let low = 0
  let high = sentences.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const sentence = sentences[middle] as Segmentation['sentences'][number]
    if (offset < sentence.start) high = middle - 1
    else if (offset >= sentence.end) low = middle + 1
    else return middle
  }
  return -1
}

function sealed(mask: Uint8Array, start: number, end: number): boolean {
  for (let at = start; at < end; at += 1) if (mask[at] === 1) return true
  return false
}

const isResidue = (entry: Pattern) =>
  entry.category === 'residue' || entry.category === 'formatting'

/**
 * Every catalogue match in `text` that the tier rules let count.
 *
 * A match is read only in a sentence of its language, except residue, which
 * is read everywhere. A match that touches a sealed span — a quotation, code —
 * is dropped: quoting "I hope this helps" is not writing it.
 */
export function scan(text: string, seg: Segmentation, format?: string): Hit[] {
  const hits: Hit[] = []
  for (const entry of CATALOGUE) {
    if (!applies(entry, format)) continue
    for (const { start, end } of matchesOf(entry, text)) {
      if (sealed(seg.mask, start, end)) continue
      const sentence = sentenceAt(seg, start)
      if (sentence === -1) {
        if (!isResidue(entry)) continue
      } else if (entry.lang !== 'any' && seg.sentences[sentence]?.lang !== entry.lang) {
        continue
      }
      hits.push({ entry, start, end, sentence, counted: false, weight: 0 })
    }
  }
  hits.sort((a, b) => a.start - b.start)

  // Tier 2 needs company in its paragraph; tier 3 needs company in its sentence.
  const tierTwo = new Map<number, number>()
  for (const hit of hits) {
    if (hit.entry.tier !== 2 || hit.sentence === -1) continue
    const paragraph = seg.sentences[hit.sentence]?.paragraphIndex ?? -1
    tierTwo.set(paragraph, (tierTwo.get(paragraph) ?? 0) + 1)
  }

  const backed = new Set<number>()
  for (const hit of hits) {
    const paragraph = hit.sentence === -1 ? -1 : (seg.sentences[hit.sentence]?.paragraphIndex ?? -1)
    if (hit.entry.tier === 1 || (hit.entry.tier === 2 && (tierTwo.get(paragraph) ?? 0) >= 2)) {
      hit.counted = true
      hit.weight = TIER_WEIGHT[hit.entry.tier]
      if (hit.sentence !== -1) backed.add(hit.sentence)
    }
  }
  for (const hit of hits) {
    if (hit.entry.tier === 3 && backed.has(hit.sentence)) {
      hit.counted = true
      hit.weight = TIER_WEIGHT[3]
    }
  }

  return hits
}

/** Typical MATTR over 50-word windows in edited prose, by language. */
export const DIVERSITY_BASE: Record<Lang, number> = { fr: 0.74, en: 0.74 }
/** How far below the baseline counts as fully narrow. */
const DIVERSITY_SPAN = 0.15
const MATTR_WINDOW = 50
const REPETITION_WINDOW = 100

/** An em dash that is not a French dialogue dash opening a line. */
const DASH = /(?<!(?:^|\n)[^\S\n]{0,3})[—–]/gu

const CARRIERS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  'zwj_family',
  'tag_chars',
  'variation_selector',
  'bidi',
  'space',
  'stego_payload',
])

/** Five features and three flags for every sentence of `seg`. */
export function measure(
  text: string,
  seg: Segmentation,
  hits: readonly Hit[],
  marks: readonly Finding[],
): SentenceFeatures[] {
  const out: SentenceFeatures[] = seg.sentences.map(() => ({
    phrase: 0,
    structure: 0,
    repetition: 0,
    diversity: 0,
    typography: 0,
    residue: false,
    carrier: false,
    mixedScript: false,
    marks: [],
  }))

  const phrase = new Float64Array(out.length)
  const structure = new Float64Array(out.length)
  for (const hit of hits) {
    if (!hit.counted || hit.sentence === -1) continue
    const features = out[hit.sentence] as SentenceFeatures
    const at = hit.sentence
    if (hit.entry.category === 'lexicon') phrase[at] = (phrase[at] ?? 0) + hit.weight
    else if (!isResidue(hit.entry)) structure[at] = (structure[at] ?? 0) + hit.weight
    else if (hit.entry.category === 'residue') features.residue = true
  }

  for (const mark of marks) {
    const sentence = sentenceAt(seg, mark.offset)
    if (sentence === -1) continue
    const features = out[sentence] as SentenceFeatures
    features.marks.push(mark.kind)
    if (CARRIERS.has(mark.kind)) features.carrier = true
    if (mark.kind === 'confusable') features.mixedScript = true
    if (mark.kind === 'generator_tag') features.residue = true
  }

  // One token stream across every kept sentence, unsealed words only.
  const stream: string[] = []
  const ranges: [number, number][] = []
  for (const sentence of seg.sentences) {
    const from = stream.length
    for (const token of tokens(text, sentence.start, sentence.end)) {
      if (seg.mask[token.start] !== 1) stream.push(token.norm)
    }
    ranges.push([from, stream.length])
  }

  repetition(stream, ranges, out)
  diversity(stream, ranges, seg, out)

  seg.sentences.forEach((sentence, index) => {
    const features = out[index] as SentenceFeatures
    // One counted tier-1 habit saturates its component. A sentence built
    // around "Plongeons dans" is flagged for it; a second stock phrase in the
    // same sentence does not make it twice as generated.
    features.phrase = Math.min(phrase[index] ?? 0, 1)
    features.structure = Math.min(structure[index] ?? 0, 1)
    const dashes = [...text.slice(sentence.start, sentence.end).matchAll(DASH)].filter(
      (match) => seg.mask[sentence.start + match.index] !== 1,
    ).length
    features.typography = Math.min(dashes, 2) / 2
  })

  return out
}

/**
 * Trigram repetition in a window of about 100 words centred on each sentence.
 *
 * Both window edges only move forward as the sentences do, so trigrams are
 * added and removed from one count map once each: linear, not quadratic.
 */
function repetition(
  stream: readonly string[],
  ranges: readonly [number, number][],
  out: SentenceFeatures[],
): void {
  const counts = new Map<string, number>()
  const key = (at: number) => `${stream[at]}\u0001${stream[at + 1]}\u0001${stream[at + 2]}`
  let left = 0
  let right = 0 // trigrams [left, right) are in the map

  ranges.forEach(([from, to], index) => {
    if (to - from < 3) return
    const middle = (from + to) >> 1
    const wantLeft = Math.max(0, Math.min(from, middle - REPETITION_WINDOW / 2))
    const wantRight = Math.min(
      stream.length - 2,
      Math.max(to - 2, middle + REPETITION_WINDOW / 2 - 2),
    )
    for (; right < wantRight; right += 1) {
      if (right < left) continue
      counts.set(key(right), (counts.get(key(right)) ?? 0) + 1)
    }
    for (; left < wantLeft; left += 1) {
      if (left >= right) continue
      const k = key(left)
      const next = (counts.get(k) ?? 1) - 1
      if (next === 0) counts.delete(k)
      else counts.set(k, next)
    }
    if (right < left) right = left

    let repeated = 0
    for (let at = from; at < to - 2; at += 1) if ((counts.get(key(at)) ?? 0) >= 2) repeated += 1
    ;(out[index] as SentenceFeatures).repetition = repeated / (to - from - 2)
  })
}

/**
 * Moving-average type-token ratio over 50-word windows, against the baseline.
 *
 * Plain type-token ratio falls with length whatever the writer does; the
 * moving average does not, which is what makes it comparable across texts.
 */
function diversity(
  stream: readonly string[],
  ranges: readonly [number, number][],
  seg: Segmentation,
  out: SentenceFeatures[],
): void {
  const windows = stream.length - MATTR_WINDOW + 1
  if (windows <= 0) return

  // ttr[j] for the window starting at j, then prefix sums for range means.
  const prefix = new Float64Array(windows + 1)
  const counts = new Map<string, number>()
  for (let at = 0; at < MATTR_WINDOW; at += 1) {
    const word = stream[at] as string
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  for (let j = 0; j < windows; j += 1) {
    prefix[j + 1] = (prefix[j] as number) + counts.size / MATTR_WINDOW
    if (j + MATTR_WINDOW >= stream.length) break
    const leaving = stream[j] as string
    const left = (counts.get(leaving) ?? 1) - 1
    if (left === 0) counts.delete(leaving)
    else counts.set(leaving, left)
    const entering = stream[j + MATTR_WINDOW] as string
    counts.set(entering, (counts.get(entering) ?? 0) + 1)
  }

  ranges.forEach(([from, to], index) => {
    if (to <= from) return
    const first = Math.min(Math.max(0, from - MATTR_WINDOW / 2), windows - 1)
    const last = Math.min(Math.max(first, to - MATTR_WINDOW / 2), windows - 1)
    const mattr = ((prefix[last + 1] as number) - (prefix[first] as number)) / (last - first + 1)
    const lang = seg.sentences[index]?.lang ?? 'en'
    const gap = (DIVERSITY_BASE[lang] - mattr) / DIVERSITY_SPAN
    ;(out[index] as SentenceFeatures).diversity = Math.max(0, Math.min(1, gap))
  })
}
