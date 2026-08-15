// Where a prose rule may act, and where it must not.
//
// Every style rule in this directory used to run over the whole document with
// no idea what it was standing in. That is fine until the document contains a
// fenced code block, and then `in order to` inside a comment becomes `to`, a
// curly quote inside a JSON string becomes straight, and the snippet no longer
// runs. The same is true of a blockquote — quoting someone else's marketing
// copy is not writing marketing copy — and of a sentence that is *discussing*
// a phrase rather than using it.
//
// So the passes ask this module two questions:
//
//   protectedMask(text)  which code units are off limits, one byte each
//   blocksOf(text)       what structural block each line belongs to
//
// The mask is what keeps `humanise` and `normaliseTypography` honest. The block
// list is what lets stylometry measure per paragraph rather than per document,
// which is the difference between "twelve em dashes in three thousand words"
// (nothing) and "three em dashes in this paragraph" (a tell).
//
// Protection is deliberately asymmetric: over-protecting costs a missed
// improvement, under-protecting corrupts someone's file. When a construct is
// ambiguous — a four-space indent that could be a code block or could be a
// nested list — this module protects it.

export type BlockKind =
  | 'frontmatter'
  | 'fence'
  | 'indented_code'
  | 'heading'
  | 'blockquote'
  | 'list_item'
  | 'table'
  | 'paragraph'
  | 'blank'

export interface Block {
  kind: BlockKind
  /** UTF-16 code-unit offset of the first character, matching Finding.offset. */
  start: number
  /** One past the last character, excluding the trailing newline. */
  end: number
  /** Heading depth 1–6. Only present on `heading`. */
  level?: number
}

/** A line, with the offsets needed to map it back to the document. */
interface Line {
  text: string
  start: number
  end: number
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (;;) {
    const index = text.indexOf('\n', start)
    if (index === -1) {
      lines.push({ text: text.slice(start), start, end: text.length })
      break
    }
    lines.push({ text: text.slice(start, index), start, end: index })
    start = index + 1
  }
  return lines
}

