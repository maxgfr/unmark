// Offsets are for machines; lines are for the person reading the report.
//
// Every finding in this codebase addresses the text in UTF-16 code units,
// which is what a textarea selection takes and what `String.slice` takes. A
// report meant to be read next to an editor needs the other coordinate system:
// "line 14, column 3". This module converts one to the other, once per text,
// in the time it takes to find the newlines.

export interface Position {
  /** 1-based. */
  line: number
  /** 1-based, in code points, so an emoji is one column as it is on screen. */
  col: number
}

export interface LineIndex {
  /** How many lines the text has. An empty text has one. */
  lines: number
  locate(offset: number): Position
}

/**
 * Index the newlines of `text` for repeated lookups.
 *
 * Built once, queried by binary search, because a report locates hundreds of
 * spans and a scan from the top for each one is quadratic on a long document.
 * `\r\n` needs no special case: the `\n` ends the line, and the `\r` before it
 * sits at the end of the line it closes, where no finding starts.
 */
export function lineIndex(text: string): LineIndex {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1)
  }

  // Columns count code points, so every low surrogate before an offset on its
  // line is one unit that is not a column. A running count makes that a
  // subtraction instead of a scan — on one megabyte with no newline, the scan
  // was quadratic. Built only when the text has surrogates at all.
  let pairs: Uint32Array | undefined
  if (/[\u{10000}-\u{10FFFF}]/u.test(text)) {
    pairs = new Uint32Array(text.length + 1)
    for (let at = 0; at < text.length; at += 1) {
      const unit = text.charCodeAt(at)
      const low = unit >= 0xdc00 && unit <= 0xdfff
      const paired = low && at > 0 && isHigh(text.charCodeAt(at - 1))
      pairs[at + 1] = (pairs[at] as number) + (paired ? 1 : 0)
    }
  }

  return {
    lines: starts.length,
    locate(offset: number): Position {
      const target = Math.max(0, Math.min(offset, text.length))
      let low = 0
      let high = starts.length - 1
      while (low < high) {
        const middle = (low + high + 1) >> 1
        if ((starts[middle] as number) <= target) low = middle
        else high = middle - 1
      }

      const start = starts[low] as number
      // A low surrogate belongs to the high one before it: one character.
      const inside = pairs ? (pairs[target] as number) - (pairs[start] as number) : 0
      return { line: low + 1, col: target - start + 1 - inside }
    },
  }
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
