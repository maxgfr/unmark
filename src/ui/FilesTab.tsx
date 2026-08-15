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
import { cleanedName, formatBytes } from './format.ts'

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

/** Which row's byte window is open, and what kind of location it has. */
interface Opened {
  id: string
  offset: number
  /** Set when the finding names a part rather than a position. */
  where?: string
}

/**
 * What the file picker will let you choose.
 *
 * Every format `cleanContainer` handles, which is not what this was: it listed
 * thirteen extensions and left out HEIC, AVIF, MP4/MOV, PPTX, XLSX and EPUB —
 * six the engine fully supports, and the six the README goes into most detail
 * about. A MOV's `©xyz` location atom and the iPhone `keys` table, a
 * presentation's `docProps/thumbnail.jpeg`: all reachable, none openable
 * through the button. Drag-and-drop worked, because the drop handler never
 * consults this, so the capability existed by an undiscoverable path while the
 * masthead advertised seventeen formats.
 */
const ACCEPTED = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.avif',
  '.mp4',
  '.m4v',
  '.mov',
  '.svg',
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.odt',
  '.epub',
  '.html',
  '.htm',
  '.md',
  '.markdown',
  '.txt',
].join(',')

// Both of these used to live here, privately. The Image tab needs them too,
// and a second copy that formats megabytes differently is how two panels come
// to disagree about the size of the same file.
const bytes = formatBytes

/**
 * Sixty-four bytes of the file around a finding, as hex and as characters.
 *
 * The Files tab's answer to "show me where". There is no cursor to place —
 * these are bytes in a binary, not a paragraph someone is editing — so the
 * honest equivalent is the bytes themselves: a `tEXtSoftware\0Adobe…` is
 * legible at a glance and settles what the row's one-line label could only
 * assert.
 */
function Window({ entry, open }: { entry: Entry; open: Opened | undefined }) {
  if (open?.id !== entry.id) return undefined
  const { offset } = open

  if (!entry.input) {
    return (
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        {bytes(entry.before)} is too large to keep a second copy of in the tab, so there is nothing
        to show here. The report above is unaffected.
      </p>
    )
  }

  // The formats built on a zip name the part they live in and report offset 0,
  // because a byte offset into a zip means nothing on its own — the sixty-four
  // bytes there are the local file header, which tells the reader nothing.
  //
  // `where` is what says so. This used to test `offset === 0` as a stand-in for
  // it, which is true of every zip-part finding and also of a `.txt` whose
  // first character is a zero-width space, or an `.html` opening on a generator
  // comment. Clicking those — the most legible case there is, a mark at the
  // very start — answered with a sentence about ZIP archives.
  if (open.where !== undefined) {
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
  /**
   * One line per file that could not be read, not one line per batch.
   *
   * Isolation worked — the loop carries on, which is what the header promises —
   * and the reporting did not: `setError` held a single string, so dropping
   * twenty files where the third and the eleventh failed showed the eleventh's
   * message and eighteen rows, with no way to tell which two were missing
   * except counting rows against the folder.
   */
  const [errors, setErrors] = useState<string[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  /**
   * Which finding is open.
   *
   * The entry id is part of it because two dropped files can hold a finding at
   * the same offset, and opening one would otherwise open the other as well.
   * `where` travels with it because it is what distinguishes "this lives in a
   * zip part" from "this is at byte 0", which are not the same thing.
   */
  const [open, setOpen] = useState<Opened | undefined>(undefined)

  const accept = useCallback(async (files: readonly File[]) => {
    setErrors([])
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
        const why = cause instanceof Error ? cause.message : 'unknown error'
        setErrors((current) => [...current, `${file.name} could not be read: ${why}`])
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
            PNG · JPEG · WebP · GIF · HEIC · AVIF · MP4/MOV · SVG · PDF · DOCX · PPTX · XLSX · ODT ·
            EPUB · HTML · Markdown · text
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

        {errors.length > 0 ? (
          <ul role="alert" className="mt-3 font-mono text-xs text-[var(--color-signal)]">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
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
              setOpen((current) =>
                current?.id === entry.id && current.offset === row.offset
                  ? undefined
                  : {
                      id: entry.id,
                      offset: row.offset,
                      ...(row.where ? { where: row.where } : {}),
                    },
              )
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
