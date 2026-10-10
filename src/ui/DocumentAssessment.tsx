// The authorship assessment of a dropped file: a .docx, a PDF or a text file.
//
// What `unmark detect thesis.docx --pages thesis.pdf` does, in the tab. The
// prose is read from the file — the body of a .docx without its tables,
// captions, contents and reference list, or a PDF page by page — and every
// passage is placed by page and section. A printed PDF of the same document
// can be added to give a .docx its page numbers. The file's own marks, from
// the inspection above, are listed apart from the prose.
//
// Loaded lazily, when the reader opens it: the catalogues behind it are not
// what most dropped images need.

import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { printedPages, readProse, type Prose } from '../core/container/prose.ts'
import { fileMarksFrom, withoutFolio, type PageText } from '../core/text/authorship/index.ts'
import type { Finding } from '../core/report.ts'
import type { AssessedDocument } from './Authorship.tsx'

const Authorship = lazy(() => import('./Authorship.tsx'))

export default function DocumentAssessment({
  name,
  input,
  findings,
}: {
  name: string
  input: Uint8Array
  /** The inspection's findings, from which the file marks are taken. */
  findings: readonly Finding[]
}) {
  const [prose, setProse] = useState<Prose | undefined | null>(undefined)
  const [pages, setPages] = useState<{ name: string; pages: PageText[] } | undefined>()
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let live = true
    readProse(input, name).then(
      (read) => {
        if (live) setProse(read ?? null)
      },
      () => {
        if (live) setProse(null)
      },
    )
    return () => {
      live = false
    }
  }, [input, name])

  // Memoised: the assessment below recomputes whenever this object changes.
  const from = useMemo((): AssessedDocument | undefined => {
    if (!prose) return undefined
    const layout = pages
      ? { paragraphs: prose.layout?.paragraphs ?? [], pages: pages.pages }
      : prose.layout
    return {
      name,
      format: prose.format,
      ...(layout ? { layout } : {}),
      ...(prose.source
        ? { document: { ...prose.source, ...(pages ? { pagesFrom: pages.name } : {}) } }
        : {}),
      fileMarks: prose.source ? fileMarksFrom(findings) : [],
      sources: {
        [name]: { text: prose.raw ?? prose.text, loose: prose.source?.container === 'PDF' },
        ...(pages
          ? {
              [pages.name]: {
                text: pages.pages.map((page) => withoutFolio(page.text)).join('\n'),
                loose: true,
              },
            }
          : {}),
      },
    }
  }, [prose, pages, name, findings])

  if (prose === undefined)
    return <p className="text-xs text-[var(--color-muted)]">Reading the document…</p>
  if (prose === null || !from)
    return (
      <p className="text-xs text-[var(--color-muted)]">
        No prose to assess in this file. Text, Markdown, HTML, .docx and PDF are read.
      </p>
    )

  const choosePages = async (file: File | undefined) => {
    if (!file) return
    const read = await printedPages(new Uint8Array(await file.arrayBuffer()))
    if (!read) {
      setProblem(`${file.name} is not a PDF.`)
      return
    }
    setProblem('')
    setPages({ name: file.name, pages: read })
  }

  return (
    <div className="flex flex-col gap-4">
      {prose.source?.container === 'DOCX' ? (
        <label className="text-xs text-[var(--color-muted)]">
          Printed PDF of the same document, to place every passage on its page:{' '}
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => void choosePages(event.target.files?.[0])}
            className="text-xs"
          />
          {problem ? <span className="ml-2 text-[var(--color-signal)]">{problem}</span> : undefined}
        </label>
      ) : undefined}
      <Suspense fallback={<p className="text-xs text-[var(--color-muted)]">Reading the text…</p>}>
        <Authorship text={prose.text} from={from} />
      </Suspense>
    </div>
  )
}
