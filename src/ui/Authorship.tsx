// The authorship assessment, as the page shows it.
//
// A sentence, not a number: "Likely AI-written" reads as the assessment it is,
// where a large 0.74 reads as a measurement it is not. The disclaimer sits
// directly under it, in the same block, so no reading of the verdict happens
// without it. No amber — that colour means a confirmed mark — and no green for
// the lowest verdict, which would be reassurance the engine cannot support.
//
// The same panel serves pasted text and a dropped .docx or PDF. For a
// document, passages are placed by page and section rather than by line, the
// file's own marks are listed apart from the prose, and a bilingual document
// is assessed block by block — what `unmark detect` prints, on the page.
//
// Below the verdict, the sweep: every sentence with a habit, quoted, with a
// rewrite that kept its numbers and reference calls. Nothing here leaves the
// tab: rewrites come from the deterministic pass, or from an agent the reader
// runs themselves, pasted back in and checked.
//
// Loaded lazily, and only once the section is opened: the catalogues and the
// language models behind it are not what most visits to the Text tab need.

import { useMemo, useState } from 'react'
import {
  ABSENCE_NOTE,
  coverageSentence,
  describeLocation,
  detectAuthorship,
  blockSentence,
  documentSentence,
  formatOfPaste,
  foundNothing,
  readsAcademic,
  renderMarkdown,
  topSpans,
  UNREACHABLE_NOTE,
  verdictSentence,
  type AuthorshipReport,
  type AuthorshipSpan,
  type DocumentSource,
  type FileMark,
  type Layout,
  type Location,
} from '../core/text/authorship/index.ts'
import {
  applyRewrites,
  needsAuthor,
  rewritesFrom,
  summariseRewrites,
  HABIT_LABEL,
  renderSweep,
  sweep,
  sweepPrompt,
  type SweepRow,
} from '../core/text/authorship/sweep.ts'
import { KIND_LABEL, type Row } from '../core/report.ts'
import { SourceView, type Band } from './SourceView.tsx'
import { saveBlob } from './download.ts'
import { IconDownload } from './icons.tsx'
import { Choice, CopyButton, Toggle } from './parts.tsx'
import { useStable } from './useStable.ts'

const LANGUAGE = { fr: 'French', en: 'English', und: 'language undetermined' } as const
const BLOCK_LANGUAGE = { fr: 'French', en: 'English', other: 'other language' } as const

/** Passages listed under the source view: the bands a reader should look at. */
const LISTED = new Set(['high', 'medium'])

/** How many sentences "highest scoring" lists. */
const TOP = 10

/** A document read from a file: its layout, what was left out, and its marks. */
export interface AssessedDocument {
  name: string
  format: string
  layout?: Layout
  document?: DocumentSource
  fileMarks?: FileMark[]
  /** Texts the sweep's quotes are checked against, by name. */
  sources?: Record<string, { text: string; loose?: boolean }>
}

type RegisterChoice = 'auto' | 'general' | 'academic'

const place = (item: { line: number; location?: Location }) =>
  describeLocation(item.location) ?? `line ${item.line}`

const button =
  'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)] disabled:cursor-not-allowed disabled:opacity-40'

