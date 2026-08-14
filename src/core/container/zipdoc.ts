// Office and OpenDocument files: metadata in named parts inside a zip.
//
// The parts are emptied rather than deleted. Word and LibreOffice both reach
// docProps/core.xml through a relationship declared in _rels/.rels, and a
// relationship pointing at a part that is no longer there is how you get "the
// file is corrupt and cannot be opened". Emptying keeps every relationship
// intact and still leaves nothing behind — the author's name, the company, the
// editing time and the revision count are all gone.

import type { Finding, Verdict } from '../report.ts'
import { decodeUtf8, encode, snippet, type ContainerResult } from './types.ts'
import { readZip, writeZip, zipDocumentKind, type ZipEntry } from './zip.ts'

const EMPTY_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`

const EMPTY_APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>`

const EMPTY_CUSTOM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>`

const EMPTY_ODF_META = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3"><office:meta/></office:document-meta>`

interface PartRule {
  replacement: string
  verdict: Verdict
  what: string
}

const PARTS: Record<string, PartRule> = {
  'docProps/core.xml': {
    replacement: EMPTY_CORE,
    verdict: 'informational',
    what: 'core document properties (author, last modified by, revision)',
  },
  'docProps/app.xml': {
    replacement: EMPTY_APP,
    verdict: 'informational',
    what: 'extended properties (application, company, editing time)',
  },
  'docProps/custom.xml': {
    replacement: EMPTY_CUSTOM,
    verdict: 'probable',
    what: 'custom properties',
  },
  'meta.xml': {
    replacement: EMPTY_ODF_META,
    verdict: 'informational',
    what: 'OpenDocument metadata (creator, generator, editing cycles)',
  },
}

// Values worth quoting back so the user sees what was actually in there.
const INTERESTING =
  /<(?:dc:creator|cp:lastModifiedBy|Application|Company|meta:generator|meta:initial-creator|dc:title)>([^<]+)</g

function describe(xml: string): string {
  const values = [...xml.matchAll(INTERESTING)].map((match) => match[1]).filter(Boolean)
  return snippet(values.join(' · '))
}

export function sniffZipDocument(entries: readonly ZipEntry[]): boolean {
  return zipDocumentKind(entries) !== undefined
}

export async function cleanZipDocument(bytes: Uint8Array): Promise<ContainerResult> {
  const entries = await readZip(bytes)
  const findings: Finding[] = []
  const rebuilt: ZipEntry[] = []

  for (const entry of entries) {
    const rule = PARTS[entry.name]

    // customXml parts are where add-ins and document-management systems park
    // per-document identifiers. Emptying the item keeps its relationship valid.
    const isCustomXml = /^customXml\/item\d*\.xml$/.test(entry.name)

    if (rule || isCustomXml) {
      const before = decodeUtf8(entry.data)
      const evidence = describe(before)
      findings.push({
        kind: 'doc_property',
        verdict: rule?.verdict ?? 'probable',
        offset: 0,
        length: entry.data.length,
        label: `${entry.name} — ${rule?.what ?? 'custom XML part'}`,
        ...(evidence ? { evidence } : {}),
      })
      rebuilt.push({
        name: entry.name,
        data: encode(rule?.replacement ?? '<root/>'),
        ...(entry.stored ? { stored: true } : {}),
      })
      continue
    }

    rebuilt.push(entry)
  }

  return { output: await writeZip(rebuilt), findings, preserved: [] }
}
