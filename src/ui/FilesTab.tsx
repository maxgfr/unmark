// oxlint-disable no-await-in-loop -- files are read one at a time so a dropped
// batch appears in the report as it goes, and one unreadable document does not
// take the rest of the batch down with it.
import { useCallback, useRef, useState } from 'react'
import { cleanContainer, type ContainerFormat } from '../core/container/index.ts'
import type { Finding } from '../core/report.ts'
import { FindingsTable, Limits, Section } from './parts.tsx'
import { decodeUtf8 } from '../core/container/types.ts'
import { IconDownload, IconTrash } from './icons.tsx'
import { saveBlob } from './download.ts'

interface Entry {
  id: string
  name: string
  format: ContainerFormat
  findings: Finding[]
  preserved: Finding[]
  before: number
  after: number
  output: Uint8Array
  /**
   * The bytes as they arrived, so a finding can be shown where it sits.
   *
   * Undefined above `KEEPABLE`: the cleaned output is already held for the
   * download, and holding a second copy of a large video to render sixty-four
   * bytes of it is a bad trade. The row says so rather than showing an empty
   * panel.
   */
  input: Uint8Array | undefined
  textual: boolean
}

/**
 * Below this, the original is kept so a finding can be looked at.
 *
 * Chosen against what the tab already costs rather than as a round number: the
 * output is retained for every file regardless, so this doubles the footprint
 * of anything under it and nothing above.
 */
const KEEPABLE = 32 * 1024 * 1024

/** How much of the file to show around a finding. */
const WINDOW = 64

const ACCEPTED = '.png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,.docx,.odt,.html,.htm,.md,.txt'

const bytes = (count: number) =>
  count < 1024 ? `${count} B` : `${(count / 1024).toFixed(count < 1024 * 100 ? 1 : 0)} kB`

