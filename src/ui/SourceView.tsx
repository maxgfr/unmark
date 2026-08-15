// The document, with every mark in it made visible.
//
// A findings table that prints `at 62` has told the reader a number and left
// them to find the character themselves — and for most of what this tool finds,
// that is not possible by eye: a zero-width space renders as nothing, and an
// exotic space renders as a space. Highlighting the input would put a
// zero-pixel-wide box around the thing the reader came to see.
//
// So the carriers are drawn as chips carrying their codepoint, the visible
// marks are drawn as themselves and underlined, and a decoded payload gets a
// band under the whole run that spelled it. Clicking any of them selects its
// row; clicking a row scrolls and flashes the mark here.

import { useEffect, useMemo, useRef } from 'react'
import type { Finding, FindingKind } from '../core/report.ts'

/**
 * Kinds that render as nothing, or as something indistinguishable from nothing.
 *
 * The list is deliberately about *rendering*, not about severity: an exotic
 * space is drawn as a chip for the same reason a zero-width space is, which is
 * that the reader cannot otherwise tell it from the U+0020 beside it.
 */
const INVISIBLE: ReadonlySet<FindingKind> = new Set([
  'zwj_family',
  'bidi',
  'tag_chars',
  'variation_selector',
  'space',
])

/**
 * Above this many marks, stop drawing them and say so.
 *
 * A pasted megabyte of tag characters is one span per carrier, and a browser
 * asked for a million of them stops responding. Degrading with the count
 * printed is a different thing from freezing, and the tool's own rule is that a
 * limit is stated rather than discovered.
 */
const MAX_MARKS = 2000

const uPlus = (point: number) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * What to print inside a chip.
 *
 * The distinct codepoints rather than the first one: a SNOW run is a tab-and-
 * space alphabet, and showing only `U+0009` would name half of it.
 */
function chipLabel(slice: string): string {
  const points = [...new Set([...slice].map((character) => character.codePointAt(0) ?? 0))]
  const named = points.slice(0, 2).map(uPlus).join('/') + (points.length > 2 ? '/…' : '')
  const count = [...slice].length
  return count > 1 ? `${named} ×${count}` : named
}

interface Run {
  text: string
  /** Index into `findings`, when this run is a mark. */
  mark?: number
  /** Inside the span of a decoded payload. */
  banded: boolean
}

/**
 * Split the document into plain runs and marked ones.
 *
 * Shorter spans win where two overlap, which is what keeps a carrier chip
 * visible inside the payload that carrier helped spell. The payload itself is
 * not a mark but a band: it covers characters that already belong to their own
 * findings, so it is drawn as a background across both rather than as a box
 * that would have to contain them.
 */
function runsOf(text: string, findings: readonly Finding[]): { runs: Run[]; hidden: number } {
  const bands = findings.filter((f) => f.kind === 'stego_payload' && f.length > 0)
  const inBand = (offset: number) =>
    bands.some((band) => offset >= band.offset && offset < band.offset + band.length)

  const claimed: { start: number; end: number; mark: number }[] = []
  const candidates = findings
    .map((finding, mark) => ({ finding, mark }))
    .filter(({ finding }) => finding.kind !== 'stego_payload' && finding.length > 0)
    .sort((a, b) => a.finding.length - b.finding.length || a.finding.offset - b.finding.offset)

  let hidden = 0
  for (const { finding, mark } of candidates) {
    const start = finding.offset
    const end = start + finding.length
    if (claimed.some((span) => start < span.end && end > span.start)) continue
    if (claimed.length >= MAX_MARKS) {
      hidden += 1
      continue
    }
    claimed.push({ start, end, mark })
  }
  claimed.sort((a, b) => a.start - b.start)

  // Touching chips of one kind become one chip.
  //
  // Without this, an eleven-character payload draws a hundred and twelve
  // identical boxes and the panel is a wall of them — the same failure
  // `collapseRuns` exists to prevent in the table, reproduced in the view whose
  // job is to make the document readable. One chip reading `U+200B/U+200C ×112`
  // says more, and clicking it selects the whole run, which is the thing a
  // reader looking at a payload actually wants.
  const merged: typeof claimed = []
  for (const span of claimed) {
    const previous = merged.at(-1)
    const kind = (findings[span.mark] as Finding).kind
    const sameRun =
      previous !== undefined &&
      previous.end === span.start &&
      INVISIBLE.has(kind) &&
      (findings[previous.mark] as Finding).kind === kind
    if (sameRun) previous.end = span.end
    else merged.push({ ...span })
  }

  const runs: Run[] = []
  let read = 0
  for (const span of merged) {
    if (span.start > read) {
      // Plain text is split at band edges too, so a payload's background runs
      // continuously under the words as well as under the carriers.
      let cursor = read
      while (cursor < span.start) {
        const banded = inBand(cursor)
        let next = cursor + 1
        while (next < span.start && inBand(next) === banded) next += 1
        runs.push({ text: text.slice(cursor, next), banded })
        cursor = next
      }
    }
    runs.push({
      text: text.slice(span.start, span.end),
      mark: span.mark,
      banded: inBand(span.start),
    })
    read = span.end
  }
  if (read < text.length) {
    let cursor = read
    while (cursor < text.length) {
      const banded = inBand(cursor)
      let next = cursor + 1
      while (next < text.length && inBand(next) === banded) next += 1
      runs.push({ text: text.slice(cursor, next), banded })
      cursor = next
    }
  }

  return { runs, hidden }
}

