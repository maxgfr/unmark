// Where every character came from, so a report can point at the document the
// reader is actually looking at.
//
// `cleanText` runs four passes and each one is handed the output of the one
// before it, so each reports offsets into a different string. That was a known
// compromise for as long as the report was a printed column of numbers: being
// eighty-eight characters out is invisible when nobody clicks. It stops being
// invisible the moment an offset has to select a span in a textarea, and a
// selection that lands on the wrong word is worse than no selection at all.
//
// A frame is the answer: an origin per code unit, carried alongside the string
// as it is edited, so any later offset can be read back into what was pasted.

import type { Finding } from '../report.ts'

/** One replacement, in the coordinates of the string it is applied to. */
export interface Splice {
  start: number
  end: number
  to: string
}

/**
 * Where each code unit of an edited string came from.
 *
 * One entry longer than the string, and the last is the original's length. That
 * sentinel is what lets a span's end be read exactly like its start, with no
 * separate branch for the end of the document to be wrong at.
 */
export type Frame = Int32Array

export function identity(length: number): Frame {
  const frame = new Int32Array(length + 1)
  for (let index = 0; index <= length; index += 1) frame[index] = index
  return frame
}

/**
 * Apply splices to a string and to its frame together.
 *
 * One function rather than two, because a string and a frame built by separate
 * loops are a pair that can disagree, and the disagreement is invisible until
 * an interface selects the wrong words. Passing a frame composes: the result
 * maps back to whatever that frame mapped back to, not merely to `text`.
 */
export function splice(
  text: string,
  splices: readonly Splice[],
  frame: Frame = identity(text.length),
): { text: string; frame: Frame } {
  if (splices.length === 0) return { text, frame }

  const ordered = [...splices].sort((a, b) => a.start - b.start)

  // Overlapping splices are skipped rather than thrown on. Every caller already
  // guarantees they do not overlap, and this runs on every keystroke: a report
  // that stops rendering is a worse answer to a bug than a report missing one
  // row of it.
  let out = ''
  const origins: number[] = []
  let read = 0

  for (const edit of ordered) {
    if (edit.start < read || edit.end < edit.start) continue

    for (let index = read; index < edit.start; index += 1) origins.push(frame[index] as number)
    // Every code unit written by a pass maps back to the one point it replaced.
    // U+2026 becomes three dots, and there is no character-by-character
    // correspondence to offer: inventing one would put the second dot at an
    // offset that never held anything.
    for (let index = 0; index < edit.to.length; index += 1) {
      origins.push(frame[edit.start] as number)
    }

    out += text.slice(read, edit.start) + edit.to
    read = edit.end
  }

  for (let index = read; index < text.length; index += 1) origins.push(frame[index] as number)
  out += text.slice(read)
  origins.push(frame[text.length] as number)

  return { text: out, frame: Int32Array.from(origins) }
}

/** `inner` maps into a string `outer` already maps; the result maps to the origin. */
export const through = (outer: Frame, inner: Frame): Frame =>
  inner.map((index) => outer[index] ?? 0)

/**
 * A span in this frame, as a span in the document it maps back to.
 *
 * A span whose end abuts a deletion comes back covering the deleted characters
 * too. That is generous rather than short, which is the right direction for
 * something a reader is about to see selected: it includes the carrier that was
 * sitting inside the phrase rather than stopping one character before it.
 */
export function span(
  frame: Frame,
  offset: number,
  length: number,
): { offset: number; length: number } {
  const start = frame[offset] ?? 0
  const end = frame[offset + length] ?? start
  return { offset: start, length: Math.max(0, end - start) }
}

/** A finding rewritten to index the original document. */
export function rebase(frame: Frame, finding: Finding): Finding {
  if (finding.scope === 'document') {
    return { ...finding, offset: 0, length: frame[frame.length - 1] ?? 0 }
  }
  return { ...finding, ...span(frame, finding.offset, finding.length) }
}
