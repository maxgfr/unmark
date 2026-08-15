// oxlint-disable no-await-in-loop -- files are read one at a time so a dropped
// batch appears in the report as it goes, and one unreadable document does not
// take the rest of the batch down with it.
import { useCallback, useRef, useState } from 'react'
import { cleanContainer, type ContainerFormat } from '../core/container/index.ts'
import type { Finding } from '../core/report.ts'
import { FindingsTable, Limits, Section } from './parts.tsx'
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
}

const ACCEPTED = '.png,.jpg,.jpeg,.webp,.gif,.svg,.pdf,.docx,.odt,.html,.htm,.md,.txt'

const bytes = (count: number) =>
  count < 1024 ? `${count} B` : `${(count / 1024).toFixed(count < 1024 * 100 ? 1 : 0)} kB`

/** Prefix the download so the original is never silently overwritten. */
const cleanedName = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}-unmarked` : `${name.slice(0, dot)}-unmarked${name.slice(dot)}`
}

export function FilesTab() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const counter = useRef(0)

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
          <FindingsTable findings={[...entry.findings, ...entry.preserved]} />
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
