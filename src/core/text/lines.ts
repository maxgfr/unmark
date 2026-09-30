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
      let col = 1
      for (let at = start; at < target; at += 1) {
        const unit = text.charCodeAt(at)
        // A low surrogate belongs to the high one before it: one character.
        if (!(unit >= 0xdc00 && unit <= 0xdfff && at > start)) col += 1
      }
      return { line: low + 1, col }
    },
  }
}
