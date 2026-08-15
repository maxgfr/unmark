// From "where the objects are" to "what the objects are".
//
// The part that a byte-level pass can never do. PDF 1.5 lets a writer pack
// most of a document's dictionaries into a compressed object stream, and that
// is exactly where a modern producer puts the information dictionary — which
// is why the old in-place cleaner had to end its report with an admission that
// it could not see in there. Inflating the stream and parsing what falls out
// is the whole difference.
//
// Objects are loaded one at a time on purpose. Each one is an independent
// parse against a byte offset, and doing them concurrently would only trade a
// legible failure for an unordered one.
// oxlint-disable no-await-in-loop

import {
  asArray,
  asName,
  asNumber,
  decodeStream,
  parseIndirect,
  Reader,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  type PdfSource,
} from './lex.ts'
import { readXref, type Xref } from './xref.ts'

export interface StoredObject {
  gen: number
  object: PdfObject
  /**
   * True when this came out of a `/Type /ObjStm`.
   *
   * Carried so the writer can be held to the rule that matters: an object read
   * out of a compressed stream is written back as an ordinary one. Putting it
   * back where it came from would rebuild the hiding place.
   */
  compressed: boolean
}

export interface PdfDocument {
  src: PdfSource
  trailer: PdfDict
  objects: Map<number, StoredObject>
  /** Cross-reference sections in the chain. */
  sections: number
  linearized: boolean
  /** The cross-reference chain was unusable and the file was scanned instead. */
  recovered: boolean
}

/** An object stream holding more than this is corrupt, not large. */
const MAX_OBJSTM_COUNT = 1 << 16
/** A reference chain longer than this is a loop somebody built on purpose. */
const MAX_RESOLVE_DEPTH = 32
/** Page trees are shallow; anything deeper is a cycle the visited set missed. */
const MAX_PAGE_NODES = 1 << 20

function fail(message: string): never {
  throw new Error(`pdf: ${message}`)
}

/** Follow indirect references until something real is on the other end. */
export function resolve(doc: PdfDocument, object: PdfObject | undefined): PdfObject | undefined {
  let current = object
  for (let depth = 0; depth < MAX_RESOLVE_DEPTH; depth += 1) {
    if (current?.type !== 'ref') return current
    current = doc.objects.get(current.num)?.object
  }
  return fail('reference chain does not end')
}

export const resolver =
  (doc: PdfDocument) =>
  (object: PdfObject | undefined): PdfObject | undefined =>
    resolve(doc, object)

export const lookup = (
  doc: PdfDocument,
  object: PdfObject | undefined,
  key: string,
): PdfObject | undefined => {
  const holder = resolve(doc, object)
  const dict =
    holder?.type === 'dict' ? holder : holder?.type === 'stream' ? holder.dict : undefined
  return resolve(doc, dict?.entries.get(key))
}

/**
 * Unpack a `/Type /ObjStm`: a length-prefixed index, then the objects.
 *
 * The first `/First` bytes are `/N` pairs of "object number, offset relative to
 * /First". The objects themselves are plain syntax with the `N G obj` header
 * stripped, which is the only reason this is not simply `parseIndirect` again.
 */
function readObjectStream(
  data: Uint8Array,
  count: number,
  first: number,
): { num: number; object: PdfObject }[] {
  if (count < 0 || count > MAX_OBJSTM_COUNT) fail(`object stream claims ${count} objects`)
  if (first < 0 || first > data.length) fail('object stream /First is outside the stream')

  let text = ''
  const chunk = 8192
  for (let i = 0; i < data.length; i += chunk) {
    text += String.fromCharCode(...data.subarray(i, i + chunk))
  }
  const src: PdfSource = { bytes: data, text }

  const header = new Reader(src, 0)
  const pairs: { num: number; at: number }[] = []
  for (let i = 0; i < count; i += 1) {
    header.skip()
    const num = header.integer()
    header.skip()
    const at = header.integer()
    if (num === undefined || at === undefined || header.pos > first) {
      fail('object stream index ran past /First')
    }
    pairs.push({ num, at })
  }

  return pairs.map(({ num, at }) => ({ num, object: new Reader(src, first + at).parse() }))
}

