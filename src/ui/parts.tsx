import { useCallback, useState, type ReactNode } from 'react'
import {
  collapseRuns,
  editsOf,
  KIND_LABEL,
  outcomeOf,
  type Finding,
  type Outcome,
  type Row,
  type Verdict,
} from '../core/report.ts'
import { IconCheck, IconCopy } from './icons.tsx'

/** A ruled region. Not a card — the hairline is what makes this read as a report. */
export function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    // The first section in a column sits directly under the nav's own rule;
    // a second hairline 30px below it reads as a mistake, not a divider.
    <section className="border-t border-[var(--color-rule)] pt-4 first:border-t-0 first:pt-0">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[11px] font-medium tracking-[0.14em] text-[var(--color-muted)] uppercase">
          {title}
        </h2>
        {aside ? <div className="text-xs text-[var(--color-muted)]">{aside}</div> : undefined}
      </header>
      {children}
    </section>
  )
}

// Verdict is carried by weight and colour together. Colour alone would fail for
// anyone who cannot separate the amber from the bone.
//
// Nothing is struck through. An earlier version struck out the
// `likely_false_positive` row, which reads as "this was deleted" — the exact
// opposite of what happened to it.
const VERDICT_STYLE: Record<Verdict, string> = {
  confirmed: 'text-[var(--color-signal)] font-medium',
  probable: 'text-[var(--color-bone)]',
  informational: 'text-[var(--color-muted)]',
  likely_false_positive: 'text-[var(--color-muted)]',
}

const VERDICT_LABEL: Record<Verdict, string> = {
  confirmed: 'confirmed',
  probable: 'probable',
  informational: 'info',
  likely_false_positive: 'false pos.',
}

const OUTCOME_STYLE: Record<Outcome, string> = {
  removed: 'border-[var(--color-rule-bright)] text-[var(--color-muted)]',
  kept: 'border-[var(--color-clean)]/40 text-[var(--color-clean)]',
  // Waiting on a toggle, which is a different state from deliberately kept.
  available: 'border-[var(--color-rule-bright)] text-[var(--color-bone)]',
  reported: 'border-[var(--color-rule)] text-[var(--color-muted)]',
}

/**
 * Where a finding is, in whatever terms it actually has.
 *
 * Three cases and they are genuinely different: a byte or character offset, a
 * part inside a zip that has no meaningful offset of its own, and a tell that
 * describes the document rather than a place in it. Printing `at 0` for the
 * last two said nothing, twice.
 */
function Location({ finding }: { finding: Finding }) {
  if (finding.where) {
    return (
      <span className="font-mono text-xs break-all text-[var(--color-muted)]">{finding.where}</span>
    )
  }
  if (finding.scope === 'document') {
    return <span className="text-xs text-[var(--color-muted)]">whole document</span>
  }
  if (finding.length === 0) return undefined
  return (
    <span className="tnum font-mono text-xs text-[var(--color-muted)]">at {finding.offset}</span>
  )
}

/** What would be written in this span's place, or why nothing can be. */
function Proposal({ row }: { row: Row }) {
  const edits = editsOf(row)
  if (edits.length === 0) {
    return row.noFix ? (
      <p className="mt-1 text-xs text-[var(--color-muted)] italic">{row.noFix}</p>
    ) : undefined
  }

  const replacement = (edits[0] as Finding).replacement as string
  return (
    <p className="mt-1 font-mono text-xs text-[var(--color-bone)]">
      {replacement.length === 0 ? (
        <span className="text-[var(--color-muted)]">delete it</span>
      ) : (
        <>
          <span className="text-[var(--color-muted)]">becomes </span>
          {JSON.stringify(replacement)}
        </>
      )}
    </p>
  )
}

