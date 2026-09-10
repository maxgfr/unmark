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
import { cleanPng, sniffPng } from './png.ts'
import { cleanJpeg, sniffJpeg } from './jpeg.ts'
import { cleanWebp, sniffWebp } from './webp.ts'
import { cleanGif, sniffGif } from './gif.ts'

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
const IDENTITY_NAMES = new Set([
  'author',
  'initials',
  'lastModifiedBy',
  'userId',
  'providerId',
  'date',
  'dateUtc',
])

const XML_NAME_START = /[A-Za-z_:]/
const XML_NAME_CHAR = /[A-Za-z0-9_.:-]/

function isIdentityAttribute(name: string): boolean {
  const localName = name.slice(name.lastIndexOf(':') + 1)
  return IDENTITY_NAMES.has(localName)
}

/** Revision save identifiers fingerprint the editing sessions a document went through. */
function isRevisionAttribute(name: string): boolean {
  const localName = name.slice(name.lastIndexOf(':') + 1)
  return /^rsid[A-Za-z]*$/.test(localName)
}

function findTagEnd(xml: string, start: number): number {
  let quote: string | undefined
  for (let index = start + 1; index < xml.length; index += 1) {
    const char = xml[index]
    if (quote) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

function findDeclarationEnd(xml: string, start: number): number {
  let quote: string | undefined
  let subsetDepth = 0
  for (let index = start + 1; index < xml.length; index += 1) {
    const char = xml[index]
    if (quote) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '[') {
      subsetDepth += 1
    } else if (char === ']') {
      subsetDepth = Math.max(0, subsetDepth - 1)
    } else if (char === '>' && subsetDepth === 0) {
      return index
    }
  }
  return -1
}

function findElementEnd(xml: string, name: string, contentStart: number): number {
  let depth = 1
  let cursor = contentStart
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor)
    if (start < 0) return -1
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4)
      cursor = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9)
      cursor = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2)
      cursor = end < 0 ? xml.length : end + 2
      continue
    }
    if (xml[start + 1] === '!') {
      const end = findDeclarationEnd(xml, start)
      cursor = end < 0 ? xml.length : end + 1
      continue
    }
    const end = findTagEnd(xml, start)
    if (end < 0) return -1
    const tag = xml.slice(start, end + 1)
    const tagName = tag.startsWith('</')
      ? /^<\/\s*([^\s>]+)/.exec(tag)?.[1]
      : /^<([^\s/>]+)/.exec(tag)?.[1]
    if (tagName === name) {
      if (tag.startsWith('</')) depth -= 1
      else if (!/\/\s*>$/.test(tag)) depth += 1
      if (depth === 0) return end + 1
    }
    cursor = end + 1
  }
  return -1
}

function rewriteStartTag(tag: string): { output: string; names: string[] } {
  const replacements: Array<{ start: number; end: number }> = []
  const names: string[] = []
  let index = 1

  while (index < tag.length - 1) {
    const attributeStart = index
    while (/\s/.test(tag[index] ?? '')) index += 1
    if (index >= tag.length - 1 || tag[index] === '/') break

    const nameStart = index
    while (index < tag.length - 1 && XML_NAME_CHAR.test(tag[index] ?? '')) index += 1
    if (index === nameStart) {
      index += 1
      continue
    }
    const name = tag.slice(nameStart, index)
    while (/\s/.test(tag[index] ?? '')) index += 1
    if (tag[index] !== '=') continue
    index += 1
    while (/\s/.test(tag[index] ?? '')) index += 1

    const quote = tag[index]
    if (quote !== '"' && quote !== "'") continue
    const valueStart = index + 1
    const valueEnd = tag.indexOf(quote, valueStart)
    if (valueEnd < 0) break
    if (isRevisionAttribute(name)) {
      replacements.push({ start: attributeStart, end: valueEnd + 1 })
    } else if (isIdentityAttribute(name)) {
      replacements.push({ start: valueStart, end: valueEnd })
      const localName = name.slice(name.lastIndexOf(':') + 1)
      if (localName === 'author' || localName === 'lastModifiedBy' || localName === 'userId') {
        const value = tag.slice(valueStart, valueEnd)
        if (value) names.push(value)
      }
    }
    index = valueEnd + 1
  }

  if (replacements.length === 0) return { output: tag, names }
  let output = ''
  let cursor = 0
  for (const replacement of replacements) {
    output += tag.slice(cursor, replacement.start)
    cursor = replacement.end
  }
  output += tag.slice(cursor)
  return { output, names }
}

