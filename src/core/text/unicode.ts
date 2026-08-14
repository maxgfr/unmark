// Layer A: the marks that live in the characters themselves.
//
// This is the deterministic half of text watermarking, and the half worth being
// careful about. Every codepoint in the tables below is invisible or nearly so,
// which is exactly why a tool that strips them all is dangerous: the same ZWJ
// that hides a payload between two ASCII words is what makes three emoji into
// one family, and the same ZWNJ is Persian orthography. Deleting those does not
// clean the text, it breaks it — silently, in a way the user cannot see.
//
// So the table decides what *could* be a carrier and `preservationReason`
// decides whether this particular occurrence is one. A finding whose context
// exonerates it is reported as `likely_false_positive` and kept.

import { byPosition, type CleanResult, type Finding, type FindingKind } from '../report.ts'
import { CONFUSABLES } from './confusables.ts'
import { trailingCarrierRuns } from './stego.ts'
import { humanise } from './humanise.ts'
import { normaliseTypography } from './typography.ts'

export interface TextOptions {
  /**
   * Strip load-bearing invisibles too — emoji glue, script joiners, flag tags.
   * Corrupts legitimate text by design. Only for someone who has said they want
   * exactly that.
   */
  paranoid?: boolean
  /**
   * Also map Cyrillic/Greek/fullwidth lookalikes back to Latin. Off by default:
   * it is the one rule that rewrites *visible* characters, and in any genuinely
   * multilingual document it is wrong more often than right.
   */
  confusables?: boolean
  /**
   * Flatten typographic punctuation to ASCII: em dashes, curly quotes, ellipsis.
   *
   * Not watermark removal, and never sold as it. An em dash is a style, and
   * this rewrites the author's punctuation — which is why it is opt-in.
   */
  typography?: boolean
  /**
   * Remove generated-prose boilerplate that has one unambiguous shorter form:
   * filler phrases, stacked hedges, chat pleasantries, signposting.
   */
  humanise?: boolean
}

interface Carrier {
  kind: FindingKind
  name: string
  /** `confirmed` when the codepoint has no innocent use in running text. */
  confirmed: boolean
  /** What `clean` writes in its place. Empty deletes it. */
  replacement: string
}

const zeroWidth = (name: string): Carrier => ({
  kind: 'zwj_family',
  name,
  confirmed: true,
  replacement: '',
})

// A space is replaced, never deleted: the mark is the exotic codepoint, not the
// gap it renders as. Deleting U+00A0 would join the two words around it.
const space = (name: string): Carrier => ({
  kind: 'space',
  name,
  confirmed: false,
  replacement: ' ',
})

const bidi = (name: string, confirmed = true): Carrier => ({
  kind: 'bidi',
  name,
  confirmed,
  replacement: '',
})

