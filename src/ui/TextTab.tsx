import { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import {
  applyFindings,
  distinctSignals,
  encodeStego,
  inspectTextDocument,
  MIN_WORDS,
  PLAIN,
  type StyleLayer,
} from '../core/text/index.ts'
import { CopyButton, FindingsTable, Limits, Section, Toggle } from './parts.tsx'
import { editsOf, summariseOutcomes, type Row } from '../core/report.ts'
import { SourceView } from './SourceView.tsx'

const LAYER_NOTE: Record<StyleLayer, string> = {
  phrase: 'vocabulary — the cheapest tell to spot and the cheapest to edit away',
  structure: 'rhythm and shape — dashes, sentence lengths, how paragraphs open',
  silhouette: 'the arrangement of ideas — what survives a word-level rewrite',
}

const EXAMPLE = `Quarterly results are attached. Please keep this internal.${encodeStego(
  'recipient-4417',
  'zero-width',
)}`

export function TextTab() {
  const [input, setInput] = useState('')
  /** Where the reader last asked to look, as an offset into `input`. */
  const [selected, setSelected] = useState<number | undefined>(undefined)
  /**
   * Every state of the text before an Apply, most recent last.
   *
   * Applying edits the reader's own paragraph, and this tool does not change
   * text without offering the way back. A full stack rather than one step,
   * because applying three findings in a row is the normal way to use it and a
   * single undo would strand the first two.
   */
  const [history, setHistory] = useState<string[]>([])
  const field = useRef<HTMLTextAreaElement>(null)
  const [paranoid, setParanoid] = useState(false)
  const [confusables, setConfusables] = useState(false)
  const [typography, setTypography] = useState(false)
  const [humaniseText, setHumanise] = useState(false)

  // The report lags the keystroke rather than the textarea: typing must never
  // wait on a full re-scan of a long document.
  const deferred = useDeferredValue(input)

  // One function, shared with the CLI, and one call. This used to be assembled
  // inline here and again in core/text/index.ts, which is two implementations
  // of one report and exactly the kind of pair that drifts apart without anyone
  // noticing. The cleaned document comes back on the report for the same
  // reason: asking for it separately meant running the strip pass twice.
  const report = useMemo(() => {
    const options = {
      ...(paranoid ? { paranoid } : {}),
      ...(confusables ? { confusables } : {}),
      ...(typography ? { typography } : {}),
      ...(humaniseText ? { humanise: humaniseText } : {}),
    }
    return inspectTextDocument(deferred, options)
  }, [deferred, paranoid, confusables, typography, humaniseText])

  /**
   * Whether the report on screen describes the text on screen.
   *
   * `useDeferredValue` is what keeps typing responsive, and it does it by
   * letting the report lag: for a render or two, `report` addresses `deferred`
   * while the textarea holds `input`. Every offset in it is measured against a
   * string that is no longer there.
   *
   * That was invisible while the report was a column of numbers and became a
   * defect the moment an offset had to act. Locate put the cursor on a span
   * computed for the previous text; Apply spliced at it. Measured on a 200 kB
   * article the window is over a second, and one Apply during it deletes a
   * character 33 positions from the em dash the reader pressed the button on —
   * silently, in the middle of their document, with Undo restoring the state
   * before the *second* apply rather than before the damage.
   *
   * So the two actions are withheld until the report has caught up. It is a
   * render or two on anything short, and on the documents where it is longer it
   * is exactly the case that used to corrupt them.
   */
  const settled = deferred === input

  const removed = report.cleaned.findings.length
  const shorterBy = deferred.length - report.cleaned.output.length
  const lengthChange =
    shorterBy === 0
      ? 'same length'
      : shorterBy > 0
        ? `${shorterBy} characters shorter`
        : `${-shorterBy} characters longer`
  const tells = report.style.metrics.filter((metric) => metric.triggered)
  const signals = distinctSignals(report.style.metrics)
  const plain = typography && humaniseText

  // Everything with a place in the document. `preserved` belongs in it — an
  // emoji joiner that was kept is exactly the kind of thing a reader wants to
  // go and look at — and `inspectTextDocument` already folded it in, so adding
  // it again here put every one of those findings in the list twice. The
  // duplicates were invisible, because the viewer drops a candidate that
  // overlaps one it has already claimed and a finding overlaps itself
  // perfectly; they still shifted every index after the first of them.
  const located = useMemo(
    () =>
      report.findings
        .filter((finding) => finding.scope !== 'document' && finding.length > 0)
        .sort((a, b) => a.offset - b.offset),
    [report],
  )

  const locate = useCallback((row: Row) => {
    // A folded row goes to its first member, never to its own span. That span
    // is a hull: findings are folded by what they are, not by sitting next to
    // each other, so selecting it on a document with thirty scattered em dashes
    // would select everything between the first and the last.
    const target = row.folded?.[0] ?? row
    setSelected(target.offset)

    // The literal request: put the cursor there. A textarea holds a selection
    // while unfocused but does not show one, so the focus has to come first.
    const area = field.current
    if (!area) return
    area.focus()
    area.setSelectionRange(target.offset, target.offset + target.length)
  }, [])

  const apply = useCallback(
    (row: Row) => {
      const edits = editsOf(row)
      if (edits.length === 0) return
      setHistory((current) => [...current, input])
      setInput(applyFindings(input, edits))
      // The report is rebuilt from the new text, so every other offset has
      // moved. Keeping the selection would point it at whatever now sits there.
      setSelected(undefined)
    },
    [input],
  )

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.at(-1)
      if (previous !== undefined) setInput(previous)
      return current.slice(0, -1)
    })
    setSelected(undefined)
  }, [])

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
      {/* Input first when stacked. Putting the report first buried the textarea
          under an empty findings panel on a first visit. */}
      <div className="flex flex-col gap-6">
        <Section
          title="Paste the text"
          aside={
            <span className="flex items-center gap-3">
              {history.length > 0 ? (
                <button
                  type="button"
                  onClick={undo}
                  className="transition-colors duration-150 hover:text-[var(--color-bone)]"
                >
                  Undo
                </button>
              ) : undefined}
              {input.length > 0 ? (
                <button
                  type="button"
                  // Through the history, like every other thing that changes
                  // the text. This called setInput('') directly, so a misclick
                  // on a pasted five-thousand-word document destroyed it with
                  // no way back — and the Undo button beside it was not even
                  // rendered, because nothing had been pushed.
                  onClick={() => {
                    setHistory((current) => [...current, input])
                    setInput('')
                    setSelected(undefined)
                  }}
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
              )}
            </span>
          }
        >
          <textarea
            ref={field}
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setSelected(undefined)
            }}
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

            {/* The two style passes. Separated by a rule and a caption because
                they are a different kind of operation: they change how the
                prose reads, and neither removes a mark. */}
            <div className="mt-2 border-t border-[var(--color-rule)] pt-3">
              <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                {/* `flex-1` with a floor, so the button sits beside the caption
                    on a wide column and drops below it on a narrow one rather
                    than stranding itself on a line of its own. */}
                <p className="min-w-[24ch] flex-1 text-xs text-[var(--color-muted)]">
                  Below this line: style, not marks. Neither removes a watermark — they change how
                  the writing reads.
                </p>
                {/* Both toggles at once. The pair is named `PLAIN` in the core
                    so this button and the CLI's --plain cannot drift into two
                    different presets. */}
                <button
                  type="button"
                  onClick={() => {
                    const next = !plain
                    setTypography(next && PLAIN.typography === true)
                    setHumanise(next && PLAIN.humanise === true)
                  }}
                  aria-pressed={plain}
                  className={`shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors duration-150 ${
                    plain
                      ? 'border-[var(--color-signal)] text-[var(--color-signal)]'
                      : 'border-[var(--color-rule)] text-[var(--color-bone)] hover:border-[var(--color-rule-bright)]'
                  }`}
                >
                  {plain ? 'Plain: on' : 'Make it plain'}
                </button>
              </div>
              <div className="flex flex-col gap-2.5">
                <Toggle
                  checked={typography}
                  onChange={setTypography}
                  hint="Em and en dashes, curly quotes, ellipses → ASCII. French guillemets are left alone."
                >
                  Flatten typography
                </Toggle>
                <Toggle
                  checked={humaniseText}
                  onChange={setHumanise}
                  hint="Filler phrases, stacked hedges, chat pleasantries, signposting, decorative emoji. Only phrases with one unambiguous shorter form."
                >
                  Remove generated-prose boilerplate
                </Toggle>
              </div>
            </div>
          </div>
        </Section>

        {/* Only once there is something to mark. An empty panel on a first
            visit is the mistake DESIGN.md records under Structure — the report
            went above the textarea and buried it. */}
        {located.length > 0 ? (
          // The aside is a hint, not a count. Touching carriers are drawn as one
          // chip, so `113 marked` beside a panel showing one box would ask the
          // reader to reconcile two numbers that are both right.
          <Section title="Source" aside="click a mark to put the cursor on it">
            {/* `deferred`, not `input`: the findings address that string, and
                drawing them over a newer one puts every chip beside the
                character it names. */}
            <SourceView text={deferred} findings={located} selected={selected} onSelect={locate} />
          </Section>
        ) : undefined}

        <Section title="Cleaned text" aside={<CopyButton value={report.cleaned.output} />}>
          <output className="block h-40 w-full overflow-auto rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap">
            {report.cleaned.output || (
              <span className="text-[var(--color-muted)]">Nothing to clean yet.</span>
            )}
          </output>
          {input.length > 0 ? (
            <p className="tnum mt-2 font-mono text-xs text-[var(--color-muted)]">
              {/* Both figures from the same string. This measured the length
                  against `input` and the output against `deferred`, so mid-type
                  it reported a difference neither pass had made — and it read
                  "shorter" unconditionally, so flattening an ellipsis to three
                  dots printed "-2 characters shorter". */}
              {removed} removed · {report.cleaned.preserved.length} kept · {lengthChange}
            </p>
          ) : undefined}
        </Section>
      </div>

      <div className="flex flex-col gap-6">
        {report.stego.length > 0 ? (
          <Section title="Recovered payload" aside="what the invisible characters spell">
            {/* The payload is part of the key, and it has to be: a zero-width
                run is decoded once per permutation of its alphabet, so ten
                readings of the same eight carriers share a scheme and an
                offset. Keyed on those two alone, React saw one child ten times
                and reconciliation across a keystroke was undefined — the panel
                could go on showing a payload from the previous document. */}
            {report.stego.map((decoding) => (
              <div
                key={`${decoding.scheme}-${decoding.offset}-${decoding.payload}`}
                className="mb-3 last:mb-0"
              >
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
          aside={input.length > 0 ? summariseOutcomes(report.findings) : undefined}
        >
          {input.length === 0 ? (
            <p className="py-2 text-sm text-[var(--color-muted)]">
              Paste something to inspect it. Everything runs in this tab.
            </p>
          ) : (
            <FindingsTable
              findings={report.findings}
              selectedOffset={selected}
              {...(settled ? { onLocate: locate, onApply: apply } : {})}
            />
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
              /* Grouped by layer, because which kind of tell fired is more use
                 than how many did. Vocabulary is a find-and-replace away;
                 silhouette is what survives one. */
              (['phrase', 'structure', 'silhouette'] as const).map((layer) => {
                const rows = report.style.metrics.filter((metric) => metric.layer === layer)
                if (rows.length === 0) return undefined
                return (
                  <section key={layer} className="mt-4 first:mt-0">
                    <h3 className="text-xs tracking-wide text-[var(--color-muted)] uppercase">
                      {layer}
                    </h3>
                    <p className="mt-0.5 mb-1.5 text-xs text-[var(--color-muted)]">
                      {LAYER_NOTE[layer]}
                    </p>
                    <dl className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                      {rows.map((metric) => (
                        <div
                          key={metric.id}
                          className="flex items-baseline justify-between gap-4 py-2"
                        >
                          <dt
                            className={`text-sm ${
                              metric.triggered
                                ? 'text-[var(--color-bone)]'
                                : 'text-[var(--color-muted)]'
                            }`}
                          >
                            {metric.label}
                            <span className="block text-xs text-[var(--color-muted)]">
                              {metric.detail}
                            </span>
                          </dt>
                          <dd
                            className={`tnum font-mono text-sm ${
                              metric.triggered
                                ? 'text-[var(--color-bone)]'
                                : 'text-[var(--color-muted)]'
                            }`}
                          >
                            {Number.isNaN(metric.value)
                              ? '—'
                              : Math.round(metric.value * 100) / 100}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )
              })
            ) : (
              <p className="py-2 text-sm text-[var(--color-muted)]">
                A rate measured over a short sample is arithmetic, not evidence — one em dash in
                twelve words is eighty-three per thousand. Nothing is reported below {MIN_WORDS}{' '}
                words.
              </p>
            )}
            {tells.length > 0 ? (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                {signals >= 3
                  ? `${signals} independent style tells co-occur. That is a pattern, not proof — every one of these is something a human writer does.`
                  : `${signals === 1 ? 'One style tell' : `${signals} style tells`}. Humans do this too; reported, never removed.`}
              </p>
            ) : undefined}

            {/* What a plain pass leaves behind. The difference between this and
                every tool that returns a score: naming the part it cannot do. */}
            {plain && tells.length > 0 ? (
              <p className="mt-2 text-xs text-[var(--color-bone)]">
                The plain pass does not touch these. {tells.map((t) => t.label).join(', ')} need the
                sentences rewritten, which takes a writer — from a terminal,{' '}
                <code className="font-mono">unmark rewrite</code> runs that loop and checks the
                result.
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
          <p className="mt-2">
            Rewriting the prose reduces that signal without removing it, and it needs a model. That
            does not happen here: this page has no way to reach one, by design.{' '}
            <code className="font-mono">unmark rewrite</code> in a terminal runs the loop, against a
            model on your own machine unless you ask for another.
          </p>
        </Limits>
      </div>
    </div>
  )
}
