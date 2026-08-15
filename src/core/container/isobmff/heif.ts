// HEIC and AVIF: a picture is an *item*, and its bytes live somewhere else.
//
// `meta` describes the file as a list of items. `iinf` names them, `iloc` says
// where each one's bytes are — almost always an absolute file offset into
// `mdat` — `iref` wires them to each other, and `ipma` attaches properties to
// them. Removing the EXIF item therefore means five edits, not one: cut its
// bytes, drop its `infe`, drop its `iloc` entry, drop the `cdsc` reference that
// pointed at it, drop its `ipma` associations, and then correct the offsets of
// every item that was stored after it.
//
// Getting that last step wrong is what silently corrupts a file. The image
// still decodes for a while, because the first bytes of the picture are still
// where the table says, and then it does not. So this module hands back a plan
// rather than editing anything: what to drop, what to replace, which byte
// ranges to cut, and a reason to refuse if any of it cannot be done safely.

import type { Finding } from '../../report.ts'
import { ascii, concat, decodeUtf8, readU32, snippet } from '../types.ts'
import {
  headerLength,
  readUint,
  rewriteHeader,
  shifted,
  writeUint,
  type Box,
  type Found,
  type Range,
} from './boxes.ts'

// ------------------------------------------------------- the location table

interface Extent {
  index: number
  offset: number
  length: number
}

interface IlocItem {
  itemId: number
  constructionMethod: number
  dataReferenceIndex: number
  baseOffset: number
  extents: Extent[]
}

interface Iloc {
  version: number
  flags: number
  offsetSize: number
  lengthSize: number
  baseOffsetSize: number
  indexSize: number
  items: IlocItem[]
}

/** The item location table: where every item's bytes actually live. */
function parseIloc(bytes: Uint8Array, box: Box): Iloc | undefined {
  let at = box.body
  const version = bytes[at] ?? 0
  const flags = readU32(bytes, at) & 0xff_ff_ff
  at += 4
  if (version > 2 || at + 2 > box.end) return undefined

  const packed = bytes[at] ?? 0
  const packedTwo = bytes[at + 1] ?? 0
  const offsetSize = packed >> 4
  const lengthSize = packed & 0x0f
  const baseOffsetSize = packedTwo >> 4
  const indexSize = version === 0 ? 0 : packedTwo & 0x0f
  at += 2

  const countSize = version < 2 ? 2 : 4
  if (at + countSize > box.end) return undefined
  const count = readUint(bytes, at, countSize)
  at += countSize

  const idSize = version < 2 ? 2 : 4
  const items: IlocItem[] = []
  for (let i = 0; i < count; i += 1) {
    if (at + idSize + (version >= 1 ? 2 : 0) + 2 + baseOffsetSize + 2 > box.end) return undefined
    const itemId = readUint(bytes, at, idSize)
    at += idSize
    let constructionMethod = 0
    if (version >= 1) {
      constructionMethod = (bytes[at + 1] ?? 0) & 0x0f
      at += 2
    }
    const dataReferenceIndex = readUint(bytes, at, 2)
    at += 2
    const baseOffset = readUint(bytes, at, baseOffsetSize)
    at += baseOffsetSize
    const extentCount = readUint(bytes, at, 2)
    at += 2

    const extents: Extent[] = []
    const stride = indexSize + offsetSize + lengthSize
    for (let j = 0; j < extentCount; j += 1) {
      if (at + stride > box.end) return undefined
      const index = readUint(bytes, at, indexSize)
      const offset = readUint(bytes, at + indexSize, offsetSize)
      const length = readUint(bytes, at + indexSize + offsetSize, lengthSize)
      at += stride
      extents.push({ index, offset, length })
    }
    items.push({ itemId, constructionMethod, dataReferenceIndex, baseOffset, extents })
  }
  return { version, flags, offsetSize, lengthSize, baseOffsetSize, indexSize, items }
}