const CARRIERS = new Map<number, Carrier>([
  // Zero-width and invisible formatting.
  [0x200b, zeroWidth('ZERO WIDTH SPACE')],
  [0x200c, zeroWidth('ZERO WIDTH NON-JOINER')],
  [0x200d, zeroWidth('ZERO WIDTH JOINER')],
  [0x2060, zeroWidth('WORD JOINER')],
  [0xfeff, zeroWidth('ZERO WIDTH NO-BREAK SPACE')],
  [0x180e, zeroWidth('MONGOLIAN VOWEL SEPARATOR')],
  [0x2061, zeroWidth('FUNCTION APPLICATION')],
  [0x2062, zeroWidth('INVISIBLE TIMES')],
  [0x2063, zeroWidth('INVISIBLE SEPARATOR')],
  [0x2064, zeroWidth('INVISIBLE PLUS')],
  // Hangul fillers render as nothing outside a Korean syllable block, which is
  // why they turn up as carriers in usernames and display names.
  [0x115f, zeroWidth('HANGUL CHOSEONG FILLER')],
  [0x1160, zeroWidth('HANGUL JUNGSEONG FILLER')],
  [0x3164, zeroWidth('HANGUL FILLER')],
  [0xffa0, zeroWidth('HALFWIDTH HANGUL FILLER')],

  // Bidirectional controls. The explicit embeddings and overrides have no place
  // in running prose — this is the Trojan Source family, where source code
  // renders as one thing and compiles as another.
  [0x202a, bidi('LEFT-TO-RIGHT EMBEDDING')],
  [0x202b, bidi('RIGHT-TO-LEFT EMBEDDING')],
  [0x202c, bidi('POP DIRECTIONAL FORMATTING')],
  [0x202d, bidi('LEFT-TO-RIGHT OVERRIDE')],
  [0x202e, bidi('RIGHT-TO-LEFT OVERRIDE')],
  [0x2066, bidi('LEFT-TO-RIGHT ISOLATE')],
  [0x2067, bidi('RIGHT-TO-LEFT ISOLATE')],
  [0x2068, bidi('FIRST STRONG ISOLATE')],
  [0x2069, bidi('POP DIRECTIONAL ISOLATE')],
  // The marks, unlike the overrides, are ordinary punctuation in real RTL text.
  [0x200e, bidi('LEFT-TO-RIGHT MARK', false)],
  [0x200f, bidi('RIGHT-TO-LEFT MARK', false)],
  [0x061c, bidi('ARABIC LETTER MARK', false)],

  // Spaces that are not U+0020.
  [0x00a0, space('NO-BREAK SPACE')],
  [0x1680, space('OGHAM SPACE MARK')],
  [0x2000, space('EN QUAD')],
  [0x2001, space('EM QUAD')],
  [0x2002, space('EN SPACE')],
  [0x2003, space('EM SPACE')],
  [0x2004, space('THREE-PER-EM SPACE')],
  [0x2005, space('FOUR-PER-EM SPACE')],
  [0x2006, space('SIX-PER-EM SPACE')],
  [0x2007, space('FIGURE SPACE')],
  [0x2008, space('PUNCTUATION SPACE')],
  [0x2009, space('THIN SPACE')],
  [0x200a, space('HAIR SPACE')],
  [0x202f, space('NARROW NO-BREAK SPACE')],
  [0x205f, space('MEDIUM MATHEMATICAL SPACE')],
  [0x3000, space('IDEOGRAPHIC SPACE')],
  [0x2800, space('BRAILLE PATTERN BLANK')],
])

/**
 * Every space that is not U+0020.
 *
 * Exported because these are a carrier alphabet in their own right, not only
 * individual oddities: substituting a three-per-em or an ideographic space for
 * an ordinary one is invisible in every renderer, and a run of them encodes
 * bits exactly the way zero-width characters do.
 */
export const EXOTIC_SPACES: ReadonlySet<number> = new Set(
  [...CARRIERS.entries()].filter(([, carrier]) => carrier.kind === 'space').map(([point]) => point),
)

const TAG_LANGUAGE = 0xe0001
const TAG_START = 0xe0020
const TAG_CANCEL = 0xe007f
const BLACK_FLAG = 0x1f3f4
const KEYCAP = 0x20e3

const isTagChar = (point: number) =>
  point === TAG_LANGUAGE || (point >= TAG_START && point <= TAG_CANCEL)

/** VS1–VS16, the ones that choose text vs emoji presentation. */
const isPresentationSelector = (point: number) => point >= 0xfe00 && point <= 0xfe0f
/** VS17–VS256, which select a CJK glyph variant. */
const isIdeographicSelector = (point: number) => point >= 0xe0100 && point <= 0xe01ef

function rangeCarrier(point: number): Carrier | undefined {
  if (isTagChar(point)) {
    return { kind: 'tag_chars', name: 'TAG CHARACTER', confirmed: true, replacement: '' }
  }
  if (isPresentationSelector(point) || isIdeographicSelector(point)) {
    return {
      kind: 'variation_selector',
      name: 'VARIATION SELECTOR',
      confirmed: false,
      replacement: '',
    }
  }
  return undefined
}

const EMOJI = /\p{Extended_Pictographic}/u

// Scripts where a ZWNJ or ZWJ is spelling, not steganography. Stripping one of
// these changes the word: می‌روم and میروم are different in Persian.
const JOINING_SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Arabic}/u, 'Arabic'],
  [/\p{Script=Syriac}/u, 'Syriac'],
  [/\p{Script=Thaana}/u, 'Thaana'],
  [/\p{Script=Nko}/u, 'NKo'],
  [/\p{Script=Mongolian}/u, 'Mongolian'],
  [/\p{Script=Devanagari}/u, 'Devanagari'],
  [/\p{Script=Bengali}/u, 'Bengali'],
  [/\p{Script=Gurmukhi}/u, 'Gurmukhi'],
  [/\p{Script=Gujarati}/u, 'Gujarati'],
  [/\p{Script=Oriya}/u, 'Oriya'],
  [/\p{Script=Tamil}/u, 'Tamil'],
  [/\p{Script=Telugu}/u, 'Telugu'],
  [/\p{Script=Kannada}/u, 'Kannada'],
  [/\p{Script=Malayalam}/u, 'Malayalam'],
  [/\p{Script=Sinhala}/u, 'Sinhala'],
  [/\p{Script=Myanmar}/u, 'Myanmar'],
  [/\p{Script=Khmer}/u, 'Khmer'],
  [/\p{Script=Tibetan}/u, 'Tibetan'],
  [/\p{Script=Javanese}/u, 'Javanese'],
  [/\p{Script=Balinese}/u, 'Balinese'],
]