function anonymiseAttributes(xml: string): { output: string; names: string[] } {
  let output = ''
  let cursor = 0
  const names: string[] = []

  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor)
    if (start < 0) {
      output += xml.slice(cursor)
      break
    }
    output += xml.slice(cursor, start)
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4)
      const stop = end < 0 ? xml.length : end + 3
      output += xml.slice(start, stop)
      cursor = stop
      continue
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9)
      const stop = end < 0 ? xml.length : end + 3
      output += xml.slice(start, stop)
      cursor = stop
      continue
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2)
      const stop = end < 0 ? xml.length : end + 2
      output += xml.slice(start, stop)
      cursor = stop
      continue
    }
    const next = xml[start + 1]
    if (next === '!') {
      const end = findDeclarationEnd(xml, start)
      if (end < 0) {
        output += xml.slice(start)
        break
      }
      output += xml.slice(start, end + 1)
      cursor = end + 1
      continue
    }
    if (!next || next === '/') {
      output += '<'
      cursor = start + 1
      continue
    }
    if (!XML_NAME_START.test(next)) {
      output += '<'
      cursor = start + 1
      continue
    }
    const end = findTagEnd(xml, start)
    if (end < 0) {
      output += xml.slice(start)
      break
    }
    const tag = xml.slice(start, end + 1)
    const tagName = /^<([^\s/>]+)/.exec(tag)?.[1]
    if (tagName === 'w:rsids') {
      if (/\/\s*>$/.test(tag)) {
        output += tag
        cursor = end + 1
        continue
      }
      const blockEnd = findElementEnd(xml, tagName, end + 1)
      if (blockEnd >= 0) {
        cursor = blockEnd
        continue
      }
    }
    const rewritten = rewriteStartTag(tag)
    output += rewritten.output
    names.push(...rewritten.names)
    cursor = end + 1
  }
  return { output, names }
}

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
  const isEpub = zipDocumentKind(entries) === 'epub'
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
        where: entry.name,
        label: `${rule?.what ?? (isCustomXml ? 'custom XML part' : 'writer-specific properties')}`,
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
        where: entry.name,
        label: "An image of the document's first page",
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
      const identity = anonymiseAttributes(before)
      const after = identity.output
      if (after !== before) {
        findings.push({
          kind: 'doc_property',
          verdict: 'probable',
          offset: 0,
          length: entry.data.length,
          where: entry.name,
          label: 'Author names, timestamps and revision ids',
          evidence:
            snippet([...new Set(identity.names)].join(' · ')) || 'revision save identifiers',
        })
        rebuilt.push({
          name: entry.name,
          data: encode(after),
          ...(entry.stored ? { stored: true } : {}),
        })
        continue
      }
    }

    // EPUB keeps its metadata in an OPF package document rather than in
    // docProps. Same leak, different filename: author, contributor, the
    // identifier a library system assigned, and whatever Calibre wrote.
    if (entry.name.endsWith('.opf')) {
      const before = decodeUtf8(entry.data)
      const after = stripOpfMetadata(before)
      if (after !== before) {
        findings.push({
          kind: 'doc_property',
          verdict: 'informational',
          offset: 0,
          length: entry.data.length,
          where: entry.name,
          label: 'Package metadata (creator, contributor, identifier)',
          evidence: describe(before) || snippet(before.replaceAll(/<[^>]*>/g, ' ')),
        })
        rebuilt.push({
          name: entry.name,
          data: encode(after),
          ...(entry.stored ? { stored: true } : {}),
        })
        continue
      }
    }

    // The leak a text-level clean cannot see, and the one users are most
    // surprised by: a photograph pasted into a document keeps its own EXIF,
    // GPS included, inside `word/media/`. Every pass above reads XML and walks
    // straight past it, so a document could be reported clean while carrying
    // the coordinates of where a picture in it was taken.
    if (MEDIA_PATH.test(entry.name) || (isEpub && IMAGE_FILE.test(entry.name))) {
      // eslint-disable-next-line no-await-in-loop -- entries are cleaned in order
      const cleaned = await cleanEmbeddedImage(entry.data)
      if (cleaned && cleaned.findings.length > 0) {
        for (const finding of cleaned.findings) {
          findings.push({ ...finding, where: entry.name })
        }
        rebuilt.push({
          name: entry.name,
          data: cleaned.output,
          ...(entry.stored ? { stored: true } : {}),
        })
        continue
      }
    }

    rebuilt.push(entry)
  }

  return { output: await writeZip(rebuilt), findings, preserved: [] }
}