export default function Authorship({
  text,
  onLocate,
  from,
}: {
  text: string
  onLocate?: (row: Row) => void
  from?: AssessedDocument
}) {
  // Assessed once typing pauses, not per keystroke; until then the last report
  // stays up, marked out of date, and nothing in it can be clicked — its
  // offsets address the text as it was.
  const assessed = useStable(text, 400)
  const stale = assessed !== text
  const [registerChoice, setRegisterChoice] = useState<RegisterChoice>('auto')
  const [top, setTop] = useState(false)
  const register = useMemo(
    () =>
      registerChoice === 'auto'
        ? readsAcademic(assessed, assessed.split(/\s+/u).filter(Boolean).length)
          ? 'academic'
          : 'general'
        : registerChoice,
    [assessed, registerChoice],
  )
  const options = useMemo(
    () => ({
      format: from?.format ?? formatOfPaste(assessed),
      register,
      ...(from?.layout ? { layout: from.layout } : {}),
      ...(from?.document ? { document: from.document } : {}),
      ...(from?.fileMarks ? { fileMarks: from.fileMarks } : {}),
    }),
    [assessed, from, register],
  )
  const report = useMemo(
    () => detectAuthorship(assessed, { ...options, ...(top ? { allSpans: true } : {}) }),
    [assessed, options, top],
  )
  const [reading, setReading] = useState<number | undefined>(undefined)

  const bands: Band[] = useMemo(
    () =>
      report.spans
        .filter((span) => span.band !== 'none')
        .map(({ start, end, band }) => ({ start, end, band: band as Band['band'] })),
    [report],
  )

  const read = (span: AuthorshipSpan) => {
    if (stale) return
    setReading(span.start)
    onLocate?.({
      kind: 'ai_style',
      verdict: 'informational',
      offset: span.start,
      length: span.end - span.start,
      label: span.excerpt,
    })
  }
  const readingSpan = report.spans.find((span) => span.start === reading)

  const listed = top ? topSpans(report, TOP) : report.spans.filter((span) => LISTED.has(span.band))
  const unweighted = report.findings.filter(
    (f) => f.category === 'hedging' || f.category === 'phrasing',
  )

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

      <div className="flex flex-wrap items-center gap-4">
        <Choice
          name="register"
          label="Register"
          value={registerChoice}
          options={[
            { value: 'auto', label: `Register: auto (${register})` },
            { value: 'general', label: 'General' },
            { value: 'academic', label: 'Academic' },
          ]}
          onChange={setRegisterChoice}
        />
        <Toggle checked={top} onChange={setTop}>
          Top {TOP} sentences, below the bands too
        </Toggle>
      </div>

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

          {!from && bands.length > 0 ? (
            <div className="flex flex-col gap-2">
              <SourceView
                text={assessed}
                findings={[]}
                selected={undefined}
                onSelect={() => {}}
                bands={bands}
                activeBand={bands.findIndex((band) => band.start === reading)}
                onBand={(index) => {
                  const band = bands[index]
                  const span = report.spans.find((s) => s.start === band?.start)
                  if (span) read(span)
                }}
              />
              <Legend />
            </div>
          ) : undefined}

          {readingSpan ? <Passage report={report} span={readingSpan} /> : undefined}

          {listed.length > 0 ? (
            <div className="flex flex-col gap-1">
              {top ? (
                <p className="text-xs text-[var(--color-muted)]">
                  The {TOP} sentences scoring highest, whatever their band: material for a judge,
                  not evidence.
                </p>
              ) : undefined}
              <ol className="flex flex-col">
                {listed.map((span) => (
                  <li key={span.start}>
                    <button
                      type="button"
                      onClick={() => read(span)}
                      disabled={stale}
                      aria-pressed={reading === span.start}
                      className={`grid w-full grid-cols-[minmax(4.5rem,auto)_3rem_1fr] gap-3 border-b border-[var(--color-rule)] py-2 text-left text-xs transition-colors duration-150 hover:bg-[var(--color-panel)] ${
                        reading === span.start ? 'bg-[var(--color-panel)]' : ''
                      }`}
                    >
                      <span className="tnum font-mono text-[var(--color-muted)]">
                        {place(span)}
                      </span>
                      <span className="tnum font-mono text-[var(--color-muted)]">
                        {span.score.toFixed(2)}
                      </span>
                      <span className="min-w-0 truncate">{span.excerpt}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : undefined}
        </>
      )}

      <Blocks report={report} />
      <FileMarks report={report} />
      <Recaps report={report} />

      {unweighted.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-muted)]">
            Hedging and wordy phrasing · {unweighted.length} · reported, not scored
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {unweighted.map((finding) => (
              <li key={finding.id}>
                <span className="tnum font-mono text-[var(--color-muted)]">{place(finding)}</span>{' '}
                <span className="font-mono text-[var(--color-bone)]">{finding.patternId}</span>
                <span className="block text-[var(--color-muted)]">{finding.excerpt}</span>
                <span className="block text-[var(--color-muted)]">Fix: {finding.fixHint}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : undefined}

      <Unsupported report={report} />

      <p className="text-xs text-[var(--color-muted)]">{coverageSentence(report.coverage)}</p>

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
              new Blob(
                [
                  renderMarkdown(
                    top ? { ...report, spans: topSpans(report, TOP) } : report,
                    top ? { minScore: 0, top: TOP } : {},
                  ),
                ],
                { type: 'text/markdown;charset=utf-8' },
              ),
              'authorship-report.md',
            )
          }
          className={button}
        >
          <IconDownload />
          Export report (.md)
        </button>
      </div>

      <Sweep text={assessed} options={options} sources={from?.sources} stale={stale} />
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
      {report.verdict === 'likely_human' || foundNothing(report) ? (
        <p className="max-w-[65ch] text-xs leading-relaxed text-[var(--color-muted)]">
          {ABSENCE_NOTE}
        </p>
      ) : null}
      {report.thresholds.humanReachable ? null : (
        <p className="max-w-[65ch] text-xs leading-relaxed text-[var(--color-muted)]">
          {UNREACHABLE_NOTE}
        </p>
      )}
      {report.document ? (
        <p className="max-w-[65ch] text-xs leading-relaxed text-[var(--color-muted)]">
          Read from {documentSentence(report.document)}
        </p>
      ) : null}
    </div>
  )
}

