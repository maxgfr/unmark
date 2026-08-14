import { useCallback, useState, type ReactNode } from 'react'
import { collapseRuns, type Finding, type Verdict } from '../core/report.ts'
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
const VERDICT_STYLE: Record<Verdict, string> = {
  confirmed: 'text-[var(--color-signal)] font-medium',
  probable: 'text-[var(--color-bone)]',
  informational: 'text-[var(--color-muted)]',
  likely_false_positive: 'text-[var(--color-muted)] line-through decoration-1',
}

const VERDICT_LABEL: Record<Verdict, string> = {
  confirmed: 'confirmed',
  probable: 'probable',
  informational: 'info',
  likely_false_positive: 'kept',
}

export function FindingsTable({ findings }: { findings: readonly Finding[] }) {
  if (findings.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 font-mono text-sm text-[var(--color-clean)]">
        <IconCheck />
        Nothing found.
      </p>
    )
  }

  // Eighty-eight carriers spelling one payload become one row. Listing each
  // would bury the single line the visitor came for.
  const rows = collapseRuns(findings)

  return (
    <ul className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
      {rows.map((finding, index) => (
        <li
          key={`${finding.kind}-${finding.offset}-${finding.label}`}
          className="finding-row grid grid-cols-[auto_1fr] gap-x-3 py-2.5 sm:grid-cols-[5.5rem_7.5rem_4rem_1fr]"
          style={{ '--row': index } as React.CSSProperties}
        >
          <span className={`font-mono text-xs ${VERDICT_STYLE[finding.verdict]}`}>
            {VERDICT_LABEL[finding.verdict]}
          </span>
          <span className="font-mono text-xs text-[var(--color-muted)] sm:order-none">
            {finding.kind}
          </span>
          <span className="tnum hidden font-mono text-xs text-[var(--color-muted)] sm:block">
            {finding.length > 0 ? finding.offset : '—'}
          </span>
          <div className="col-span-2 sm:col-span-1">
            <p className="text-sm text-[var(--color-bone)]">{finding.label}</p>
            {finding.evidence ? (
              <p className="mt-1 truncate font-mono text-xs text-[var(--color-muted)]">
                {finding.evidence}
              </p>
            ) : undefined}
            {finding.preserved ? (
              <p className="mt-1 text-xs text-[var(--color-muted)] italic">
                kept — {finding.preserved}
              </p>
            ) : undefined}
          </div>
        </li>
      ))}
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