/** Prefix the download so the original is never silently overwritten. */
const cleanedName = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}-unmarked` : `${name.slice(0, dot)}-unmarked${name.slice(dot)}`
}

/**
 * Sixty-four bytes of the file around a finding, as hex and as characters.
 *
 * The Files tab's answer to "show me where". There is no cursor to place —
 * these are bytes in a binary, not a paragraph someone is editing — so the
 * honest equivalent is the bytes themselves: a `tEXtSoftware\0Adobe…` is
 * legible at a glance and settles what the row's one-line label could only
 * assert.
 */
function Window({ entry, open }: { entry: Entry; open: string | undefined }) {
  if (!open?.startsWith(`${entry.id}:`)) return undefined
  const offset = Number(open.slice(entry.id.length + 1))

  if (!entry.input) {
    return (
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        {bytes(entry.before)} is too large to keep a second copy of in the tab, so there is nothing
        to show here. The report above is unaffected.
      </p>
    )
  }

  // The formats built on a zip all report offset 0 — the part is the location,
  // and it is already on the row. A window of the first sixty-four bytes of a
  // zip is the local file header, which tells the reader nothing.
  if (offset === 0) {
    return (
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        This one is named by the part it lives in rather than by a position in the file.
      </p>
    )
  }

  const start = Math.max(0, offset - WINDOW / 2)
  const slice = entry.input.subarray(start, Math.min(entry.input.length, start + WINDOW))

  // A textual container's offsets index its decoded characters, not its bytes,
  // so slicing the array would land in the middle of a multi-byte character.
  const text = entry.textual
    ? decodeUtf8(entry.input).slice(
        Math.max(0, offset - WINDOW / 2),
        Math.max(0, offset - WINDOW / 2) + WINDOW,
      )
    : undefined

  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)] p-3">
      <p className="tnum mb-2 font-mono text-[10px] tracking-wide text-[var(--color-muted)] uppercase">
        {entry.textual ? 'characters' : 'bytes'} {start}–{start + (text?.length ?? slice.length)}
      </p>
      {text === undefined ? (
        <p className="tnum font-mono text-xs whitespace-pre text-[var(--color-bone)]">
          {[...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}
          {'\n'}
          {[...slice]
            .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
            .join('  ')}
        </p>
      ) : (
        <p className="font-mono text-xs break-all whitespace-pre-wrap text-[var(--color-bone)]">
          {text}
        </p>
      )}
    </div>
  )
}

export function FilesTab() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  /**
   * Which finding is open, as `entry id` and offset.
   *
   * Keyed by both because two dropped files can hold a finding at the same
   * offset, and opening one would otherwise open the other as well.
   */
  const [open, setOpen] = useState<string | undefined>(undefined)

  const accept = useCallback(async (files: readonly File[]) => {
    setError('')
    // One file at a time: a dropped batch appears in the report as it is read,
    // and a DOCX that fails to parse does not take the rest of the batch with it.
    for (const file of files) {
      try {
        const input = new Uint8Array(await file.arrayBuffer())
        const result = await cleanContainer(input, file.name)
        counter.current += 1
        setEntries((current) => [
          {
            id: `${file.name}-${counter.current}`,
            name: file.name,
            format: result.format,
            findings: result.findings,
            preserved: result.preserved,
            before: input.length,
            after: result.output.length,
            output: result.output,
            input: input.length <= KEEPABLE ? input : undefined,
            textual: result.textual,
          },
          ...current,
        ])
      } catch (cause) {
        setError(
          `${file.name} could not be read: ${cause instanceof Error ? cause.message : 'unknown error'}`,
        )
      }
    }
  }, [])

  // A Blob URL, revoked on the next task: the file never leaves the tab, and
  // holding the URL open would pin the whole buffer in memory. Revoking it in
  // the same task as the click is what broke this outside Chromium — see
  // ui/download.ts.
  const download = useCallback((entry: Entry) => {
    saveBlob(new Blob([entry.output as BlobPart]), cleanedName(entry.name))
  }, [])

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Drop files"
        aside={entries.length > 0 ? `${entries.length} inspected` : undefined}
      >
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void accept([...event.dataTransfer.files])
          }}
          className={`rounded-md border border-dashed p-10 text-center transition-colors duration-150 ${
            dragging
              ? 'border-[var(--color-signal)] bg-[var(--color-panel)]'
              : 'border-[var(--color-rule-bright)]'
          }`}
        >
          <p className="text-sm text-[var(--color-bone)]">
            Drop an image or a document here, or{' '}
            <button
              type="button"
              onClick={() => picker.current?.click()}
              className="text-[var(--color-signal)] underline decoration-[var(--color-signal-dim)] underline-offset-4 transition-colors duration-150 hover:decoration-[var(--color-signal)]"
            >
              choose one
            </button>
            .
          </p>
          <p className="mt-2 font-mono text-xs text-[var(--color-muted)]">
            PNG · JPEG · WebP · GIF · SVG · PDF · DOCX · ODT · HTML · Markdown · text
          </p>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Read in this tab with the File API. Nothing is uploaded.
          </p>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPTED}
            onChange={(event) => {
              void accept([...(event.target.files ?? [])])
              event.target.value = ''
            }}
            className="sr-only"
          />
        </div>

        {error ? (
          <p role="alert" className="mt-3 font-mono text-xs text-[var(--color-signal)]">
            {error}
          </p>
        ) : undefined}
      </Section>

      {entries.map((entry) => (
        <Section
          key={entry.id}
          title={entry.name}
          aside={
            <span className="flex items-center gap-3">
              <span className="tnum font-mono">
                {entry.format} · {bytes(entry.before)} → {bytes(entry.after)}
              </span>
              <button
                type="button"
                onClick={() => download(entry)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)]"
              >
                <IconDownload />
                Download cleaned
              </button>
              <button
                type="button"
                aria-label={`Remove ${entry.name}`}
                onClick={() => setEntries((current) => current.filter((e) => e.id !== entry.id))}
                className="rounded-md border border-transparent p-1 text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-bone)]"
              >
                <IconTrash />
              </button>
            </span>
          }
        >
          <FindingsTable
            findings={[...entry.findings, ...entry.preserved]}
            onLocate={(row) => {
              const key = `${entry.id}:${row.offset}`
              setOpen((current) => (current === key ? undefined : key))
            }}
          />
          {/* Under the table rather than inside a row: the window is sixty-four
              bytes wide and a row is one line tall, and threading it through the
              shared table would put a file-shaped concern into the component the
              text tab uses too. */}
          <Window entry={entry} open={open} />
        </Section>
      ))}

      <Limits>
        <p>
          Metadata is what lives beside the content: EXIF, XMP, C2PA manifests, document properties.
          Removing it does not touch a watermark drawn into the pixels — that is the Image tab — and
          it cannot reach metadata inside a PDF's compressed object streams, which unmark reports
          rather than passing over in silence.
        </p>
      </Limits>
    </div>
  )
}
