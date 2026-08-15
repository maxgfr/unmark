// What gets removed from a PDF, and what happens when it cannot be.
//
// Two passes live here and they are not equals. The rebuild parses the file
// into an object graph, drops the metadata, and writes a fresh document with a
// fresh cross-reference table — which is the only way to remove the
// information dictionary from inside a compressed object stream, and the only
// way to drop the incremental-save history that keeps a "redacted" paragraph
// readable under the black box drawn over it. The byte pass is the old
// in-place cleaner: it blanks values without moving a byte, reaches nothing
// compressed, and leaves every earlier revision where it was. It is kept
// because a parser that meets a file it does not understand should degrade,
// not give up.
//
// Every finding says which of the two produced it. A report that does not
// distinguish a rebuild from a fallback is telling the reader that the two
// left the file in the same state, and they did not.
//
// Three refusals, each of which reports itself rather than passing quietly:
//
//   - Encrypted. Nothing is read and nothing is written. This is a bug fix:
//     the byte pass reported an encrypted file as clean, because encrypted
//     strings do not match a regex for `/Author (…)`, and "no matches" was
//     rendered as "nothing found".
//   - Signed. Any edit at all voids the signature, so the default is to leave
//     the file alone and say why. `{ force: true }` proceeds and reports that
//     the signature is now void.
//   - Unparseable. Fall back to the byte pass and say what that leaves behind.
//
// The findings loop awaits one XMP packet at a time. Findings come out in
// document order and the report reads in that order; batching them would win
// nothing and reorder the output.
// oxlint-disable no-await-in-loop

import type { Finding } from '../../report.ts'
import { snippet, type ContainerResult } from '../types.ts'
import {
  asDict,
  asName,
  asNumber,
  decodeStream,
  parseIndirect,
  source,
  type PdfObject,
  type PdfSource,
  type PdfStream,
} from './lex.ts'
import { countPages, loadDocument, lookup, reachable, resolve } from './objects.ts'
import type { PdfDocument, StoredObject } from './objects.ts'
import { readXref } from './xref.ts'
import { writePdf } from './write.ts'

export interface PdfCleanOptions {
  /**
   * Clean a signed document anyway.
   *
   * There is no way to edit a PDF and keep its signature valid — the signature
   * covers a byte range of the file it was made from. The option exists
   * because "this file is signed and also carries the author's name" is a real
   * situation with two defensible answers, and the caller is better placed to
   * pick one.
   */
  force?: boolean
}

const REBUILD = 'structural rebuild'
const BYTE_PASS = 'byte pass'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message.replace(/^pdf: /, '') : String(error)

/** Byte-for-char view, so a regex index is a byte offset. */
const latin1 = (bytes: Uint8Array): string => source(bytes).text

/** A PDF text string is UTF-16BE when it starts with a byte-order mark, latin1 otherwise. */
function textOf(object: PdfObject | undefined): string {
  if (object?.type === 'name') return `/${object.name}`
  if (object?.type === 'number') return String(object.value)
  if (object?.type !== 'string') return ''
  const bytes = object.bytes.subarray(0, 1024)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  return String.fromCharCode(...bytes)
}

const finding = (
  kind: Finding['kind'],
  verdict: Finding['verdict'],
  label: string,
  evidence?: string,
): Finding => ({
  kind,
  verdict,
  offset: 0,
  length: 0,
  label,
  ...(evidence ? { evidence } : {}),
})

// ---------------------------------------------------------------- refusals