/**
 * Where a package keeps the pictures someone put in it.
 *
 * OOXML and ODF both fix the directory, so those are matched by path. EPUB does
 * not: the content directory is declared in `META-INF/container.xml` and is
 * routinely `item/`, `content/` or a bare `images/`, so anchoring to OEBPS,
 * EPUB and OPS meant a GPS-bearing photograph in any other layout survived a
 * clean with no finding at all. In an EPUB every image is content, so the
 * extension is the test and the location is not.
 */
const MEDIA_PATH = /^(?:word|ppt|xl)\/media\/|^Pictures\//i
const IMAGE_FILE = /\.(?:jpe?g|png|webp|gif)$/i

/**
 * Clean one embedded picture with the handler that already knows its format.
 *
 * Sniffed from the bytes rather than the extension, because a `.png` in
 * `word/media/` produced by a paste is quite often a JPEG.
 */
async function cleanEmbeddedImage(bytes: Uint8Array): Promise<ContainerResult | undefined> {
  if (sniffPng(bytes)) return cleanPng(bytes)
  if (sniffJpeg(bytes)) return cleanJpeg(bytes)
  if (sniffWebp(bytes)) return cleanWebp(bytes)
  if (sniffGif(bytes)) return cleanGif(bytes)
  return undefined
}

/**
 * Dublin Core fields in an EPUB package document that name a person.
 *
 * Text-only content (`[^<]*`) and an open tag that may not be self-closing
 * (`(?<!\/)>`). Both bounds are load-bearing, and the first version of this had
 * neither: it also matched `meta`, so a self-closing `<meta name="cover"/>` —
 * present in essentially every EPUB 2 — opened a match that ran forward to the
 * next `</meta>` anywhere later in the file. In an EPUB 3, which is required to
 * carry a paired `<meta property="dcterms:modified">`, that swallowed the
 * title, the language and the identifier in between, and the book stopped being
 * a valid EPUB. The finding still said "package metadata" and the pass still
 * reported success.
 */
const OPF_PERSON =
  /<(dc:(?:creator|contributor|publisher|source|rights|date))\b([^>]*?)(?<!\/)>[^<]*<\/\1>/g

/** Reading-software bookkeeping, which is always self-contained and always goes. */
const OPF_TOOL_META = /<meta\b[^>]*\bname="(?:calibre|dtb):[^"]*"[^>]*?\/?>(?:<\/meta>)?/g

/**
 * Empty the OPF fields that name someone, keeping the elements themselves.
 *
 * Same reasoning as the OOXML parts: a reader that expects `<dc:creator>` to
 * exist should still find it, and its attributes are kept because `id` is what
 * the package's `unique-identifier` points at.
 *
 * Deliberately untouched: `dc:title` and `dc:language`, which describe the book
 * and not the person; `dc:identifier`, because the package element references
 * it by id and removing it invalidates the file — it is reported instead;
 * `<meta property="dcterms:modified">`, which EPUB 3 requires.
 */
const stripOpfMetadata = (xml: string): string =>
  xml
    .replaceAll(
      OPF_PERSON,
      (_match, tag: string, attributes: string) => `<${tag}${attributes}></${tag}>`,
    )
    .replaceAll(OPF_TOOL_META, '')