const HAN = /\p{Script=Han}/u

const widthOf = (point: number) => (point > 0xffff ? 2 : 1)

function pointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return undefined
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2)
  }
  return low
}

const pointAfter = (text: string, index: number, width: number): number | undefined =>
  text.codePointAt(index + width)

const matchesScript = (point: number | undefined, pattern: RegExp): boolean =>
  point !== undefined && pattern.test(String.fromCodePoint(point))

function joiningScriptAround(text: string, index: number, width: number): string | undefined {
  const before = pointBefore(text, index)
  const after = pointAfter(text, index, width)
  for (const [pattern, name] of JOINING_SCRIPTS) {
    if (matchesScript(before, pattern) || matchesScript(after, pattern)) return name
  }
  return undefined
}

/** Walk back over a run of tag characters and report what anchors it. */
function tagSequenceBase(text: string, index: number): number | undefined {
  let cursor = index
  for (;;) {
    const previous = pointBefore(text, cursor)
    if (previous === undefined || !isTagChar(previous)) return previous
    cursor -= widthOf(previous)
  }
}

/**
 * Why this particular occurrence is not a mark — or undefined if it is one.
 *
 * The whole difference between a clean tool and a text-corrupter lives here.
 */
function preservationReason(
  text: string,
  index: number,
  point: number,
  width: number,
): string | undefined {
  // A BOM leading a file is a byte-order mark doing its job. The same codepoint
  // three characters in is a carrier.
  if (point === 0xfeff && index === 0) return 'byte-order mark at the start of the text'

  if (point === 0x200d) {
    const before = pointBefore(text, index)
    const after = pointAfter(text, index, width)
    if (matchesScript(before, EMOJI) || matchesScript(after, EMOJI)) {
      return 'emoji sequence glue — removing it would split one emoji into several'
    }
  }

  if (isPresentationSelector(point)) {
    if (pointAfter(text, index, width) === KEYCAP) return 'keycap sequence'
    if (matchesScript(pointBefore(text, index), EMOJI)) {
      return 'emoji presentation selector — removing it changes how the glyph renders'
    }
  }

  if (isIdeographicSelector(point) && matchesScript(pointBefore(text, index), HAN)) {
    return 'ideographic variation sequence — it selects which Han glyph is shown'
  }

  if (point === 0x200c || point === 0x200d) {
    const script = joiningScriptAround(text, index, width)
    if (script) return `orthographic joiner in ${script} script — it is part of the word`
  }

  if (isTagChar(point) && tagSequenceBase(text, index) === BLACK_FLAG) {
    return 'subdivision flag tag sequence — these characters are the flag'
  }

  return undefined
}

/**
 * Whether the invisible character at `index` is doing legitimate work.
 *
 * Exported because the steganography decoder needs the same judgement: a run of
 * zero-width joiners that is a family emoji must not be read as two bytes of
 * payload, for the same reason it must not be stripped. One definition, both
 * callers — otherwise the stripper and the decoder disagree about the same
 * character and the report contradicts itself.
 */
export function isLoadBearing(text: string, index: number): boolean {
  const point = text.codePointAt(index)
  if (point === undefined) return false
  return preservationReason(text, index, point, widthOf(point)) !== undefined
}

const uPlus = (point: number) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * A short, renderable window around a finding, with the carrier itself removed.
 *
 * Whitespace is flattened and the other invisibles are stripped, because this
 * string is rendered inside a table row: a raw newline here would break the
 * alignment of every row after it.
 */
function contextAround(text: string, index: number, width: number): string {
  const before = text.slice(Math.max(0, index - 12), index)
  const after = text.slice(index + width, index + width + 12)
  return `${before}‸${after}`.replaceAll(/\p{Cf}/gu, '').replaceAll(/\s+/g, ' ')
}