const FENCE = /^ {0,3}(```+|~~~+)/
const ATX_HEADING = /^ {0,3}(#{1,6})(\s|$)/
const BLOCKQUOTE = /^ {0,3}>/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(\s|$)/
const SETEXT = /^ {0,3}(=+|-+)\s*$/
const TABLE_RULE = /^ {0,3}\|?[\s:-]*-[\s:|-]*$/
const INDENTED = /^(?: {4}|\t)/
const BLANK = /^\s*$/

/**
 * Split a document into structural blocks.
 *
 * Line-based rather than a real Markdown parse, and that is the right size for
 * this: the passes need to know "is this line inside a fence" and "where does
 * this paragraph end", not to build a syntax tree. A plain .txt file with no
 * Markdown in it comes out as paragraphs and blanks, which is correct.
 */
export function blocksOf(text: string): Block[] {
  if (text.length === 0) return []

  const lines = linesOf(text)
  const blocks: Block[] = []
  let index = 0

  // Frontmatter is only frontmatter at the very top of the file. A `---` in the
  // middle of a document is a horizontal rule or a setext underline.
  if (lines[0]?.text.trim() === '---') {
    let close = 1
    // Bounded, and it has to look like frontmatter. An unbounded search meant a
    // document opening with a horizontal rule was frontmatter all the way to
    // the next `---` anywhere in the file — sealing the entire body, so every
    // style pass no-opped and said there was nothing to fix.
    const LIMIT = Math.min(lines.length, 60)
    while (close < LIMIT && !/^(-{3,}|\.{3,})\s*$/.test(lines[close]?.text ?? '')) close += 1

    const body = lines.slice(1, close)
    const looksLikeYaml =
      body.length > 0 &&
      body.every((line) => BLANK.test(line.text) || /^\s*(?:[\w.$-]+\s*:|- )/.test(line.text))

    if (close < LIMIT && looksLikeYaml) {
      blocks.push({ kind: 'frontmatter', start: 0, end: lines[close]?.end ?? text.length })
      index = close + 1
    }
  }

  while (index < lines.length) {
    const line = lines[index]
    if (!line) break

    const fence = FENCE.exec(line.text)
    if (fence) {
      const marker = (fence[1] ?? '```')[0] as string
      const width = (fence[1] ?? '```').length
      let close = index + 1
      while (close < lines.length) {
        const candidate = FENCE.exec(lines[close]?.text ?? '')
        const run = candidate?.[1] ?? ''
        if (run.length >= width && run[0] === marker) break
        close += 1
      }
      // An unclosed fence runs to the end of the document. Treating it as prose
      // instead would let a rule edit inside a code block that is merely missing
      // its closing line, which is the commoner mistake of the two.
      const end = close < lines.length ? (lines[close]?.end ?? text.length) : text.length
      blocks.push({ kind: 'fence', start: line.start, end })
      index = close < lines.length ? close + 1 : lines.length
      continue
    }

    if (BLANK.test(line.text)) {
      blocks.push({ kind: 'blank', start: line.start, end: line.end })
      index += 1
      continue
    }

    const heading = ATX_HEADING.exec(line.text)
    if (heading) {
      blocks.push({
        kind: 'heading',
        start: line.start,
        end: line.end,
        level: (heading[1] ?? '#').length,
      })
      index += 1
      continue
    }

    if (BLOCKQUOTE.test(line.text)) {
      let close = index
      while (close < lines.length && BLOCKQUOTE.test(lines[close]?.text ?? '')) close += 1
      blocks.push({ kind: 'blockquote', start: line.start, end: lines[close - 1]?.end ?? line.end })
      index = close
      continue
    }

    // An indented run is code only when nothing could have introduced it as a
    // continuation. After a list item, four spaces is the list's own body; after
    // a blank line at the top level, it is a code block. Getting this backwards
    // either mangles code or freezes every nested list, so the ambiguous case
    // resolves to code.
    if (INDENTED.test(line.text) && !insideList(blocks)) {
      let close = index
      while (
        close < lines.length &&
        (INDENTED.test(lines[close]?.text ?? '') || BLANK.test(lines[close]?.text ?? ''))
      ) {
        close += 1
      }
      // Trailing blanks belong to the document, not to the code block.
      let last = close - 1
      while (last > index && BLANK.test(lines[last]?.text ?? '')) last -= 1
      blocks.push({ kind: 'indented_code', start: line.start, end: lines[last]?.end ?? line.end })
      index = last + 1
      continue
    }

    if (LIST_ITEM.test(line.text)) {
      blocks.push({ kind: 'list_item', start: line.start, end: line.end })
      index += 1
      continue
    }

    // A table needs its delimiter row; a line with pipes on its own is prose
    // that happens to contain a pipe.
    if (line.text.includes('|') && TABLE_RULE.test(lines[index + 1]?.text ?? '')) {
      let close = index
      while (close < lines.length && (lines[close]?.text ?? '').includes('|')) close += 1
      blocks.push({ kind: 'table', start: line.start, end: lines[close - 1]?.end ?? line.end })
      index = close
      continue
    }

    // A paragraph runs until a blank line or anything that starts a new block.
    let close = index + 1
    while (close < lines.length) {
      const next = lines[close]?.text ?? ''
      if (
        BLANK.test(next) ||
        FENCE.test(next) ||
        ATX_HEADING.test(next) ||
        BLOCKQUOTE.test(next) ||
        LIST_ITEM.test(next) ||
        SETEXT.test(next)
      ) {
        break
      }
      close += 1
    }

    // A setext underline turns the paragraph above it into a heading — the
    // whole paragraph, not only its last line, which is what CommonMark says.
    const underline = lines[close]
    if (underline && SETEXT.test(underline.text)) {
      blocks.push({
        kind: 'heading',
        start: line.start,
        end: underline.end,
        level: underline.text.trim().startsWith('=') ? 1 : 2,
      })
      index = close + 1
      continue
    }

    blocks.push({ kind: 'paragraph', start: line.start, end: lines[close - 1]?.end ?? line.end })
    index = close
  }

  return blocks
}

