import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyFindings,
  encodeStego,
  inspectTextDocument,
  PLAIN,
  type TextOptions,
} from '../core/text/index.ts'
import { editsOf, type Row } from '../core/report.ts'
import { CopyButton, Section, Toggle } from './parts.tsx'
import { TextDetails } from './TextDetails.tsx'
import { MODEL_BYTES } from '../text-model/manifest.ts'

const EXAMPLE = `Quarterly results are attached.${encodeStego('recipient-4417', 'zero-width')} In order to proceed, read the report.`
const button =
  'rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm transition-colors hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40'
type CleaningMode = 'standard' | 'deep' | 'ultra'
type Result = { text: string; summary: string }
type Snapshot = { input: string; result: Result | undefined }

export function TextTab() {
  const [input, setInput] = useState('')
  const [result, setResult] = useState<Result>()
  const [history, setHistory] = useState<Snapshot[]>([])
  const [options, setOptions] = useState<TextOptions>({ ...PLAIN })
  const [mode, setMode] = useState<CleaningMode>('standard')
  const deep = mode !== 'standard'
  const activeOptions = mode === 'ultra' ? PLAIN : options
  const [supported, setSupported] = useState<boolean>()
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<number>()
  const field = useRef<HTMLTextAreaElement>(null)
  const active = useRef<AbortController | undefined>(undefined)
  const revision = useRef(0)
  const deferred = useDeferredValue(input)
  const settled = deferred === input
  const report = useMemo(
    () => inspectTextDocument(deferred, activeOptions),
    [deferred, activeOptions],
  )

  useEffect(
    () => () => {
      active.current?.abort()
    },
    [],
  )

  const invalidate = () => {
    revision.current += 1
    active.current?.abort()
    active.current = undefined
    setBusy(false)
    setResult(undefined)
    setStatus('')
    setSelected(undefined)
  }
  const remember = () => setHistory((items) => [...items, { input, result }])
  const changeInput = (text: string) => {
    invalidate()
    setInput(text)
    setHistory([])
  }
  const toggle = (name: keyof TextOptions, value: boolean) => {
    invalidate()
    setHistory([])
    setOptions((current) => ({ ...current, [name]: value }))
  }
  const chooseMode = (value: CleaningMode) => {
    invalidate()
    setHistory([])
    setMode(value)
    if (value !== 'standard') {
      void import('../text-model/client.ts').then(async ({ canDeepClean }) =>
        setSupported(await canDeepClean()),
      )
    }
  }
  const locate = (row: Row) => {
    if (!settled) return
    const item = row.folded?.[0] ?? row
    setSelected(item.offset)
    field.current?.focus()
    field.current?.setSelectionRange(item.offset, item.offset + item.length)
  }
  const apply = (row: Row) => {
    if (!settled || busy) return
    remember()
    invalidate()
    setInput(applyFindings(input, editsOf(row)))
  }
  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    invalidate()
    setInput(previous.input)
    setResult(previous.result)
    setHistory((items) => items.slice(0, -1))
  }
  const clean = async () => {
    if (!input || !settled || busy) return
    remember()
    const controller = new AbortController()
    active.current = controller
    const ownRevision = ++revision.current
    const { cleaned } = report
    const removed = cleaned.findings.filter((finding) => finding.replacement === '').length
    const replaced = cleaned.findings.length - removed
    const basic = {
      text: cleaned.output,
      summary:
        cleaned.output === input
          ? 'No changes needed for the selected options.'
          : `${removed} removed · ${replaced} replaced · ${cleaned.preserved.length} kept`,
    }
    setResult(basic)
    setStatus('')
    if (!deep || !basic.text.trim()) return
    if (supported === false) {
      setStatus('AI rewriting needs WebGPU. Basic cleaning is ready.')
      return
    }
    setBusy(true)
    setStatus('Loading the local model…')
    try {
      const { deepClean } = await import('../text-model/client.ts')
      const outcome = await deepClean(
        mode === 'ultra' ? input : basic.text,
        controller.signal,
        (message) => {
          if (revision.current === ownRevision) setStatus(message)
        },
        mode === 'ultra' ? 'ultra' : 'deep',
      )
      if (revision.current !== ownRevision || controller.signal.aborted) return
      if (outcome.kind === 'accepted') {
        setResult({
          text: outcome.text,
          summary:
            outcome.text === basic.text
              ? 'The model kept the text unchanged. Cleaned text is ready.'
              : mode === 'ultra'
                ? 'Ultra complete. Rewritten locally and cleaned again. Content checks passed; review the meaning before sharing.'
                : 'Rewritten locally. Content checks passed; review the meaning before sharing.',
        })
        setStatus('')
      } else {
        setStatus(`${outcome.notes.join(' ')} Basic cleaning is ready.`)
      }
    } catch (error) {
      if (revision.current === ownRevision && !controller.signal.aborted) {
        setStatus(
          `${error instanceof Error ? error.message : 'AI rewriting failed.'} Basic cleaning is ready.`,
        )
      }
    } finally {
      if (revision.current === ownRevision) {
        setBusy(false)
        active.current = undefined
      }
    }
  }
  const cancel = () => {
    revision.current += 1
    active.current?.abort()
    active.current = undefined
    setBusy(false)
    setStatus('AI rewriting cancelled. Basic cleaning is ready.')
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12 lg:[&>section]:border-t-0 lg:[&>section]:pt-0 lg:[&>section>header]:min-h-7">
        <Section
          title="Paste the text"
          aside={
            <div className="flex items-center gap-4">
              {history.length > 0 ? (
                <button
                  type="button"
                  onClick={undo}
                  className="py-1 hover:text-[var(--color-bone)]"
                >
                  Undo
                </button>
              ) : undefined}
              {input ? (
                <button
                  type="button"
                  onClick={() => {
                    remember()
                    invalidate()
                    setInput('')
                  }}
                  className="hover:text-[var(--color-bone)]"
                >
                  Clear
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => changeInput(EXAMPLE)}
                  className="hover:text-[var(--color-bone)]"
                >
                  Load a marked example
                </button>
              )}
            </div>
          }
        >
          <textarea
            ref={field}
            value={input}
            onChange={(event) => changeInput(event.target.value)}
            spellCheck={false}
            placeholder="Paste your text here. It stays on this device."
            aria-label="Text to inspect"
            className="h-64 w-full resize-y rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3 font-mono text-sm leading-relaxed text-[var(--color-bone)] outline-none placeholder:text-[var(--color-muted)] focus:border-[var(--color-rule-bright)]"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void clean()
              }}
              disabled={!input || !settled || busy}
              className="rounded-md bg-[var(--color-bone)] px-5 py-2.5 text-sm font-medium text-[var(--color-ground)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Cleaning…' : 'Clean text'}
            </button>
            {busy ? (
              <button type="button" onClick={cancel} className={button}>
                Cancel
              </button>
            ) : undefined}
          </div>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            {mode === 'ultra'
              ? 'Full cleanup, local AI rewrite and final checks. Your original stays above.'
              : deep
                ? 'Removes supported marks, then rewrites locally. Review the meaning before sharing.'
                : 'Removes supported marks with the selected options. Your original stays above.'}
          </p>
          <details className="mt-5 border-t border-[var(--color-rule)] pt-3">
            <summary className="cursor-pointer text-sm text-[var(--color-muted)]">
              <span>Advanced options</span>
              {deep ? (
                <span className="ml-2 text-xs text-[var(--color-bone)]">
                  {mode === 'ultra' ? 'Ultra on' : 'Deep clean on'}
                </span>
              ) : undefined}
            </summary>
            <div className="mt-3 flex flex-col gap-4">
              <div>
                <label className="flex flex-wrap items-center gap-3 text-sm">
                  <span>Cleaning mode</span>
                  <select
                    value={mode}
                    onChange={(event) => chooseMode(event.target.value as CleaningMode)}
                    className="min-h-10 max-w-full rounded-md border border-[var(--color-rule-bright)] bg-[var(--color-panel)] px-3 py-2 text-[var(--color-bone)]"
                    aria-describedby="cleaning-mode-help"
                  >
                    <option value="standard">Standard — clean text</option>
                    <option value="deep">Deep — add an AI rewrite</option>
                    <option value="ultra">Ultra — full cleanup and AI rewrite</option>
                  </select>
                </label>
                <p id="cleaning-mode-help" className="mt-2 text-xs text-[var(--color-muted)]">
                  {mode === 'ultra'
                    ? 'Automatically simplifies typography and wording, rewrites short passages with up to three attempts, then removes any reintroduced marks and checks the result. Review the meaning before sharing.'
                    : mode === 'deep'
                      ? 'Optional AI rewrite for short passages. Supported marks are removed even when this is off.'
                      : 'Removes supported marks using the settings below. No AI model needed.'}
                </p>
                {deep ? (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    {supported === false
                      ? 'WebGPU is unavailable in this browser. Clean text will use basic cleaning.'
                      : `Model files: ${(MODEL_BYTES / 1_000_000).toFixed(0)} MB, plus the local runtime. Download starts when you press Clean text; files are cached for reuse. Your text is never uploaded.`}
                  </p>
                ) : undefined}
              </div>
              {mode === 'ultra' ? (
                <p className="text-xs text-[var(--color-muted)]">
                  Cleanup preserves emoji and script joiners, multilingual letters and code.
                  Destructive options stay off. If rewriting fails, the cleaned text remains
                  available.
                </p>
              ) : (
                <>
                  <p className="text-xs text-[var(--color-muted)]">
                    Supported marks are always removed. Adjust the optional changes below.
                  </p>
                  <Toggle
                    checked={options.typography === true}
                    onChange={(value) => toggle('typography', value)}
                    hint="Simplify dashes, quotes and ellipses; preserve code."
                  >
                    Simplify typography
                  </Toggle>
                  <Toggle
                    checked={options.humanise === true}
                    onChange={(value) => toggle('humanise', value)}
                    hint="Shorten supported English filler phrases; preserve quotations."
                  >
                    Simplify wording
                  </Toggle>
                  <Toggle
                    checked={options.confusables === true}
                    onChange={(value) => toggle('confusables', value)}
                    hint="Converts Cyrillic and Greek lookalikes to Latin; can change multilingual text."
                  >
                    Normalise confusable letters
                  </Toggle>
                  <Toggle
                    checked={options.paranoid === true}
                    onChange={(value) => toggle('paranoid', value)}
                    hint="Also removes legitimate emoji and script joiners. Can damage text."
                  >
                    Paranoid mode
                  </Toggle>
                </>
              )}
              {deep ? (
                <button
                  type="button"
                  className={`${button} self-start`}
                  disabled={busy}
                  onClick={async () => {
                    const { releaseTextModel } = await import('../text-model/client.ts')
                    releaseTextModel()
                    setStatus('Model released from memory. Downloaded files remain cached.')
                  }}
                >
                  Release model memory
                </button>
              ) : undefined}
            </div>
          </details>
        </Section>
        <Section
          title="Cleaned text"
          aside={
            <CopyButton
              label="Copy cleaned text"
              value={result?.text ?? ''}
              disabled={busy || !settled || !result}
            />
          }
        >
          <output
            aria-label="Cleaned text"
            aria-busy={busy}
            className="block min-h-64 max-h-[36rem] w-full overflow-auto rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words"
          >
            {result ? (
              result.text
            ) : (
              <span className="text-[var(--color-muted)]">Press Clean text to see the result.</span>
            )}
          </output>
          <div aria-live="polite" className="mt-3 text-sm text-[var(--color-muted)]">
            {result ? (
              <p>
                {result.text === ''
                  ? 'All content was removed by the selected options.'
                  : result.summary}
              </p>
            ) : undefined}
            {status ? <p className="mt-2 break-words">{status}</p> : undefined}
          </div>
          <p className="mt-5 text-xs text-[var(--color-muted)]">
            SynthID / Claude watermarks are not verified. Cleaning or rewriting does not guarantee
            their removal.
          </p>
        </Section>
      </div>
      <TextDetails
        text={deferred}
        report={report}
        selected={selected}
        settled={settled && !busy}
        onLocate={locate}
        onApply={apply}
      />
    </div>
  )
}
