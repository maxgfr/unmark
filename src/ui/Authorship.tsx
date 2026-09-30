// The authorship assessment, as the page shows it.
//
// A sentence, not a number: "Likely AI-written" reads as the assessment it is,
// where a large 0.74 reads as a measurement it is not. The disclaimer sits
// directly under it, in the same block, so no reading of the verdict happens
// without it. No amber — that colour means a confirmed mark — and no green for
// the lowest verdict, which would be reassurance the engine cannot support.
//
// Loaded lazily, and only once the section is opened: the catalogues and the
// language models behind it are not what most visits to the Text tab need.

import { useMemo, useState } from 'react'
import {
  detectAuthorship,
  formatOfPaste,
  renderMarkdown,
  verdictSentence,
  type AuthorshipReport,
  type AuthorshipSpan,
} from '../core/text/authorship/index.ts'
import type { Row } from '../core/report.ts'
import { SourceView, type Band } from './SourceView.tsx'
import { saveBlob } from './download.ts'
import { IconDownload } from './icons.tsx'
import { useStable } from './useStable.ts'

const LANGUAGE = { fr: 'French', en: 'English', und: 'language undetermined' } as const

/** Passages listed under the source view: the bands a reader should look at. */
const LISTED = new Set(['high', 'medium'])

export default function Authorship({
  text,
  onLocate,
}: {
  text: string
  onLocate: (row: Row) => void
}) {
  // Assessed once typing pauses, not per keystroke; until then the last report
  // stays up, marked out of date, and nothing in it can be clicked — its
  // offsets address the text as it was.
  const assessed = useStable(text, 400)
  const stale = assessed !== text
  const report = useMemo(
    () => detectAuthorship(assessed, { format: formatOfPaste(assessed) }),
    [assessed],
  )
  const [reading, setReading] = useState<number | undefined>(undefined)

  const bands: Band[] = useMemo(
    () => report.spans.map(({ start, end, band }) => ({ start, end, band: band as Band['band'] })),
    [report],
  )

  const read = (index: number) => {
    if (stale) return
    setReading(index)
    const span = report.spans[index]
    if (span) {
      onLocate({
        kind: 'ai_style',
        verdict: 'informational',
        offset: span.start,
        length: span.end - span.start,
        label: span.excerpt,
      })
    }
  }

  const listed = report.spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => LISTED.has(span.band))

  return (
    <div
      className={`flex flex-col gap-5 transition-opacity duration-150 ${stale ? 'opacity-60' : ''}`}
      aria-busy={stale}
    >
      <Verdict report={report} />
      {stale ? (
        <p className="text-xs text-[var(--color-muted)]">
          The text changed; the assessment updates when you stop typing.
        </p>
      ) : undefined}

      {report.verdict === 'insufficient_evidence' ? undefined : (
        <>
          <dl className="border-t border-[var(--color-rule)]">
            {report.signals.map((signal) => (
              <div
                key={signal.id}
                className="flex justify-between gap-4 border-b border-[var(--color-rule)] py-2 text-xs text-[var(--color-muted)]"
              >
                <dt>
                  <span className="text-[var(--color-bone)]">{signal.label}</span>
                  <span className="block">{signal.detail}</span>
                </dt>
                <dd className="tnum font-mono">
                  {signal.value === null ? '—' : signal.value.toFixed(2)}
                </dd>
              </div>
            ))}
          </dl>

          {report.spans.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SourceView
                text={assessed}
                findings={[]}
                selected={undefined}
                onSelect={() => {}}
                bands={bands}
                activeBand={reading}
                onBand={read}
              />
              <Legend />
            </div>
          ) : undefined}

          {reading !== undefined && report.spans[reading] ? (
            <Passage report={report} span={report.spans[reading] as AuthorshipSpan} />
          ) : undefined}

          {listed.length > 0 ? (
            <ol className="flex flex-col">
              {listed.map(({ span, index }) => (
                <li key={span.start}>
                  <button
                    type="button"
                    onClick={() => read(index)}
                    disabled={stale}
                    aria-pressed={reading === index}
                    className={`grid w-full grid-cols-[4.5rem_3rem_1fr] gap-3 border-b border-[var(--color-rule)] py-2 text-left text-xs transition-colors duration-150 hover:bg-[var(--color-panel)] ${
                      reading === index ? 'bg-[var(--color-panel)]' : ''
                    }`}
                  >
                    <span className="tnum font-mono text-[var(--color-muted)]">
                      line {span.line}
                    </span>
                    <span className="tnum font-mono text-[var(--color-muted)]">
                      {span.score.toFixed(2)}
                    </span>
                    <span className="min-w-0 truncate">{span.excerpt}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : undefined}
        </>
      )}

      <details className="text-xs text-[var(--color-muted)]">
        <summary className="cursor-pointer">What is not evidence</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
          {report.notEvidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>

      <div>
        <button
          type="button"
          onClick={() =>
            saveBlob(
              new Blob([renderMarkdown(report)], { type: 'text/markdown;charset=utf-8' }),
              'authorship-report.md',
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)]"
        >
          <IconDownload />
          Export report (.md)
        </button>
      </div>
    </div>
  )
}

function Verdict({ report }: { report: AuthorshipReport }) {
  const abstained = report.verdict === 'insufficient_evidence'
  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={`text-base ${
          report.verdict === 'likely_ai' ? 'font-medium text-[var(--color-bone)]' : ''
        } ${abstained ? 'text-[var(--color-muted)]' : 'text-[var(--color-bone)]'}`}
      >
        {verdictSentence(report)}
      </p>
      <p className="tnum font-mono text-xs text-[var(--color-muted)]">
        {[
          ...(report.score === null ? [] : [`score ${report.score.toFixed(2)}`]),
          `confidence ${report.confidence}`,
          LANGUAGE[report.language.document],
          `${report.words} words`,
          `calibration ${report.calibration.id}${report.calibration.calibrated ? '' : ' (provisional)'}`,
        ].join(' · ')}
      </p>
      <p className="max-w-[65ch] text-xs leading-relaxed text-[var(--color-muted)]">
        {report.disclaimer}
      </p>
    </div>
  )
}

function Passage({ report, span }: { report: AuthorshipReport; span: AuthorshipSpan }) {
  const own = report.findings.filter((f) => f.start >= span.start && f.start < span.end)
  return (
    <div className="flex flex-col gap-2 border-l border-[var(--color-rule-bright)] pl-3 text-xs">
      <p className="tnum font-mono text-[var(--color-muted)]">
        line {span.line} · score {span.score.toFixed(2)} · {span.band}
        {span.lowConfidence ? ' · short sentence, low confidence' : ''}
      </p>
      {own.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {own.map((finding) => (
            <li key={finding.id}>
              <span className="font-mono text-[var(--color-bone)]">{finding.patternId}</span>
              <span className="block text-[var(--color-muted)]">{finding.reason}</span>
              <span className="block text-[var(--color-muted)]">Fix: {finding.fixHint}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[var(--color-muted)]">
          {span.reasons.length > 0
            ? `Measured, not matched: ${span.reasons.join(', ')}.`
            : 'Several weak habits together, none strong alone.'}
        </p>
      )}
    </div>
  )
}

/** The three underline styles, named: the only key the source view needs. */
function Legend() {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
      <span className="underline decoration-solid decoration-2 decoration-[var(--color-muted)] underline-offset-4">
        high
      </span>
      <span className="underline decoration-dashed decoration-[var(--color-muted)] underline-offset-4">
        medium
      </span>
      <span className="underline decoration-dotted decoration-[var(--color-rule-bright)] underline-offset-4">
        low
      </span>
      <span>select a passage to read why</span>
    </p>
  )
}