const ENCRYPT = /\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</
const SIGNED = /\/ByteRange\s*\[|\/Type\s*\/Sig[^a-zA-Z]|\/SubFilter\s*\/(?:adbe|ETSI)/

function isEncrypted(doc: PdfDocument | undefined, text: string): boolean {
  // The trailer is the authority, but a file whose trailer would not parse is
  // exactly the file that must not be waved through, so the raw form counts too.
  return doc?.trailer.entries.has('Encrypt') === true || ENCRYPT.test(text)
}

function isSigned(doc: PdfDocument | undefined, text: string): boolean {
  for (const stored of doc?.objects.values() ?? []) {
    const dict = asDict(stored.object)
    if (!dict) continue
    if (dict.entries.has('ByteRange') || asName(dict.entries.get('Type')) === 'Sig') return true
  }
  return SIGNED.test(text)
}

// ---------------------------------------------------------------- byte pass

const INFO_KEYS = [
  'Producer',
  'Creator',
  'Author',
  'Title',
  'Subject',
  'Keywords',
  'CreationDate',
  'ModDate',
]

/** Decode a PDF hex string, `<48656C6C6F>`, for reporting. */
function fromHex(body: string): string {
  const digits = body.replaceAll(/[^0-9A-Fa-f]/g, '')
  let out = ''
  for (let i = 0; i + 1 < digits.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 16))
  }
  return out
}

/**
 * Blank metadata values in place, never resizing the file.
 *
 * A PDF's cross-reference table is a list of byte offsets. Delete four bytes
 * anywhere before it and every offset after that point is wrong. So values are
 * overwritten with spaces: the offsets never move, the file stays valid, and
 * nothing readable remains in the bytes this can see. What it cannot see —
 * anything inside a compressed object stream, and every earlier revision — is
 * reported rather than quietly left out.
 */
export function bytePass(bytes: Uint8Array): ContainerResult {
  const text = latin1(bytes)
  const output = bytes.slice()
  const findings: Finding[] = []

  const blank = (start: number, end: number) => output.fill(0x20, start, end)

  // 1. Document information dictionary entries.
  for (const key of INFO_KEYS) {
    const pattern = new RegExp(
      String.raw`/${key}\s*(?:\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>)`,
      'g',
    )
    for (const match of text.matchAll(pattern)) {
      const [whole, literal, hex] = match
      const value = literal ?? (hex === undefined ? '' : fromHex(hex))
      if (!value.trim()) continue

      // Blank the value only, leaving the delimiters so the syntax stays legal.
      const valueStart = match.index + whole.indexOf(literal === undefined ? '<' : '(') + 1
      blank(valueStart, valueStart + (literal ?? hex ?? '').length)

      findings.push({
        kind: 'doc_property',
        verdict: 'informational',
        offset: match.index,
        length: whole.length,
        label: `/${key} in the document information dictionary (${BYTE_PASS})`,
        evidence: snippet(value),
      })
    }
  }

  // 2. XMP packets, which is where "generated by" claims usually live. The
  //    packet has trailing padding by design, so filling it with spaces leaves
  //    a well-formed, empty packet rather than a hole.
  const packet = /<\?xpacket begin=[\s\S]*?<\?xpacket end=[^?]*\?>/g
  for (const match of text.matchAll(packet)) {
    const tool = /<(?:xmp:CreatorTool|pdf:Producer|dc:creator)>([^<]*)</.exec(match[0])?.[1]
    blank(match.index, match.index + match[0].length)
    findings.push({
      kind: 'xmp',
      verdict: 'probable',
      offset: match.index,
      length: match[0].length,
      label: `XMP metadata packet (${BYTE_PASS})`,
      ...(tool ? { evidence: snippet(tool) } : {}),
    })
  }

  // 3. Incremental saves. Each one appends to the file instead of rewriting it,
  //    so every earlier version is still in there — including, notoriously, the
  //    text under a black rectangle somebody drew and called a redaction.
  //    Removing them means rebuilding the document, which a byte-level pass
  //    cannot do; saying so is the honest alternative to staying quiet.
  const eofs = [...text.matchAll(/%%EOF/g)]
  if (eofs.length > 1) {
    findings.push({
      kind: 'doc_property',
      verdict: 'confirmed',
      offset: eofs[0]?.index ?? 0,
      length: 0,
      label: `${eofs.length - 1} earlier version(s) of this document are still in the file (${BYTE_PASS})`,
      evidence:
        'PDF saves incrementally: each edit appends rather than rewrites, so previous drafts — ' +
        'including anything covered over rather than deleted — remain recoverable. Re-saving ' +
        'the file from a PDF editor with "save as" rather than "save" collapses the history.',
    })
  }

  // 4. Say what could not be reached, rather than implying the file is clean.
  //    PDF 1.5 can pack the information dictionary into a compressed object
  //    stream, where it is deflated and invisible to a byte scan.
  if (/\/Type\s*\/ObjStm/.test(text)) {
    findings.push({
      kind: 'doc_property',
      verdict: 'informational',
      offset: 0,
      length: 0,
      label: `Compressed object streams present — metadata inside them was not reached (${BYTE_PASS})`,
      evidence:
        'This PDF stores objects in compressed streams. Blanking bytes in place cannot see ' +
        'inside them, so metadata may remain. Re-saving the file from a PDF editor rewrites ' +
        'those streams.',
    })
  }

  return { output, findings, preserved: [] }
}

