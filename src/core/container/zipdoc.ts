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

/**
 * Empty every element's text while leaving the document's shape alone.
 *
 * For parts under docProps/ that are not in the table above. Real writers add
 * their own: Apple's puts a `docProps/meta.xml` carrying
 * `<generator>CocoaOOXMLWriter/…</generator>`, which a fixed list of part names
 * walks straight past — a gap that only turned up on a document produced by an
 * actual word processor rather than by a test.
 *
 * Emptying rather than replacing, because there is no way to know what schema
 * an unknown part follows, and a consumer that expects its own root element
 * should still find it.
 */
const emptyElements = (xml: string): string =>
  xml.replaceAll(/>([^<>]+)</g, (match, text) => (/^\s*$/.test(text as string) ? match : '><'))

/**
 * Attributes that name a person or a moment, wherever they appear.
 *
 * Identity in an OOXML package is not confined to docProps. It is stamped on
 * every tracked insertion and deletion (`w:author`, `w:date`), on every comment,
 * and on `word/people.xml`, which lists everyone who has ever edited the file.
 * Accepting all changes in Word does not remove any of it.
 */
// The namespace prefix is matched generically. Listing them by hand produced
// `(?:w14?|w15|…)`, which means "w1 followed by an optional 4" and therefore
// never matched plain `w:author` — the single most common case in the format.
// The code read correctly and did nothing at all.
const IDENTITY_ATTRIBUTE =
  /\s(?:[A-Za-z]\w{0,5}:)?(?:author|initials|lastModifiedBy|userId|providerId|date|dateUtc)="[^"]*"/g

const anonymiseAttributes = (xml: string): string =>
  xml.replaceAll(IDENTITY_ATTRIBUTE, (match) => `${match.split('=')[0]}=""`)

/**
 * Revision save identifiers.
 *
 * A fingerprint of the editing sessions a document went through, which links
 * separate documents back to the same machine. Optional in the format, so the
 * whole block goes.
 */
const stripRsids = (xml: string): string =>
  xml.replaceAll(/<w:rsids>[\s\S]*?<\/w:rsids>/g, '').replaceAll(/\sw:rsid[A-Za-z]*="[^"]*"/g, '')

/** A 1×1 white JPEG, to stand in for a document preview without leaking one. */
const BLANK_THUMBNAIL = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0xff, 0xff, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01,
  0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
])

export async function cleanZipDocument(bytes: Uint8Array): Promise<ContainerResult> {
  const entries = await readZip(bytes)
  const findings: Finding[] = []
  const rebuilt: ZipEntry[] = []

  for (const entry of entries) {
    const rule = PARTS[entry.name]

    // customXml parts are where add-ins and document-management systems park
    // per-document identifiers. Emptying the item keeps its relationship valid.
    const isCustomXml = /^customXml\/item\d*\.xml$/.test(entry.name)
    // Anything else under docProps/ is document properties by definition, even
    // when a particular writer invented the part name.
    const isOtherProperty = /^docProps\/.+\.xml$/.test(entry.name)

    if (rule || isCustomXml || isOtherProperty) {
      const before = decodeUtf8(entry.data)
      const evidence = describe(before) || snippet(before.replaceAll(/<[^>]*>/g, ' '))

      findings.push({
        kind: 'doc_property',
        verdict: rule?.verdict ?? 'probable',
        offset: 0,
        length: entry.data.length,
        label: `${entry.name} — ${rule?.what ?? (isCustomXml ? 'custom XML part' : 'writer-specific properties')}`,
        ...(evidence ? { evidence } : {}),
      })

      const replacement = rule ? rule.replacement : isCustomXml ? '<root/>' : emptyElements(before)

      rebuilt.push({
        name: entry.name,
        data: encode(replacement),
        ...(entry.stored ? { stored: true } : {}),
      })
      continue
    }

    // A rendered preview of the document, which survives every text-level
    // clean and shows the first page to anyone who looks in the zip. Replaced
    // rather than deleted: _rels/.rels points at it.
    if (entry.name.startsWith('docProps/thumbnail.')) {
      findings.push({
        kind: 'doc_property',
        verdict: 'confirmed',
        offset: 0,
        length: entry.data.length,
        label: `${entry.name} — an image of the document's first page`,
        evidence: `${entry.data.length} bytes, replaced with a blank 1×1`,
      })
      rebuilt.push({ name: entry.name, data: BLANK_THUMBNAIL })
      continue
    }

    // Identity is stamped throughout the package, not only in docProps: on
    // every tracked change, every comment, and word/people.xml. The content is
    // left alone — only the names, ids and timestamps are cleared.
    if (entry.name.endsWith('.xml')) {
      const before = decodeUtf8(entry.data)
      const after = stripRsids(anonymiseAttributes(before))
      if (after !== before) {
        const names = [...before.matchAll(/(?:author|lastModifiedBy|userId)="([^"]+)"/g)]
          .map((match) => match[1])
          .filter(Boolean)

        findings.push({
          kind: 'doc_property',
          verdict: 'probable',
          offset: 0,
          length: entry.data.length,
          label: `${entry.name} — author names, timestamps and revision ids`,
          evidence: snippet([...new Set(names)].join(' · ')) || 'revision save identifiers',
        })
        rebuilt.push({
          name: entry.name,
          data: encode(after),
          ...(entry.stored ? { stored: true } : {}),
        })
        continue
      }
    }

    rebuilt.push(entry)
  }

  return { output: await writeZip(rebuilt), findings, preserved: [] }
}