async function materialise(src: PdfSource, xref: Xref): Promise<Map<number, StoredObject>> {
  const objects = new Map<number, StoredObject>()

  // `/Length` is allowed to live in its own object, so reading a stream can
  // need a second object read. Streams never hold a length, so this cannot
  // recurse into itself.
  const resolveLength = (ref: PdfRef): number | undefined => {
    const entry = xref.entries.get(ref.num)
    if (entry?.kind !== 'offset') return undefined
    try {
      return asNumber(parseIndirect(src, entry.offset).object)
    } catch {
      return undefined
    }
  }

  for (const [num, entry] of xref.entries) {
    if (entry.kind !== 'offset') continue
    try {
      const parsed = parseIndirect(src, entry.offset, resolveLength)
      // A table that points at the wrong object is a table to distrust. The
      // object is dropped rather than filed under a number it does not carry;
      // if anything live needed it, the page-tree check at the end will say so.
      if (parsed.num !== num) continue
      objects.set(num, { gen: parsed.gen, object: parsed.object, compressed: false })
    } catch {
      continue
    }
  }

  // /Filter is allowed to be an indirect reference, and the objects it would
  // point at are the plain ones already loaded above.
  const resolveLocal = (object: PdfObject | undefined): PdfObject | undefined => {
    let current = object
    for (let depth = 0; depth < MAX_RESOLVE_DEPTH && current?.type === 'ref'; depth += 1) {
      current = objects.get(current.num)?.object
    }
    return current
  }

  const wanted = new Map<number, { num: number; index: number }[]>()
  for (const [num, entry] of xref.entries) {
    if (entry.kind !== 'compressed') continue
    const list = wanted.get(entry.stream)
    if (list) list.push({ num, index: entry.index })
    else wanted.set(entry.stream, [{ num, index: entry.index }])
  }

  for (const [streamNum, members] of wanted) {
    const holder = objects.get(streamNum)
    // An object stream inside an object stream is illegal, and a table that
    // claims one is pointing somewhere it should not.
    if (!holder || holder.object.type !== 'stream' || holder.compressed) continue
    if (asName(holder.object.dict.entries.get('Type')) !== 'ObjStm') continue

    const count = asNumber(resolveLocal(holder.object.dict.entries.get('N'))) ?? 0
    const first = asNumber(resolveLocal(holder.object.dict.entries.get('First'))) ?? 0
    const data = await decodeStream(holder.object, resolveLocal)
    const unpacked = readObjectStream(data, count, first)

    for (const { num, index } of members) {
      // The stream's own index says which object number each slot holds. When
      // it disagrees with the cross-reference table, the file is inconsistent
      // and neither answer is worth guessing at.
      const found = unpacked[index]
      if (!found || found.num !== num) continue
      objects.set(num, { gen: 0, object: found.object, compressed: true })
    }
  }

  return objects
}

export async function loadDocument(src: PdfSource): Promise<PdfDocument> {
  const xref = await readXref(src)
  const objects = await materialise(src, xref)
  if (objects.size === 0) fail('no objects could be read')
  return {
    src,
    trailer: xref.trailer,
    objects,
    sections: xref.sections,
    linearized: xref.linearized,
    recovered: xref.recovered,
  }
}

/** Every object number the graph can reach from a starting reference. */
export function reachable(doc: PdfDocument, from: readonly PdfRef[]): Set<number> {
  const seen = new Set<number>()
  const queue: PdfObject[] = []

  const visit = (object: PdfObject | undefined) => {
    if (!object) return
    if (object.type === 'ref') {
      if (seen.has(object.num)) return
      seen.add(object.num)
      const held = doc.objects.get(object.num)
      if (held) queue.push(held.object)
      return
    }
    queue.push(object)
  }

  for (const ref of from) visit(ref)

  while (queue.length > 0) {
    const object = queue.pop()
    if (!object) break
    if (object.type === 'array') for (const item of object.items) visit(item)
    else if (object.type === 'dict') for (const value of object.entries.values()) visit(value)
    else if (object.type === 'stream')
      for (const value of object.dict.entries.values()) visit(value)
  }

  return seen
}

/**
 * Leaves of the page tree.
 *
 * Counted by walking rather than by trusting `/Count`, because `/Count` is a
 * number a writer maintains by hand and the rebuild is checked against this.
 * A verification that reads the same claim from both sides verifies nothing.
 */
export function countPages(doc: PdfDocument): number {
  const root = lookup(doc, doc.trailer, 'Root')
  const pages = lookup(doc, root, 'Pages')
  if (!pages) fail('no page tree')

  const seen = new Set<PdfObject>()
  const queue: PdfObject[] = [pages]
  let count = 0
  let visited = 0

  while (queue.length > 0) {
    const node = queue.pop()
    if (!node || seen.has(node)) continue
    seen.add(node)
    visited += 1
    if (visited > MAX_PAGE_NODES) fail('page tree does not end')

    const dict = node.type === 'dict' ? node : undefined
    if (!dict) continue

    const kids = asArray(resolve(doc, dict.entries.get('Kids')))
    if (!kids) {
      if (asName(dict.entries.get('Type')) === 'Page' || dict.entries.has('Contents')) count += 1
      continue
    }
    for (const kid of kids) {
      const child = resolve(doc, kid)
      if (child) queue.push(child)
    }
  }

  return count
}