/** Re-encode an `iloc` payload. Field widths never change, and offsets only shrink. */
function writeIloc(iloc: Iloc): Uint8Array {
  const idSize = iloc.version < 2 ? 2 : 4
  const countSize = idSize
  let total = 4 + 2 + countSize
  for (const item of iloc.items) {
    total += idSize + (iloc.version >= 1 ? 2 : 0) + 2 + iloc.baseOffsetSize + 2
    total += item.extents.length * (iloc.indexSize + iloc.offsetSize + iloc.lengthSize)
  }

  const out = new Uint8Array(total)
  out[0] = iloc.version
  writeUint(out, 1, 3, iloc.flags)
  out[4] = (iloc.offsetSize << 4) | iloc.lengthSize
  out[5] = (iloc.baseOffsetSize << 4) | iloc.indexSize
  let at = 6
  writeUint(out, at, countSize, iloc.items.length)
  at += countSize

  for (const item of iloc.items) {
    writeUint(out, at, idSize, item.itemId)
    at += idSize
    if (iloc.version >= 1) {
      out[at + 1] = item.constructionMethod & 0x0f
      at += 2
    }
    writeUint(out, at, 2, item.dataReferenceIndex)
    at += 2
    writeUint(out, at, iloc.baseOffsetSize, item.baseOffset)
    at += iloc.baseOffsetSize
    writeUint(out, at, 2, item.extents.length)
    at += 2
    for (const extent of item.extents) {
      writeUint(out, at, iloc.indexSize, extent.index)
      writeUint(out, at + iloc.indexSize, iloc.offsetSize, extent.offset)
      writeUint(out, at + iloc.indexSize + iloc.offsetSize, iloc.lengthSize, extent.length)
      at += iloc.indexSize + iloc.offsetSize + iloc.lengthSize
    }
  }
  return out
}

/**
 * Move an `iloc`'s offsets to follow the bytes they point at.
 *
 * Returns '' when it worked and the reason to refuse when it did not. Rewriting
 * in place is safe because the field widths are fixed and every offset only ever
 * gets smaller.
 */
export function repointIloc(out: Uint8Array, box: Box, removed: readonly Range[]): string {
  const iloc = parseIloc(out, box)
  if (!iloc) return 'the item location table could not be re-read after the rewrite'

  for (const item of iloc.items) {
    // Only construction method 0 stores file offsets. Method 1 is relative to
    // the `idat` box, which this pass never cuts into, so those stay as they are.
    if (item.constructionMethod !== 0) continue
    const base = item.baseOffset === 0 ? 0 : shifted(removed, item.baseOffset)
    if (base < 0) return 'an item base offset pointed at bytes that were removed'
    for (const extent of item.extents) {
      const moved = shifted(removed, item.baseOffset + extent.offset)
      if (moved < 0) return 'an item extent pointed at bytes that were removed'
      extent.offset = moved - base
    }
    item.baseOffset = base
  }

  const body = writeIloc(iloc)
  if (body.length !== box.end - box.body) {
    return 'the item location table could not be written back at its own size'
  }
  out.set(body, box.body)
  return ''
}

// ------------------------------------------------- the other item structures

interface Infe {
  itemId: number
  itemType: string
  contentType: string
}

/** An item info entry. Versions below 2 name no item type, so nothing can be matched on them. */
function parseInfe(bytes: Uint8Array, box: Box): Infe | undefined {
  const version = bytes[box.body] ?? 0
  if (version < 2) return undefined

  const idSize = version === 2 ? 2 : 4
  let at = box.body + 4
  if (at + idSize + 2 + 4 > box.end) return undefined
  const itemId = readUint(bytes, at, idSize)
  at += idSize + 2 // past item_protection_index
  const itemType = ascii(bytes, at, 4)
  at += 4

  // item_name, then content_type for a 'mime' item. Both NUL-terminated.
  let nameEnd = at
  while (nameEnd < box.end && bytes[nameEnd] !== 0) nameEnd += 1
  at = nameEnd + 1

  let contentType = ''
  if (itemType === 'mime' && at < box.end) {
    let typeEnd = at
    while (typeEnd < box.end && bytes[typeEnd] !== 0) typeEnd += 1
    contentType = decodeUtf8(bytes.subarray(at, typeEnd))
  }
  return { itemId, itemType, contentType }
}