// ---------------------------------------------------------------- rebuild

/** Keys that are metadata wherever in the document they turn up. */
const EVERYWHERE = ['Metadata', 'PieceInfo']

async function xmpEvidence(stream: PdfStream): Promise<string> {
  let text: string
  try {
    text = latin1(await decodeStream(stream))
  } catch {
    text = latin1(stream.raw)
  }
  const tool = /<(?:xmp:CreatorTool|pdf:Producer|dc:creator|xmpMM:DocumentID)>([^<]*)</.exec(text)
  return snippet(tool?.[1] ?? '')
}

interface Rebuilt {
  output: Uint8Array
  findings: Finding[]
  pages: number
}

/**
 * Edit the parsed graph, then write what is still reachable from the catalog.
 *
 * The graph is mutated rather than copied: it was parsed from the caller's
 * bytes a few lines ago and is thrown away a few lines later, and threading an
 * immutable copy through five levels of dictionary would obscure the one thing
 * this function does.
 *
 * Reachability is doing more work than it looks like. The information
 * dictionary is not deleted, it is unlinked from the trailer — and then it is
 * simply not written, along with the XMP stream, the object streams that used
 * to hold them, the old cross-reference streams, and every object left over
 * from an earlier revision. That is what removes the incremental history: not
 * a pass that hunts for it, but a writer that only ever emits the live graph.
 */