export function SourceView({
  text,
  findings,
  selected,
  onSelect,
}: {
  text: string
  /** Positional findings only, addressing `text` as it stands. */
  findings: readonly Finding[]
  selected: number | undefined
  onSelect: (index: number) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const { runs, hidden } = useMemo(() => runsOf(text, findings), [text, findings])

  // Scrolling is done by querying rather than by holding a ref per mark: there
  // may be two thousand of them, and a map of two thousand refs rebuilt on every
  // keystroke costs more than one selector lookup on a click.
  useEffect(() => {
    if (selected === undefined) return
    container.current
      ?.querySelector(`[data-mark="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  return (
    <>
      <div
        ref={container}
        className="max-h-64 w-full overflow-auto rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap"
      >
        {runs.map((run, index) => {
          const key = `${index}-${run.mark ?? 'plain'}`
          if (run.mark === undefined) {
            return run.banded ? (
              <span key={key} className="bg-[var(--color-signal-dim)]">
                {run.text}
              </span>
            ) : (
              <span key={key}>{run.text}</span>
            )
          }

          const finding = findings[run.mark] as Finding
          const invisible = INVISIBLE.has(finding.kind)
          const active = selected === run.mark

          return (
            <button
              key={key}
              type="button"
              data-mark={run.mark}
              onClick={() => onSelect(run.mark as number)}
              aria-pressed={active}
              title={finding.label}
              // No amber on a mark, whatever its verdict. The palette reserves
              // it for a confirmed finding and a decoded payload, and an
              // eleven-character payload is a hundred and twelve confirmed
              // carriers: colouring each one spends the page's only scanning
              // affordance on a wall of boxes. The band under a payload is the
              // one amber this view draws, and it is drawn once.
              className={`${run.banded ? 'bg-[var(--color-signal-dim)] ' : ''}${
                invisible
                  ? 'mx-0.5 rounded-sm border border-[var(--color-rule-bright)] px-1 align-baseline text-[10px] tracking-wide text-[var(--color-muted)] hover:border-[var(--color-bone)] hover:text-[var(--color-bone)]'
                  : 'underline decoration-[var(--color-rule-bright)] decoration-dotted underline-offset-4 hover:decoration-[var(--color-bone)]'
              } ${active ? 'mark-selected' : ''} cursor-pointer transition-colors duration-150`}
            >
              {invisible ? chipLabel(run.text) : run.text}
            </button>
          )
        })}
      </div>
      {hidden > 0 ? (
        <p className="tnum mt-2 font-mono text-xs text-[var(--color-muted)]">
          {hidden} more not drawn — {MAX_MARKS} marks is as much as this view renders.
        </p>
      ) : undefined}
    </>
  )
}
