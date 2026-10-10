// A key phrase copied from one section to another.
//
// "In nearly nine displaced anchors out of ten" in the abstract, the results,
// the conclusion and the French summary; "vary by a factor of ten" four times.
// One repetition is an author keeping their wording; the same formula carried
// word for word through every section is a recap loop, and no sentence-level
// score can see it, because each copy reads fine on its own.
//
// Found as runs of five or more words (three when one is a number) that recur
// in two sections or more. Terminology is the trap: "the scleral pockets
// technique" recurs everywhere in a paper about it, and that is precision,
// not a habit. So a run is kept only when one of its content words is rare in
// the document outside the run's own copies — the word that makes it a
// formula rather than the name of the subject.

import { tokens, type Segmentation, type Token } from './segment.ts'

export interface RecapOccurrence {
  start: number
  end: number
  /** The section the copy sits in: a heading, or a paragraph when none is known. */
  section: string
}

export interface Recap {
  /** The phrase as first written. */
  phrase: string
  /** Words in the phrase. */
  words: number
  occurrences: RecapOccurrence[]
  /**
   * One of the copies is in an abstract, a summary or a title page, which
   * restate the body by design: weak evidence of a habit.
   */
  summary: boolean
}

const SUMMARY =
  /abstract|résumé|resume|summary|synthèse|title page|page de titre|keywords|mots-clés/iu

/** Words of a run without a number, and with one. */
const MIN_RUN = 5
const MIN_NUMBER_RUN = 3

/** Numbers, as digits or words; not "un", "une" or "one", which are articles first. */
const NUMBER_WORD =
  /^(?:\d+(?:[.,]\d+)?|two|three|four|five|six|seven|eight|nine|ten|hundred|half|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|cent|moitié)$/u

const STOP = new Set(
  (
    'the a an of in on at to for and or but with by from as is are was were be been this that these those it its ' +
    'their our we they he she which who than then there here not no all any each more most also into over under ' +
    'after before about between within without during while since until using used via per ' +
    'le la les un une des de du d l et ou mais avec par pour dans sur au aux ce cet cette ces il elle ils elles ' +
    'son sa ses leur leurs notre nos est sont été être plus moins que qui ne pas en se s c qu ' +
    'après avant entre pendant depuis sans sous chez lors'
  ).split(' '),
)

const isContent = (token: Token) => token.norm.length >= 4 && !STOP.has(token.norm)

interface Position {
  sentence: number
  at: number
}