export function FindingsTable({
  findings,
  selectedOffset,
  onLocate,
  onApply,
}: {
  findings: readonly Finding[]
  /**
   * The offset currently selected elsewhere, so the row showing it can say so.
   * An offset rather than a row index: the report is rebuilt on every keystroke
   * and an index into the previous one would point at a different finding.
   */
  selectedOffset?: number | undefined
  onLocate?: (row: Row) => void
  onApply?: (row: Row) => void
}) {
  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 font-mono text-sm text-[var(--color-clean)]">
        <IconCheck />
        Nothing found.
      </p>
    )
  }

  // A crowd of carriers folds to a row per codepoint, and the rows are ordered
  // by verdict so the answer to "did anything matter" is the first one.
  const rows = collapseRuns(findings)

  return (
    <ul className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
      {rows.map((row, index) => {
        const outcome = outcomeOf(row)
        const edits = editsOf(row)
        const locatable = onLocate !== undefined && row.scope !== 'document' && row.length > 0
        const selected = selectedOffset !== undefined && selectedOffset === row.offset

        return (
          <li
            key={`${row.kind}-${row.offset}-${row.label}`}
            className={`finding-row grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-1 py-3 ${
              locatable ? 'finding-row-clickable' : ''
            } ${selected ? 'bg-[var(--color-panel)]' : ''}`}
            style={{ '--row': index } as React.CSSProperties}
          >
            {/* The whole left column is the target, not a small "locate" link:
                the row is what the reader is already looking at, and a separate
                control would make finding a mark a second thing to find. */}
            <div
              className={`min-w-0 ${locatable ? 'cursor-pointer text-left' : ''}`}
              {...(locatable
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: () => onLocate(row),
                    onKeyDown: (event: React.KeyboardEvent) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onLocate(row)
                    },
                  }
                : {})}
            >
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-[var(--color-bone)]">
                <span className="font-medium">{KIND_LABEL[row.kind]}</span>
                <span className={`font-mono text-xs ${VERDICT_STYLE[row.verdict]}`}>
                  {VERDICT_LABEL[row.verdict]}
                </span>
                <Location finding={row} />
              </p>
              <p className="mt-0.5 text-sm text-[var(--color-muted)]">{row.label}</p>
              {row.evidence ? (
                <p className="mt-1 font-mono text-xs break-all text-[var(--color-bone)]">
                  {row.evidence}
                </p>
              ) : undefined}
              {(row.preserved ?? row.available) ? (
                <p className="mt-1 text-xs text-[var(--color-muted)] italic">
                  {row.preserved ?? row.available}
                </p>
              ) : undefined}
              <Proposal row={row} />
            </div>

            <div className="flex flex-col items-end gap-1.5">
              {/* The column the table was missing: what was done, not how sure we
                  are. A confirmed emoji joiner is kept; a probable XMP packet goes. */}
              <span
                className={`h-fit rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${OUTCOME_STYLE[outcome]}`}
              >
                {outcome}
              </span>
              {onApply && edits.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onApply(row)}
                  className="rounded-md border border-[var(--color-rule)] px-2 py-0.5 text-xs whitespace-nowrap text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel-high)]"
                >
                  {edits.length > 1 ? `Apply all ${edits.length}` : 'Apply'}
                </button>
              ) : undefined}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }, [value])

  return (
    <button
      type="button"
      onClick={copy}
      disabled={value.length === 0}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {copied ? <IconCheck className="text-[var(--color-clean)]" /> : <IconCopy />}
      {copied ? 'Copied' : label}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  children,
  hint,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 appearance-none rounded-sm border border-[var(--color-rule-bright)] transition-colors duration-150 checked:border-[var(--color-signal)] checked:bg-[var(--color-signal)]"
      />
      <span>
        <span className="text-[var(--color-bone)]">{children}</span>
        {hint ? <span className="block text-xs text-[var(--color-muted)]">{hint}</span> : undefined}
      </span>
    </label>
  )
}

/**
 * One choice out of a few, as a segmented control.
 *
 * Built on real radio inputs rather than buttons with `role="radio"`. The
 * arrow-key behaviour a radio group has — and that a row of buttons does not,
 * without a roving tabindex nobody remembers to write — comes free, and the
 * group is one tab stop instead of three.
 */
export function Choice<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  /** Shared across the inputs, which is what makes them one group to the browser. */
  name: string
  label: string
  value: T
  /** `unavailable` is the reason, shown on hover — never a bare boolean. */
  options: readonly { value: T; label: string; unavailable?: string | undefined }[]
  onChange: (next: T) => void
}) {
  return (
    <fieldset className="inline-flex gap-0.5 rounded-md border border-[var(--color-rule)] p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <label
            key={option.value}
            title={option.unavailable}
            className={`rounded-[4px] px-2.5 py-1 text-xs transition-colors duration-150 has-[:focus-visible]:outline has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-[var(--color-signal)] ${
              option.unavailable
                ? 'cursor-not-allowed text-[var(--color-muted)] opacity-40'
                : selected
                  ? 'cursor-pointer bg-[var(--color-panel-high)] text-[var(--color-bone)]'
                  : 'cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-bone)]'
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              disabled={option.unavailable !== undefined}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        )
      })}
    </fieldset>
  )
}

/** A number chosen by dragging, with the number itself always on screen. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  reading,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** What to print beside it. The raw value is rarely the useful units. */
  reading: string
  onChange: (next: number) => void
}) {
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="shrink-0 text-[var(--color-muted)]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 min-w-0 flex-1"
      />
      <span className="tnum w-10 shrink-0 text-right font-mono text-[var(--color-bone)]">
        {reading}
      </span>
    </label>
  )
}

/**
 * The limit panel.
 *
 * Not a footnote and not dismissible: what the tool cannot do belongs on the
 * screen that does the doing. A visitor who reads "cleaned" and assumes it
 * means unwatermarked has been misled by the interface, not by the engine.
 */
export function Limits({ children }: { children: ReactNode }) {
  return (
    <aside className="border-t border-[var(--color-rule)] pt-4 text-xs leading-relaxed text-[var(--color-muted)]">
      <h2 className="mb-1.5 text-[11px] font-medium tracking-[0.14em] text-[var(--color-muted)] uppercase">
        What this does not remove
      </h2>
      {children}
    </aside>
  )
}