/** Whether the block just before this point was a list item still in scope. */
function insideList(blocks: readonly Block[]): boolean {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const kind = blocks[index]?.kind
    if (kind === 'list_item') return true
    if (kind !== 'blank') return false
  }
  return false
}

/** Blocks whose content is prose a style rule may read and edit. */
const PROSE_BLOCKS = new Set<BlockKind>(['paragraph', 'heading', 'list_item', 'table'])

/** Blocks whose content must never be edited by a prose rule. */
const SEALED_BLOCKS = new Set<BlockKind>(['frontmatter', 'fence', 'indented_code', 'blockquote'])

// Inline constructs that are off limits inside an otherwise editable block.
//
// Ordered by how greedy they are: a URL inside a link target should be found as
// part of the link, and a backtick span wins over anything inside it.
const INLINE_SEALED: RegExp[] = [
  // Code spans, honouring the backtick-run rule so `` ` `` works.
  //
  // Bounded to one line. The first version used `[^]*?`, which crosses
  // newlines, so two stray backticks anywhere in a document sealed everything
  // between them — measured at 116 of 167 code units on a paragraph that merely
  // mentioned the key twice, after which every style pass returned the text
  // unchanged and reported nothing to fix. `QUOTED` below already carried that
  // bound and the comment explaining why; this one did not.
  /(`+)(?:(?!\1)[^\n])+\1/g,
  // HTML and JSX tags, including their attributes.
  /<\/?[A-Za-z][^\n>]*>/g,
  // Autolinks and bare URLs. The trailing-punctuation trim keeps a sentence's
  // full stop out of the protected span.
  /<[a-z][a-z0-9+.-]*:\/\/[^\s>]+>/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s)<>"']+/gi,
  // Markdown link and image targets, plus reference definitions. The visible
  // text stays editable; only the target is sealed.
  /\]\([^\s)]*(?:\s+"[^"]*")?\)/g,
  /^\s{0,3}\[[^\]]+]:\s*\S+.*$/gm,
  // Entities, so `&amp;` never becomes `&amp ;`.
  /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]{1,31});/gi,
]

/**
 * A quoted span, sealed because quoting a phrase is not using it.
 *
 * Bounded on purpose. An unbalanced quotation mark somewhere in a long document
 * would otherwise seal everything after it, silently turning every style pass
 * into a no-op — a failure that looks exactly like success.
 */
const QUOTED = /"[^"\n]{1,400}"|“[^”\n]{1,400}”|«[^»\n]{1,400}»/g

const MAX_QUOTED_SHARE = 0.5

/**
 * Above this, the seal has stopped describing the document and started hiding it.
 *
 * The same reasoning as the quotation cap, applied to the whole inline pass. A
 * mask that covers most of a file turns every style rule into a silent no-op,
 * and "nothing to fix" is indistinguishable from "the guard disabled itself".
 * When it happens, the code seals are dropped and the block seals kept: a fence
 * is unambiguous, an unbalanced backtick is not.
 */
const MAX_SEALED_SHARE = 0.7

/**
 * Code, markup and machine-readable spans — the seal every pass shares.
 *
 * Narrower than `protectedMask` on purpose. Normalising a curly quote to a
 * straight one is safe inside a quotation and unsafe inside a JSON string, so
 * `normaliseTypography` wants this mask and not the wider one: sealing
 * quotations would leave it with no curly quotes to normalise anywhere, and a
 * rule that can never fire is indistinguishable from a rule that is broken.
 */
export function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)

  for (const block of blocksOf(text)) {
    if (block.kind === 'blockquote') continue
    if (SEALED_BLOCKS.has(block.kind)) seal(mask, block.start, block.end)
  }

  const blocksOnly = mask.reduce((total, byte) => total + byte, 0)

  for (const pattern of INLINE_SEALED) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) seal(mask, match.index, match.index + match[0].length)
    }
  }

  // If the inline patterns swallowed most of what was left, they are wrong
  // about this document. Fall back to the block seals, which cannot run away.
  const sealed = mask.reduce((total, byte) => total + byte, 0)
  if (text.length > 0 && sealed / text.length > MAX_SEALED_SHARE && blocksOnly < sealed) {
    const blocks = new Uint8Array(text.length)
    for (const block of blocksOf(text)) {
      if (block.kind === 'blockquote') continue
      if (SEALED_BLOCKS.has(block.kind)) seal(blocks, block.start, block.end)
    }
    return blocks
  }

  return mask
}

/**
 * One byte per code unit: 1 where no prose rule may write.
 *
 * A mask rather than a list of ranges because every caller asks the same
 * question — "may I touch offsets 412 to 419" — and a lookup answers it in
 * constant time regardless of how many regions the document has.
 */
export function protectedMask(text: string): Uint8Array {
  const mask = codeMask(text)

  for (const block of blocksOf(text)) {
    if (block.kind === 'blockquote') seal(mask, block.start, block.end)
  }

  // Quotations are sealed only while they stay a minority of the document. A
  // transcript that is more quotation than prose is a document where sealing
  // them would leave nothing to work on, and the user asked for a clean.
  const quotes = [...text.matchAll(QUOTED)]
  const quoted = quotes.reduce((total, match) => total + match[0].length, 0)
  if (text.length > 0 && quoted / text.length <= MAX_QUOTED_SHARE) {
    for (const match of quotes) {
      if (match.index !== undefined) seal(mask, match.index, match.index + match[0].length)
    }
  }

  return mask
}

function seal(mask: Uint8Array, start: number, end: number): void {
  for (let index = Math.max(0, start); index < Math.min(mask.length, end); index += 1) {
    mask[index] = 1
  }
}

/** Whether any code unit in `[start, end)` is off limits. */
export function isSealed(mask: Uint8Array, start: number, end: number): boolean {
  for (let index = Math.max(0, start); index < Math.min(mask.length, end); index += 1) {
    if (mask[index] === 1) return true
  }
  return false
}

/**
 * Replace matches of `pattern` outside every sealed region.
 *
 * The one function every rewriting rule should go through. Written as a single
 * left-to-right pass so a replacement never shifts the mask out from under the
 * next match: the mask indexes the input, and the output is assembled beside it.
 */
export function replaceInProse(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string,
  mask = protectedMask(text),
): { output: string; count: number } {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  )
  let output = ''
  let read = 0
  let count = 0

  for (const match of text.matchAll(global)) {
    const start = match.index
    if (start === undefined || start < read) continue
    if (isSealed(mask, start, start + match[0].length)) continue

    output += text.slice(read, start) + replace(match as RegExpExecArray)
    read = start + match[0].length
    count += 1
  }

  return { output: output + text.slice(read), count }
}

/** The prose of a document, with sealed regions dropped — what stylometry measures. */
export function proseBlocks(text: string): Block[] {
  return blocksOf(text).filter((block) => PROSE_BLOCKS.has(block.kind))
}

/**
 * Paragraph-sized units of prose, as strings.
 *
 * Stylometry needs these because most of its signals are per paragraph, not per
 * document: three em dashes in one paragraph is a tell that a whole-document
 * density of twelve per thousand words hides completely.
 */
export function paragraphsOf(text: string): string[] {
  return proseBlocks(text)
    .filter((block) => block.kind === 'paragraph')
    .map((block) => text.slice(block.start, block.end))
    .filter((paragraph) => paragraph.trim().length > 0)
}