async function rebuild(doc: PdfDocument, signed: boolean): Promise<Rebuilt> {
  const findings: Finding[] = []
  const pages = countPages(doc)

  const rootRef = doc.trailer.entries.get('Root')
  if (rootRef?.type !== 'ref') throw new Error('pdf: the trailer has no /Root reference')
  const catalog = asDict(resolve(doc, rootRef))
  if (!catalog) throw new Error('pdf: the catalog is missing')

  // /Info: reported entry by entry, then unlinked from the trailer.
  const infoRef = doc.trailer.entries.get('Info')
  const info = asDict(resolve(doc, infoRef))
  const infoWasCompressed =
    infoRef?.type === 'ref' && doc.objects.get(infoRef.num)?.compressed === true
  for (const [key, value] of info?.entries ?? []) {
    const shown = textOf(resolve(doc, value))
    if (!shown.trim()) continue
    findings.push(
      finding(
        'doc_property',
        'informational',
        `/${key} in the document information dictionary (${REBUILD})`,
        snippet(shown),
      ),
    )
  }
  doc.trailer.entries.delete('Info')

  // /Metadata and /PieceInfo, wherever they are: the catalog carries the XMP
  // packet, but a page can carry its own, and /PieceInfo is per-page as often
  // as it is per-document.
  let removedPieceInfo = 0
  for (const stored of doc.objects.values()) {
    const dict = asDict(stored.object)
    if (!dict) continue
    for (const key of EVERYWHERE) {
      if (!dict.entries.has(key)) continue
      if (key === 'Metadata') {
        const stream = resolve(doc, dict.entries.get('Metadata'))
        findings.push(
          finding(
            'xmp',
            'probable',
            `XMP metadata stream (${REBUILD})`,
            stream?.type === 'stream' ? await xmpEvidence(stream) : '',
          ),
        )
      } else {
        removedPieceInfo += 1
      }
      dict.entries.delete(key)
    }

    // An indirect /Length would keep an otherwise dead integer object alive,
    // and the writer emits the real length anyway.
    const stream = stored.object
    if (stream.type === 'stream' && stream.dict.entries.get('Length')?.type === 'ref') {
      stream.dict.entries.set('Length', { type: 'number', value: stream.raw.length })
    }
  }
  if (removedPieceInfo > 0) {
    findings.push(
      finding(
        'doc_property',
        'informational',
        `/PieceInfo private application data (${REBUILD})`,
        `${removedPieceInfo} dictionar${removedPieceInfo === 1 ? 'y' : 'ies'} removed — the ` +
          'editor that produced the file keeps its own per-document state here.',
      ),
    )
  }

  // Embedded JavaScript, which runs on open and is a provenance mark as often
  // as it is a feature.
  const names = asDict(lookup(doc, catalog, 'Names'))
  if (names?.entries.has('JavaScript')) {
    names.entries.delete('JavaScript')
    findings.push(
      finding(
        'doc_property',
        'confirmed',
        `/Names /JavaScript document-level script (${REBUILD})`,
        'A script the viewer runs when the document opens.',
      ),
    )
  }

  const compressed = [...doc.objects.values()].filter((stored) => stored.compressed).length
  if (compressed > 0) {
    findings.push(
      finding(
        'doc_property',
        'informational',
        `${compressed} object(s) were inside compressed object streams (${REBUILD})`,
        `Read out and written back as ordinary objects${
          infoWasCompressed ? ', including the information dictionary' : ''
        }. The byte pass cannot see inside a deflated stream; this is what the rebuild is for.`,
      ),
    )
  }

  // Linearization splits the cross-reference table in two without the file
  // having been saved twice, so it does not count as a revision.
  const revisions = doc.sections - (doc.linearized ? 1 : 0)
  if (revisions > 1) {
    findings.push(
      finding(
        'doc_property',
        'confirmed',
        `${revisions - 1} earlier version(s) of this document were dropped (${REBUILD})`,
        'PDF saves incrementally: each edit appends rather than rewrites, so previous drafts — ' +
          'including anything covered over rather than deleted — stay recoverable. Only the ' +
          'current object graph was written out.',
      ),
    )
  }

  if (signed) {
    findings.push(
      finding(
        'doc_property',
        'confirmed',
        `Digital signature is now void (${REBUILD})`,
        'The signature covered a byte range of the original file. Rebuilding the document ' +
          'invalidates it, which is unavoidable and was requested with { force: true }.',
      ),
    )
  }

  const live = reachable(doc, [rootRef])
  const objects = new Map<number, StoredObject>()
  for (const num of [...live].sort((a, b) => a - b)) {
    const stored = doc.objects.get(num)
    if (stored) objects.set(num, stored)
  }
  if (!objects.has(rootRef.num)) throw new Error('pdf: the catalog is not in the object map')

  return { output: writePdf({ objects, root: rootRef }), findings, pages }
}

// ---------------------------------------------------------------- verify

/**
 * Read our own output back and check it, or say what is wrong with it.
 *
 * The safety net the whole rebuild rests on. A PDF writer that is subtly wrong
 * produces a file that opens in one viewer and not another, and the failure
 * shows up on somebody's machine weeks later. Re-parsing here turns that into
 * a fallback to the byte pass, which is degraded but never broken.
 *
 * Checked against the *input's* page count, not against the output's own
 * `/Count`: a claim that agrees with itself is not evidence.
 */
