import type { TextReport } from '../core/text/index.ts'
import { MIN_WORDS } from '../core/text/index.ts'
import { outcomeOf, type Row } from '../core/report.ts'
import { FindingsTable, Section } from './parts.tsx'
import { SourceView } from './SourceView.tsx'

export function TextDetails({
  text,
  report,
  selected,
  settled,
  onLocate,
  onApply,
}: {
  text: string
  report: TextReport
  selected: number | undefined
  settled: boolean
  onLocate: (row: Row) => void
  onApply: (row: Row) => void
}) {
  const located = report.findings.filter(
    (finding) => finding.scope !== 'document' && finding.length > 0,
  )
  const findings = report.findings.map((finding) =>
    outcomeOf(finding) === 'removed'
      ? { ...finding, available: 'Included when you clean the text; source unchanged.' }
      : finding,
  )
  return (
    <details className="border-t border-[var(--color-rule)] pt-4">
      <summary className="cursor-pointer text-sm text-[var(--color-muted)]">
        Inspection details
      </summary>
      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Findings">
            {text ? (
              <FindingsTable
                findings={findings}
                selectedOffset={selected}
                {...(settled ? { onLocate, onApply } : {})}
              />
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                Paste text to inspect supported marks.
              </p>
            )}
          </Section>
          {located.length > 0 ? (
            <Section title="Source" aside="select a mark to locate it">
              <SourceView
                text={text}
                findings={located}
                selected={selected}
                onSelect={(row) => {
                  if (settled) onLocate(row)
                }}
              />
            </Section>
          ) : undefined}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {report.stego.length > 0 ? (
            <Section title="Recovered payload">
              {report.stego.map((decoding) => (
                <div
                  key={`${decoding.scheme}-${decoding.offset}-${decoding.payload}`}
                  className="mb-3"
                >
                  <p className="font-mono break-all text-[var(--color-signal)]">
                    {decoding.payload}
                  </p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {decoding.detail} · offset {decoding.offset}
                  </p>
                </div>
              ))}
            </Section>
          ) : undefined}
          <Section
            title="Writing style"
            aside={
              report.style.measurable
                ? `${report.style.words} words`
                : `needs ${MIN_WORDS} words to measure`
            }
          >
            <p className="mb-3 text-sm text-[var(--color-muted)]">
              English-oriented style heuristics, not an AI detector. These measurements describe the
              source.
            </p>
            {report.style.measurable ? (
              (['phrase', 'structure', 'silhouette'] as const).map((layer) => (
                <details key={layer} className="border-t border-[var(--color-rule)] py-3">
                  <summary className="cursor-pointer text-sm capitalize">{layer}</summary>
                  <dl>
                    {report.style.metrics
                      .filter((metric) => metric.layer === layer)
                      .map((metric) => (
                        <div
                          key={metric.id}
                          className="flex justify-between gap-4 py-2 text-xs text-[var(--color-muted)]"
                        >
                          <dt>
                            {metric.label}
                            <span className="block">{metric.detail}</span>
                          </dt>
                          <dd className="font-mono">
                            {Number.isNaN(metric.value)
                              ? '—'
                              : Math.round(metric.value * 100) / 100}
                          </dd>
                        </div>
                      ))}
                  </dl>
                </details>
              ))
            ) : (
              <p className="text-xs text-[var(--color-muted)]">
                The sample is too short for reliable style measurements.
              </p>
            )}
          </Section>
        </div>
      </div>
    </details>
  )
}