/** Prune the item-property associations of items that are going away. */
function rewriteIpma(bytes: Uint8Array, box: Box, dropped: ReadonlySet<number>): Uint8Array | null {
  const version = bytes[box.body] ?? 0
  const flags = readU32(bytes, box.body) & 0xff_ff_ff
  const idSize = version < 1 ? 2 : 4
  const indexSize = (flags & 1) === 1 ? 2 : 1

  let at = box.body + 4
  if (at + 4 > box.end) return null
  const count = readUint(bytes, at, 4)
  at += 4

  const kept: Uint8Array[] = []
  let removed = 0
  for (let i = 0; i < count; i += 1) {
    if (at + idSize + 1 > box.end) return null
    const itemId = readUint(bytes, at, idSize)
    const associations = bytes[at + idSize] ?? 0
    const entryEnd = at + idSize + 1 + associations * indexSize
    if (entryEnd > box.end) return null
    if (dropped.has(itemId)) removed += 1
    else kept.push(bytes.subarray(at, entryEnd))
    at = entryEnd
  }
  if (removed === 0) return null

  const head = bytes.slice(box.body, box.body + 8)
  writeUint(head, 4, 4, count - removed)
  return concat([head, ...kept, bytes.subarray(at, box.end)])
}

/**
 * Prune an item reference entry, or return an empty payload when the whole entry goes.
 *
 * A HEIC's EXIF item is wired to the picture by a `cdsc` reference. Leaving that
 * reference behind once the item is gone points it at an id that no longer
 * exists, which is exactly the sort of quietly invalid file this pass exists to
 * avoid producing.
 */
function rewriteIrefEntry(
  bytes: Uint8Array,
  box: Box,
  version: number,
  dropped: ReadonlySet<number>,
): Uint8Array | null {
  const idSize = version === 0 ? 2 : 4
  if (box.body + idSize + 2 > box.end) return null
  const from = readUint(bytes, box.body, idSize)
  const count = readUint(bytes, box.body + idSize, 2)
  if (box.body + idSize + 2 + count * idSize > box.end) return null
  if (dropped.has(from)) return new Uint8Array()

  const targets: number[] = []
  for (let i = 0; i < count; i += 1) {
    const to = readUint(bytes, box.body + idSize + 2 + i * idSize, idSize)
    if (!dropped.has(to)) targets.push(to)
  }
  if (targets.length === count) return null

  const body = new Uint8Array(idSize + 2 + targets.length * idSize)
  writeUint(body, 0, idSize, from)
  writeUint(body, idSize, 2, targets.length)
  targets.forEach((to, i) => writeUint(body, idSize + 2 + i * idSize, idSize, to))
  return concat([rewriteHeader(bytes, box, headerLength(box) + body.length), body])
}

// ------------------------------------------------------------------ the plan

export interface ItemPlan {
  findings: Finding[]
  preserved: Finding[]
  /** Boxes to remove outright, by the offset their header starts at. */
  drop: Set<number>
  /** Boxes to emit as different bytes: a pruned `iloc`, `ipma` or reference entry. */
  replace: Map<number, Uint8Array>
  /** Item payload ranges to cut out of whichever leaf contains them. */
  holes: Range[]
  /** Set to the reason when the file has to come back untouched. */
  blocker: string
}

/**
 * Decide which items go, and everything that has to change because they did.
 *
 * `Exif` and `mime` are the only item types touched. A `mime` item is always
 * ancillary — the picture itself is an `hvc1`, `av01` or `grid` item — so it is
 * removed whatever its content type says, and the content type goes in the
 * report so the reader can see what it was.
 */
