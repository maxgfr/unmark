// Cutting a document into pieces the local model can actually return.
//
// Measured on the shipped model: a repair is accepted up to roughly 250 words,
// and past that the model stops returning the whole passage — it drops
// sentences, so the content checks correctly report a lost date and the whole
// rewrite is refused. One long document therefore failed completely while each
// of its paragraphs would have succeeded on its own.
//
// So the document is cut and the pieces are rewritten one at a time. Two
// properties make that safe to reassemble:
//
//   the pieces TILE the text — every byte belongs to exactly one piece, in
//   order, so concatenating them reproduces the source exactly, blank lines
//   and trailing spaces included;
//
//   a piece that fails keeps its own source, so one bad paragraph costs that
//   paragraph rather than the document.

/** A slice of the document: `text` is `source.slice(start, end)`. */
export interface Chunk {
  text: string
  start: number
  end: number
}

/** Words per chunk, under the measured ceiling with room for the model to breathe. */
export const CHUNK_WORDS = 180

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/u).length : 0)

/**
 * Paragraph boundaries, as offsets that tile the text.
 *
 * A blank line ends a paragraph, and the blank line belongs to the paragraph
 * before it — that is what makes the pieces join back together untouched.
 */
function paragraphs(text: string): Chunk[] {
  const out: Chunk[] = []
  const separator = /\n[ \t]*\n[\s]*/gu
  let start = 0
  for (const match of text.matchAll(separator)) {
    const end = match.index + match[0].length
    out.push({ text: text.slice(start, end), start, end })
    start = end
  }
  if (start < text.length) out.push({ text: text.slice(start), start, end: text.length })
  return out
}

/**
 * Sentence boundaries inside one oversized paragraph.
 *
 * Only reached when a single paragraph is longer than the budget; a wall of
 * text with no blank line still has to be cut somewhere, and a full stop is
 * the least damaging place. The trailing space belongs to the sentence before
 * it, for the same tiling reason.
 */
function sentences(chunk: Chunk): Chunk[] {
  const out: Chunk[] = []
  const boundary = /[.!?…]["'”’)\]]*\s+/gu
  let start = chunk.start
  for (const match of chunk.text.matchAll(boundary)) {
    const end = chunk.start + match.index + match[0].length
    out.push({ text: chunk.text.slice(start - chunk.start, end - chunk.start), start, end })
    start = end
  }
  if (start < chunk.end) {
    out.push({ text: chunk.text.slice(start - chunk.start), start, end: chunk.end })
  }
  return out
}

/**
 * The document as pieces of at most `budget` words, in order, tiling the text.
 *
 * Pieces are packed greedily: paragraphs join until the next one would go over,
 * so a document of short paragraphs is not cut into needlessly many requests.
 * A piece may still exceed the budget when a single sentence does; there is
 * nothing left to split, and handing the model one long sentence is better than
 * handing it nothing.
 */
export function chunkDocument(text: string, budget: number = CHUNK_WORDS): Chunk[] {
  if (!text) return []
  const units: Chunk[] = []
  for (const paragraph of paragraphs(text)) {
    if (words(paragraph.text) > budget) units.push(...sentences(paragraph))
    else units.push(paragraph)
  }
  if (units.length === 0) return [{ text, start: 0, end: text.length }]

  const packed: Chunk[] = []
  let current: Chunk | undefined
  for (const unit of units) {
    if (current && words(current.text) + words(unit.text) <= budget) {
      current = { text: text.slice(current.start, unit.end), start: current.start, end: unit.end }
      continue
    }
    if (current) packed.push(current)
    current = unit
  }
  if (current) packed.push(current)
  return packed
}