async function verify(output: Uint8Array, pages: number): Promise<string | undefined> {
  const src: PdfSource = source(output)

  try {
    const xref = await readXref(src)
    if (xref.recovered) return 'the cross-reference table it wrote could not be followed'

    for (const [num, entry] of xref.entries) {
      if (entry.kind === 'free') continue
      if (entry.kind !== 'offset') return `object ${num} was written into an object stream`
      const parsed = parseIndirect(src, entry.offset)
      if (parsed.num !== num) {
        return `the entry for object ${num} points at object ${parsed.num}`
      }
      if (parsed.object.type === 'stream') {
        const declared = asNumber(parsed.object.dict.entries.get('Length'))
        if (declared !== parsed.object.raw.length) {
          return `object ${num} declares /Length ${declared ?? '?'} for ${parsed.object.raw.length} bytes`
        }
      }
    }

    const doc = await loadDocument(src)
    const catalog = asDict(lookup(doc, doc.trailer, 'Root'))
    if (!catalog) return 'the catalog is not reachable from the trailer it wrote'
    if (!lookup(doc, catalog, 'Pages')) return 'the page tree is not reachable from the catalog'

    const got = countPages(doc)
    if (got !== pages) return `the page count changed from ${pages} to ${got}`

    if (doc.trailer.entries.has('Info')) return 'the trailer still names an /Info dictionary'
    for (const stored of doc.objects.values()) {
      if (asDict(stored.object)?.entries.has('Metadata')) return 'a /Metadata stream survived'
    }

    let eofs = 0
    for (let at = src.text.indexOf('%%EOF'); at !== -1; at = src.text.indexOf('%%EOF', at + 5)) {
      eofs += 1
    }
    if (eofs !== 1) return `it wrote ${eofs} %%EOF markers`
  } catch (error) {
    return `it could not be read back: ${messageOf(error)}`
  }

  return undefined
}

// ---------------------------------------------------------------- entry point

export async function cleanPdf(
  bytes: Uint8Array,
  options: PdfCleanOptions = {},
): Promise<ContainerResult> {
  const src = source(bytes)

  let doc: PdfDocument | undefined
  let loadFailure: string | undefined
  try {
    doc = await loadDocument(src)
  } catch (error) {
    loadFailure = messageOf(error)
  }

  if (isEncrypted(doc, src.text)) {
    return {
      output: bytes,
      findings: [
        finding(
          'doc_property',
          'confirmed',
          'Encrypted PDF — nothing was read and nothing was changed (no pass ran)',
          'Every string in this file is encrypted, so a scan for metadata finds nothing and ' +
            'would report the file as clean. It is not: the author, the producer and the ' +
            'timestamps are in there, encrypted. Remove the password in a PDF editor and run ' +
            'this again.',
        ),
      ],
      preserved: [],
    }
  }

  const signed = isSigned(doc, src.text)
  if (signed && !options.force) {
    return {
      output: bytes,
      findings: [
        finding(
          'doc_property',
          'confirmed',
          'Digitally signed — the file was left exactly as it arrived (no pass ran)',
          'A signature covers a byte range of this file, so any edit voids it, including ' +
            'removing metadata. Nothing was changed. Pass { force: true } to clean it anyway ' +
            'and accept a broken signature.',
        ),
      ],
      preserved: [],
    }
  }

  let reason = loadFailure
  if (doc) {
    try {
      const rebuilt = await rebuild(doc, signed)
      reason = await verify(rebuilt.output, rebuilt.pages)
      if (reason === undefined) {
        // Nothing found means nothing to change. Handing back a byte-identical
        // file is a stronger statement than handing back an equivalent one.
        return rebuilt.findings.length === 0
          ? { output: bytes, findings: [], preserved: [] }
          : { output: rebuilt.output, findings: rebuilt.findings, preserved: [] }
      }
    } catch (error) {
      reason = messageOf(error)
    }
  }

  const fallback = bytePass(bytes)
  return {
    output: fallback.output,
    findings: [
      finding(
        'doc_property',
        'confirmed',
        `Structural rebuild was not possible — values were blanked in place instead (${BYTE_PASS})`,
        `${reason ?? 'the document could not be parsed'}. The in-place pass leaves every ` +
          'earlier revision of the document in the file and cannot see inside compressed ' +
          'object streams, so metadata may remain.',
      ),
      ...fallback.findings,
    ],
    preserved: [],
  }
}