export function planItems(bytes: Uint8Array, found: readonly Found[]): ItemPlan {
  const plan: ItemPlan = {
    findings: [],
    preserved: [],
    drop: new Set(),
    replace: new Map(),
    holes: [],
    blocker: '',
  }

  const infes = found.filter((entry) => entry.parent === 'iinf' && entry.box.type === 'infe')
  const ilocBox = found.find((entry) => entry.box.type === 'iloc')?.box
  if (infes.length === 0) return plan

  // Without a readable location table there is no way to know which bytes
  // belong to which item, so no item is touched. If anything else in the file
  // still moves, `repointIloc` refuses the whole rewrite rather than leave the
  // table pointing at the wrong bytes.
  const iloc = ilocBox ? parseIloc(bytes, ilocBox) : undefined
  if (ilocBox && !iloc) return plan

  const dropped = new Set<number>()
  for (const entry of infes) {
    const infe = parseInfe(bytes, entry.box)
    if (!infe || (infe.itemType !== 'Exif' && infe.itemType !== 'mime')) continue

    const item = iloc?.items.find((candidate) => candidate.itemId === infe.itemId)
    // Construction method 1 places the bytes inside `idat` and 2 inside another
    // item, and both make the remaining items' offsets relative to something
    // this pass would have to renumber. Keep the item and say so, rather than
    // guess: leaving one EXIF block in a file is recoverable, corrupting the
    // picture is not.
    if (item && item.constructionMethod !== 0) {
      plan.preserved.push({
        kind: infe.itemType === 'Exif' ? 'exif' : 'xmp',
        verdict: 'informational',
        offset: entry.box.start,
        length: entry.box.end - entry.box.start,
        label: `${infe.itemType} item — stored inside the file's own item data box`,
        preserved:
          'its bytes are addressed relative to another box, and cutting them would move ' +
          'every other item without a safe way to renumber them',
      })
      continue
    }

    dropped.add(infe.itemId)
    plan.drop.add(entry.box.start)

    const first = item?.extents[0]
    const total = (item?.extents ?? []).reduce((sum, extent) => sum + extent.length, 0)
    const isExif = infe.itemType === 'Exif'
    // The XMP packet is the one worth reading back: it is where a "generated
    // by" claim lives, and quoting it is the difference between "an XMP packet
    // was here" and naming what put it there.
    const packet =
      isExif || !first ? '' : decodeUtf8(bytes.subarray(first.offset, first.offset + first.length))
    const tool = /<(?:xmp:CreatorTool|tiff:Software|dc:creator)>([^<]+)</i.exec(packet)?.[1]

    plan.findings.push({
      kind: isExif ? 'exif' : 'xmp',
      verdict: isExif ? 'informational' : 'probable',
      offset: first?.offset ?? entry.box.start,
      length: total || entry.box.end - entry.box.start,
      label: isExif
        ? 'Exif item — EXIF block'
        : `mime item — XMP packet${infe.contentType ? ` (${infe.contentType})` : ''}`,
      ...(tool ? { evidence: snippet(tool) } : {}),
    })

    if (item) {
      for (const extent of item.extents) {
        if (extent.length === 0) continue
        plan.holes.push({
          start: item.baseOffset + extent.offset,
          end: item.baseOffset + extent.offset + extent.length,
        })
      }
    }
  }

  if (dropped.size === 0) return plan

  plan.holes.sort((a, b) => a.start - b.start)
  for (let i = 1; i < plan.holes.length; i += 1) {
    if ((plan.holes[i]?.start ?? 0) < (plan.holes[i - 1]?.end ?? 0)) {
      plan.blocker = 'two items claim the same bytes, so neither can be cut out safely'
      return plan
    }
  }

  if (ilocBox && iloc) {
    iloc.items = iloc.items.filter((item) => !dropped.has(item.itemId))
    const body = writeIloc(iloc)
    plan.replace.set(
      ilocBox.start,
      concat([rewriteHeader(bytes, ilocBox, headerLength(ilocBox) + body.length), body]),
    )
  }

  // The `iref` version decides how wide the item ids inside its children are,
  // and the children have no version field of their own to say so.
  const irefBox = found.find((entry) => entry.box.type === 'iref')?.box
  const irefVersion = irefBox ? (bytes[irefBox.body] ?? 0) : 0

  for (const entry of found) {
    if (entry.box.type === 'ipma') {
      const body = rewriteIpma(bytes, entry.box, dropped)
      if (body) {
        plan.replace.set(
          entry.box.start,
          concat([rewriteHeader(bytes, entry.box, headerLength(entry.box) + body.length), body]),
        )
      }
    }
    if (entry.parent === 'iref') {
      const replacement = rewriteIrefEntry(bytes, entry.box, irefVersion, dropped)
      if (replacement) {
        if (replacement.length === 0) plan.drop.add(entry.box.start)
        else plan.replace.set(entry.box.start, replacement)
      }
    }
  }

  return plan
}