function Blocks({ report }: { report: AuthorshipReport }) {
  if (report.blocks.length < 2) return undefined
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="text-[var(--color-bone)]">Blocks</p>
      <p className="text-[var(--color-muted)]">
        Consecutive paragraphs in one language, each assessed with its own catalogue. The verdict
        above is their combination, weighted by words.
      </p>
      <table className="mt-1 w-full border-collapse text-left">
        <thead className="text-[var(--color-muted)]">
          <tr>
            <th className="py-1 font-normal">Language</th>
            <th className="py-1 font-normal">From → to</th>
            <th className="py-1 text-right font-normal">Words</th>
            <th className="py-1 font-normal">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {report.blocks.map((block) => (
            <tr key={block.start} className="border-t border-[var(--color-rule)]">
              <td className="py-1">{BLOCK_LANGUAGE[block.lang]}</td>
              <td className="tnum py-1 font-mono text-[var(--color-muted)]">
                {describeLocation(block.location, { paragraph: true }) ?? `line ${block.line}`} →{' '}
                {describeLocation(block.endLocation, { paragraph: true }) ??
                  `line ${block.endLine}`}
              </td>
              <td className="tnum py-1 text-right font-mono">{block.words}</td>
              <td className="py-1">
                {blockSentence(report, block)}
                {block.score === null ? '' : ` · ${block.score.toFixed(2)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FileMarks({ report }: { report: AuthorshipReport }) {
  if (report.fileMarks.length === 0) return undefined
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="text-[var(--color-bone)]">File marks</p>
      <p className="text-[var(--color-muted)]">
        Found in the file the text was read from, not in the prose: they say which tools handled the
        file, never who wrote the text.
      </p>
      <ul className="flex flex-col gap-2">
        {report.fileMarks.map((mark) => (
          <li key={`${mark.where ?? ''}-${mark.label}`}>
            <span className="text-[var(--color-bone)]">{KIND_LABEL[mark.kind]}</span>{' '}
            <span className="font-mono text-[var(--color-muted)]">{mark.where}</span>
            <span className="block text-[var(--color-muted)]">{mark.label}</span>
            {mark.placement ? (
              <span className="block text-[var(--color-muted)]">
                paragraph {mark.placement.paragraph}
                {mark.placement.caption ? ` — ${mark.placement.caption}` : ''}
              </span>
            ) : undefined}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Recaps({ report }: { report: AuthorshipReport }) {
  if (report.recaps.length === 0) return undefined
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)]">
        Repeated formulas · {report.recaps.length} · the same phrase copied into several sections
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {report.recaps.map((recap) => (
          <li key={recap.occurrences[0]?.start}>
            <span className="text-[var(--color-bone)]">« {recap.phrase} »</span>{' '}
            <span className="text-[var(--color-muted)]">
              ×{recap.occurrences.length}
              {recap.summary ? ' · one copy in a summary, which restates by design' : ''}
            </span>
            <span className="tnum block font-mono text-[var(--color-muted)]">
              {recap.occurrences.map((o) => place(o)).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

function Unsupported({ report }: { report: AuthorshipReport }) {
  const { unsupported, unsupportedShare } = report.language
  if (unsupported.length === 0) return undefined
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)]">
        Not assessed · {Math.round(unsupportedShare * 100)} % of the words read as a language with
        no catalogue
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {unsupported.map((segment) => (
          <li key={`${segment.line}-${segment.excerpt}`} className="text-[var(--color-muted)]">
            <span className="tnum font-mono">{place(segment)}</span> · {segment.lang} ·{' '}
            {segment.words} words · {segment.excerpt}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The judge's worksheet: every sentence with a habit, current text → replace
 * with. Computed only once opened; a document's sweep is the slow part.
 */
function Sweep({
  text,
  options,
  sources,
  stale,
}: {
  text: string
  options: Parameters<typeof sweep>[1]
  sources: AssessedDocument['sources']
  stale: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pasted, setPasted] = useState('')
  const [applied, setApplied] = useState<{ id: string; rewrite: string }[]>([])
  const [problem, setProblem] = useState('')
  const result = useMemo(
    () =>
      open
        ? sweep(text, {
            ...options,
            sources: sources ?? { 'the text': { text } },
          })
        : undefined,
    [open, text, options, sources],
  )
  const rows: SweepRow[] = useMemo(
    () => (result ? applyRewrites(result.rows, applied, 'agent') : []),
    [result, applied],
  )
  const outcome = useMemo(
    () => (applied.length > 0 ? summariseRewrites(rows, applied) : undefined),
    [rows, applied],
  )

  const apply = () => {
    try {
      const parsed: unknown = JSON.parse(
        pasted.slice(pasted.indexOf('['), pasted.lastIndexOf(']') + 1),
      )
      if (!Array.isArray(parsed)) throw new Error('not a list')
      setApplied(rewritesFrom(parsed).rewrites)
      setProblem('')
    } catch {
      setProblem('Paste a JSON list: [{"id": "S123", "rewrite": "…"}].')
    }
  }

  return (
    <details
      className="border-t border-[var(--color-rule)] pt-3 text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm text-[var(--color-bone)]">
        Every sentence with a habit (sweep)
      </summary>
      {result ? (
        <div className={`mt-3 flex flex-col gap-3 ${stale ? 'opacity-60' : ''}`}>
          <p className="text-[var(--color-muted)]">
            {rows.length} sentences carry a habit. Not proof of anything: sentences that would read
            better rewritten, whoever wrote them. A rewrite is proposed only once it has kept every
            number and reference call.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              onClick={() =>
                saveBlob(
                  new Blob([renderSweep({ ...result, rows }, describeLocation)], {
                    type: 'text/markdown;charset=utf-8',
                  }),
                  'sweep.md',
                )
              }
            >
              <IconDownload />
              Export sweep (.md)
            </button>
            <CopyButton value={sweepPrompt(rows)} label="Copy prompt for rewrites" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="sweep-rewrites" className="text-[var(--color-muted)]">
              Rewrites from an agent, pasted back as JSON — each is checked before it is shown
            </label>
            <textarea
              id="sweep-rewrites"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={3}
              className="rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-2 font-mono text-xs text-[var(--color-bone)]"
            />
            <div className="flex items-center gap-3">
              <button type="button" className={button} onClick={apply} disabled={!pasted.trim()}>
                Check and apply
              </button>
              {problem ? <span className="text-[var(--color-signal)]">{problem}</span> : undefined}
              {outcome ? (
                <span className="text-[var(--color-muted)]">
                  {outcome.verified} verified, {outcome.rejected} rejected
                  {outcome.unknown.length > 0
                    ? `, unknown id${outcome.unknown.length === 1 ? '' : 's'}: ${outcome.unknown.join(', ')}`
                    : ''}
                </span>
              ) : undefined}
            </div>
          </div>
          <table className="w-full border-collapse text-left">
            <thead className="text-[var(--color-muted)]">
              <tr>
                <th className="py-1 pr-2 font-normal">Where</th>
                <th className="py-1 pr-2 font-normal">Current text</th>
                <th className="py-1 pr-2 font-normal">Replace with</th>
                <th className="py-1 font-normal">Habit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-[var(--color-rule)] align-top">
                  <td className="tnum py-1 pr-2 font-mono text-[var(--color-muted)]">
                    {describeLocation(row.location) ?? `line ${row.line}`}
                  </td>
                  <td className="py-1 pr-2">
                    « {row.text} »
                    {row.quote.checked.length > 0 &&
                    row.quote.found.length < row.quote.checked.length ? (
                      <span className="block text-[var(--color-signal)]">
                        not found word for word in the source
                      </span>
                    ) : undefined}
                  </td>
                  <td className="py-1 pr-2">
                    {row.rewrite?.verified ? (
                      row.rewrite.text || <em>delete the sentence</em>
                    ) : row.rewrite ? (
                      <span className="text-[var(--color-muted)]">
                        rejected: {row.rewrite.failures?.[0] ?? 'failed the gate'}
                      </span>
                    ) : needsAuthor(row) ? (
                      <span className="text-[var(--color-muted)]">
                        add the reference call: only the author knows it
                      </span>
                    ) : (
                      <span className="text-[var(--color-muted)]">—</span>
                    )}
                  </td>
                  <td className="py-1 text-[var(--color-muted)]">
                    {row.habits.map((h) => HABIT_LABEL[h.type]).join(', ')}
                    <span className="block">
                      {row.confidence}
                      {row.registerExplained ? ' · the register explains it' : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : undefined}
    </details>
  )
}

function Passage({ report, span }: { report: AuthorshipReport; span: AuthorshipSpan }) {
  const own = report.findings.filter((f) => f.start >= span.start && f.start < span.end)
  return (
    <div className="flex flex-col gap-2 border-l border-[var(--color-rule-bright)] pl-3 text-xs">
      <p className="tnum font-mono text-[var(--color-muted)]">
        {place(span)} · score {span.score.toFixed(2)} · {span.band}
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