/** Every phrase recopied across sections, longest runs first. */
export function recaps(
  text: string,
  seg: Segmentation,
  sectionOf: (offset: number, paragraph: number) => string,
  /** A section whose copies are not counted: the cover pages before any heading. */
  ignored?: string,
): Recap[] {
  const streams = seg.sentences.map((s) =>
    tokens(text, s.start, s.end).filter((t) => seg.mask[t.start] !== 1),
  )
  const frequency = new Map<string, number>()
  for (const stream of streams)
    for (const token of stream) frequency.set(token.norm, (frequency.get(token.norm) ?? 0) + 1)

  const sectionOf_ = seg.sentences.map((s) => sectionOf(s.start, s.paragraphIndex))
  const sectionAt = (sentence: number) => sectionOf_[sentence] ?? ''

  // Windows that can qualify: five words, or three when one is a number.
  const windows = new Map<string, Position[]>()
  const keyOf = (stream: Token[], at: number, size: number) =>
    stream
      .slice(at, at + size)
      .map((t) => t.norm)
      .join(' ')
  streams.forEach((stream, sentence) => {
    if (ignored !== undefined && sectionAt(sentence) === ignored) return
    for (let at = 0; at < stream.length; at += 1) {
      for (const size of [MIN_NUMBER_RUN, MIN_RUN]) {
        if (at + size > stream.length) continue
        const slice = stream.slice(at, at + size)
        if (size === MIN_NUMBER_RUN && !slice.some((t) => NUMBER_WORD.test(t.norm))) continue
        const key = `${size}:${keyOf(stream, at, size)}`
        const list = windows.get(key)
        if (list) list.push({ sentence, at })
        else windows.set(key, [{ sentence, at }])
      }
    }
  })

  // Keep the windows repeated across sections, mark the words they cover,
  // and remember which windows each covered word belongs to.
  const covered = streams.map((stream) => new Uint8Array(stream.length))
  const keysAt = streams.map((stream) => stream.map((): string[] => []))
  for (const [key, positions] of windows) {
    if (positions.length < 2) continue
    if (new Set(positions.map((p) => sectionAt(p.sentence))).size < 2) continue
    const size = Number(key.slice(0, key.indexOf(':')))
    // A window links copies only through a word of its own, rare outside them;
    // a window of terminology would chain every sentence about the subject.
    const first = positions[0] as Position
    const words = (streams[first.sentence] as Token[]).slice(first.at, first.at + size)
    const rare = words.some(
      (t) =>
        isContent(t) &&
        !NUMBER_WORD.test(t.norm) &&
        (frequency.get(t.norm) ?? 0) <= positions.length + 2,
    )
    if (!rare) continue
    for (const { sentence, at } of positions) {
      const mark = covered[sentence] as Uint8Array
      for (let k = at; k < at + size; k += 1) mark[k] = 1
      keysAt[sentence]?.[at]?.push(key)
    }
  }

  interface Run {
    sentence: number
    from: number
    to: number
    keys: string[]
  }
  const runs: Run[] = []
  covered.forEach((mark, sentence) => {
    for (let at = 0; at < mark.length;) {
      if (!mark[at]) {
        at += 1
        continue
      }
      let end = at
      while (end < mark.length && mark[end]) end += 1
      const keys = (keysAt[sentence] ?? []).slice(at, end).flat()
      runs.push({ sentence, from: at, to: end, keys })
      at = end
    }
  })

  // Copies of one formula are runs that share a qualifying window.
  const parent = runs.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] as number
    parent[index] = root
    return root
  }
  const owner = new Map<string, number>()
  runs.forEach((run, index) => {
    for (const key of run.keys) {
      const other = owner.get(key)
      if (other === undefined) owner.set(key, index)
      else parent[find(index)] = find(other)
    }
  })
  const byRoot = new Map<number, Run[]>()
  runs.forEach((run, index) => {
    const root = find(index)
    const list = byRoot.get(root)
    if (list) list.push(run)
    else byRoot.set(root, [run])
  })
  const groups = [...byRoot.values()]

  const out: Recap[] = []
  for (const group of groups) {
    const sections = new Set(group.map((run) => sectionAt(run.sentence)))
    if (group.length < 2 || sections.size < 2) continue
    const shortest = group.reduce((a, b) => (b.to - b.from < a.to - a.from ? b : a))
    const words = (streams[shortest.sentence] as Token[]).slice(shortest.from, shortest.to)
    const numeric = words.some((t) => NUMBER_WORD.test(t.norm))
    if (words.length < (numeric ? MIN_NUMBER_RUN : MIN_RUN)) continue
    if (words.filter(isContent).length < (numeric ? 1 : 2)) continue
    // A formula has a word of its own: one that is rare outside its copies.
    const rare = words.some((t) => isContent(t) && (frequency.get(t.norm) ?? 0) <= 2 * group.length)
    if (!rare) continue
    const first = group.reduce((a, b) =>
      (streams[b.sentence]?.[b.from]?.start ?? 0) < (streams[a.sentence]?.[a.from]?.start ?? 0)
        ? b
        : a,
    )
    const span = (run: Run) => {
      const stream = streams[run.sentence] as Token[]
      return { start: stream[run.from]?.start ?? 0, end: stream[run.to - 1]?.end ?? 0 }
    }
    const firstSpan = span(first)
    out.push({
      phrase: text.slice(firstSpan.start, firstSpan.end).replaceAll(/\s+/gu, ' '),
      words: words.length,
      summary: group.some((run) => SUMMARY.test(sectionAt(run.sentence))),
      occurrences: group
        .map((run) => ({ ...span(run), section: sectionAt(run.sentence) }))
        .sort((a, b) => a.start - b.start),
    })
  }
  return out.sort((a, b) => (a.occurrences[0]?.start ?? 0) - (b.occurrences[0]?.start ?? 0))
}