/**
 * Indices belonging to a word that contains at least one Latin letter.
 *
 * A Cyrillic а is only evidence of anything when it is standing in for a Latin
 * one. Inside an actual Russian word it is just the letter а, and flagging it
 * would make the confusables pass useless in any bilingual document.
 */
function latinWordMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)
  const word = /[\p{L}\p{M}\p{N}]+/gu
  const latin = /\p{Script=Latin}/u

  for (const match of text.matchAll(word)) {
    const start = match.index
    if (!latin.test(match[0])) continue
    mask.fill(1, start, start + match[0].length)
  }
  return mask
}

/** Strip what is removable and report both what went and what stayed. */
export function cleanText(text: string, options?: TextOptions): CleanResult<string> {
  const paranoid = options?.paranoid ?? false
  const confusables = options?.confusables ?? false
  const spoofable = confusables ? latinWordMask(text) : undefined

  const findings: Finding[] = []
  const preserved: Finding[] = []
  const out: string[] = []

  let index = 0
  while (index < text.length) {
    const point = text.codePointAt(index)
    if (point === undefined) break
    const width = widthOf(point)

    const carrier = CARRIERS.get(point) ?? rangeCarrier(point)

    if (carrier) {
      const reason = paranoid ? undefined : preservationReason(text, index, point, width)
      const finding: Finding = {
        kind: carrier.kind,
        verdict: reason ? 'likely_false_positive' : carrier.confirmed ? 'confirmed' : 'probable',
        offset: index,
        length: width,
        label: `${uPlus(point)} ${carrier.name}`,
        evidence: contextAround(text, index, width),
        ...(reason ? { preserved: reason } : {}),
      }

      if (reason) {
        preserved.push(finding)
        out.push(text.slice(index, index + width))
      } else {
        findings.push(finding)
        out.push(carrier.replacement)
      }

      index += width
      continue
    }

    const latin = spoofable?.[index] ? CONFUSABLES.get(point) : undefined
    if (latin) {
      findings.push({
        kind: 'confusable',
        verdict: 'probable',
        offset: index,
        length: width,
        label: `${uPlus(point)} looks like "${latin}" but is not`,
        evidence: contextAround(text, index, width),
      })
      out.push(latin)
      index += width
      continue
    }

    out.push(text.slice(index, index + width))
    index += width
  }

  // Trailing tabs and spaces last, and on the assembled output rather than
  // inside the walk: they are ordinary characters, so they cannot live in the
  // carrier table, and it takes the whole document to tell a SNOW-style
  // alphabet from an editor that does not trim line ends.
  const cleaned = stripTrailingCarriers(out.join(''))
  findings.push(...cleaned.findings)
  let output = cleaned.output

  // The two style passes always *run*, and only apply when asked.
  //
  // Reporting them unconditionally is the same rule the rest of the tool
  // follows: say what is there before touching it. An inspect that stayed
  // silent about a page of chat pleasantries until you had already guessed to
  // turn the option on would be answering a question you could not know to ask.
  //
  // Neither removes a mark. Punctuation and boilerplate are how the prose
  // reads, not what is hidden inside it.
  for (const pass of [
    { on: options?.humanise ?? false, run: humanise },
    { on: options?.typography ?? false, run: normaliseTypography },
  ]) {
    const result = pass.run(output)
    if (pass.on) {
      output = result.output
      findings.push(...result.findings)
    } else {
      for (const finding of result.findings) {
        finding.available = 'style, not a mark — enable the option to apply it'
        preserved.push(finding)
      }
    }
  }

  return { output, findings, preserved }
}

function stripTrailingCarriers(text: string): { output: string; findings: Finding[] } {
  const runs = trailingCarrierRuns(text)
  if (runs.length === 0) return { output: text, findings: [] }

  let output = text
  for (const run of [...runs].reverse()) {
    output = output.slice(0, run.index) + output.slice(run.index + run.length)
  }

  const total = runs.reduce((sum, run) => sum + run.length, 0)
  const first = runs[0]
  return {
    output,
    findings: [
      {
        kind: 'space',
        verdict: 'confirmed',
        offset: first?.index ?? 0,
        length: total,
        label: `${total} trailing tabs and spaces across ${runs.length} line ends`,
        evidence: 'a two-symbol alphabet parked past the end of each line — the SNOW scheme',
      },
    ],
  }
}

/** Report every mark without changing anything. */
export function inspectText(text: string, options?: TextOptions): Finding[] {
  const { findings, preserved } = cleanText(text, options)
  return [...findings, ...preserved].sort(byPosition)
}
