import { useDeferredValue, useMemo, useState } from 'react'
import {
  cleanText,
  decodeStego,
  encodeStego,
  analyzeStyle,
  stegoFindings,
  stylometryFindings,
  MIN_WORDS,
} from '../core/text/index.ts'
import { byPosition } from '../core/report.ts'
import { CopyButton, FindingsTable, Limits, Section, Toggle } from './parts.tsx'

const EXAMPLE = `Quarterly results are attached. Please keep this internal.${encodeStego(
  'recipient-4417',
  'zero-width',
)}`

export function TextTab() {
  const [input, setInput] = useState('')
  const [paranoid, setParanoid] = useState(false)
  const [confusables, setConfusables] = useState(false)

  // The report lags the keystroke rather than the textarea: typing must never
  // wait on a full re-scan of a long document.
  const deferred = useDeferredValue(input)

  const report = useMemo(() => {
    const options = { ...(paranoid ? { paranoid } : {}), ...(confusables ? { confusables } : {}) }
    const cleaned = cleanText(deferred, options)
    return {
      cleaned,
      stego: decodeStego(deferred),
      style: analyzeStyle(deferred),
      findings: [
        ...cleaned.findings,
        ...cleaned.preserved,
        ...stegoFindings(deferred),
        ...stylometryFindings(deferred),
      ].sort(byPosition),
    }
  }, [deferred, paranoid, confusables])

  const removed = report.cleaned.findings.length
  const tells = report.style.metrics.filter((metric) => metric.triggered)

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
      {/* Input first when stacked. Putting the report first buried the textarea
          under an empty findings panel on a first visit. */}
      <div className="flex flex-col gap-6">
        <Section
          title="Paste the text"
          aside={
            input.length > 0 ? (
              <button
                type="button"
                onClick={() => setInput('')}
                className="transition-colors duration-150 hover:text-[var(--color-bone)]"
              >
                Clear
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setInput(EXAMPLE)}
                className="transition-colors duration-150 hover:text-[var(--color-bone)]"
              >
                Load a marked example
              </button>
            )
          }
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
            placeholder="Anything you paste stays in this tab. There is no server to send it to."
            aria-label="Text to inspect"
            className="h-56 w-full resize-y rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3 font-mono text-sm leading-relaxed text-[var(--color-bone)] transition-colors duration-150 outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-rule-bright)]"
          />

          <div className="mt-4 flex flex-col gap-2.5">
            <Toggle
              checked={confusables}
              onChange={setConfusables}
              hint="Cyrillic and Greek lookalikes back to Latin. Wrong more often than right in multilingual text."
            >
              Normalise confusable letters
            </Toggle>
            <Toggle
              checked={paranoid}
              onChange={setParanoid}
              hint="Also strips emoji glue and script joiners. This corrupts legitimate text by design."
            >
              Paranoid mode
            </Toggle>
          </div>
        </Section>

        <Section title="Cleaned text" aside={<CopyButton value={report.cleaned.output} />}>
          <output className="block h-40 w-full overflow-auto rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap">
            {report.cleaned.output || (
              <span className="text-[var(--color-muted)]">Nothing to clean yet.</span>
            )}
          </output>
          {input.length > 0 ? (
            <p className="tnum mt-2 font-mono text-xs text-[var(--color-muted)]">
              {removed} removed · {report.cleaned.preserved.length} kept ·{' '}
              {input.length - report.cleaned.output.length} characters shorter
            </p>
          ) : undefined}
        </Section>
      </div>

      <div className="flex flex-col gap-6">
        {report.stego.length > 0 ? (
          <Section title="Recovered payload" aside="what the invisible characters spell">
            {report.stego.map((decoding) => (
              <div key={`${decoding.scheme}-${decoding.offset}`} className="mb-3 last:mb-0">
                <p className="font-mono text-lg leading-snug break-all text-[var(--color-signal)]">
                  {decoding.payload}
                </p>
                <p className="tnum mt-1 font-mono text-xs text-[var(--color-muted)]">
                  {decoding.detail} · from offset {decoding.offset}
                </p>
              </div>
            ))}
          </Section>
        ) : undefined}

        <Section
          title="Findings"
          aside={input.length > 0 ? `${report.findings.length} total` : undefined}
        >
          {input.length === 0 ? (
            <p className="py-2 text-sm text-[var(--color-muted)]">
              Paste something to inspect it. Everything runs in this tab.
            </p>
          ) : (
            <FindingsTable findings={report.findings} />
          )}
        </Section>

        {input.length > 0 ? (
          <Section
            title="Writing style"
            aside={
              report.style.measurable
                ? `${report.style.words} words`
                : `needs ${MIN_WORDS} words to measure`
            }
          >
            {report.style.measurable ? (
              <dl className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                {report.style.metrics.map((metric) => (
                  <div key={metric.id} className="flex items-baseline justify-between gap-4 py-2">
                    <dt
                      className={`text-sm ${
                        metric.triggered ? 'text-[var(--color-bone)]' : 'text-[var(--color-muted)]'
                      }`}
                    >
                      {metric.label}
                      <span className="block text-xs text-[var(--color-muted)]">
                        {metric.detail}
                      </span>
                    </dt>
                    <dd
                      className={`tnum font-mono text-sm ${
                        metric.triggered ? 'text-[var(--color-bone)]' : 'text-[var(--color-muted)]'
                      }`}
                    >
                      {Number.isNaN(metric.value) ? '—' : Math.round(metric.value * 100) / 100}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="py-2 text-sm text-[var(--color-muted)]">
                A rate measured over a short sample is arithmetic, not evidence — one em dash in
                twelve words is eighty-three per thousand. Nothing is reported below {MIN_WORDS}{' '}
                words.
              </p>
            )}
            {tells.length > 0 ? (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                {tells.length >= 3
                  ? `${tells.length} style tells co-occur. That is a pattern, not proof — every one of these is something a human writer does.`
                  : 'One style tell. Humans do this too; it is reported, never removed.'}
              </p>
            ) : undefined}
          </Section>
        ) : undefined}

        <Limits>
          <p>
            Statistical watermarks — the SynthID-Text family — live in word choice, not in
            characters. No deterministic edit removes them, so a clean report here does not mean
            unwatermarked text.
          </p>
        </Limits>
      </div>
    </div>
  )
}
