// ISOBMFF: HEIC, AVIF, MP4 and MOV are one format wearing four brands.
//
// This file is the policy — what counts as provenance, what is refused, and how
// a rewritten tree is put back together. The format itself is next door: the box
// walker and the two size escapes in `boxes.ts`, the item machinery a HEIC hangs
// its picture on in `heif.ts`, the tags and timestamps a movie carries in
// `movie.ts`.
//
// Deleting a box is never the whole job. Every ancestor's size field counts the
// bytes it contains, so a four-byte tag removed six levels down changes six
// sizes. Worse, two tables hold absolute byte offsets into the file: `stco` and
// `co64` point at the media chunks inside `mdat`, and `iloc` points at every
// item of a HEIC or an AVIF. Remove anything ahead of them and both are wrong.
// So this pass records every range it cut and re-points those tables afterwards.
//
// Where that cannot be done safely it does nothing at all. A fragmented file
// carries offsets in `moof`, `sidx`, `saio` and `mfra` that this pass does not
// rewrite, so such a file comes back untouched with the reason attached. An
// honest refusal beats a plausible video that no longer plays.
//
// What survives is as deliberate as what goes. `ipco` holds the picture's
// properties and `ipma` associates them *by index*, so dropping one property box
// would silently renumber every association after it — `colr`, `ispe`, `pixi`,
// `av1C` and `hvcC` all stay, and `mdat` is never rewritten except to cut out
// the bytes of an item that is going away. `colr` is still reported: an embedded
// ICC profile outlives an EXIF strip and its description names whoever wrote
// the file.

import { byPosition, type Finding } from '../../report.ts'
import { ascii, concat, decodeUtf8, readU32, snippet, type ContainerResult } from '../types.ts'
import {
  collect,
  containerChildren,
  headerLength,
  readBox,
  rewriteHeader,
  writeUint,
  type Box,
  type Found,
  type Range,
} from './boxes.ts'
import { planItems, repointIloc } from './heif.ts'
import { blankTimestamps, classifyTag, parseKeys, repointChunks } from './movie.ts'

// ----------------------------------------------------------------- sniffing

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1'])
const MP4_BRANDS = new Set(['isom', 'mp42', 'qt  ', 'M4V '])

/**
 * Which of the three a file is, from the `ftyp` box every one of them opens with.
 *
 * The compatible brands matter as much as the major one, and AVIF is tested
 * first because an AVIF declares `mif1` alongside `avif` — HEIC's brand. Asking
 * "is it HEIC?" first would answer yes for every AVIF in existence.
 */
export function sniffIsobmff(bytes: Uint8Array): 'HEIC' | 'AVIF' | 'MP4' | undefined {
  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') return undefined

  const declared = readU32(bytes, 0) >>> 0
  const end = declared >= 16 && declared <= bytes.length ? declared : Math.min(bytes.length, 12)
  const brands = [ascii(bytes, 8, 4)]
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, 4))

  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'AVIF'
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'HEIC'
  if (brands.some((brand) => MP4_BRANDS.has(brand))) return 'MP4'
  return undefined
}

// ----------------------------------------------------------- what comes out

/** C2PA's own box UUID, from the C2PA specification's BMFF binding. */
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481'
/** Adobe's UUID for an XMP packet carried in an ISOBMFF file. */
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac'

/**
 * Structures whose byte offsets this pass does not rewrite.
 *
 * `moof` fragments carry a base data offset, `sidx` indexes segments by size
 * from its own end, `saio` points at per-sample auxiliary data and `mfra`
 * indexes fragments by absolute offset. Correcting all four means understanding
 * far more of the file than a metadata strip needs to, so their presence turns
 * a pass that would move bytes into a refusal instead.
 */
const FRAGILE = new Set(['moof', 'sidx', 'saio', 'mfra'])

/** Printable runs inside a binary blob, so a report can quote what named the writer. */
function printableRuns(data: Uint8Array, minimum = 6): string[] {
  const runs: string[] = []
  let current = ''
  for (const byte of data) {
    if (byte >= 0x20 && byte < 0x7f) current += String.fromCharCode(byte)
    else {
      if (current.length >= minimum) runs.push(current)
      current = ''
    }
  }
  if (current.length >= minimum) runs.push(current)
  return runs
}

/**
 * What a box is, or undefined to copy it through untouched.
 *
 * A finding that carries `preserved` is one to report and leave alone; anything
 * else is on its way out. `colr` is the only entry matched in order to be kept:
 * removing it changes how the picture renders, but when it holds a full ICC
 * profile rather than a handful of coefficients, that profile's description
 * names whoever wrote the file and outlives every EXIF strip.
 */
function classify(
  bytes: Uint8Array,
  box: Box,
  parent: string,
  keys: readonly string[],
): Finding | undefined {
  const at = { offset: box.start, length: box.end - box.start }

  if (box.type === 'uuid') {
    if (box.uuid === C2PA_UUID) {
      return { kind: 'c2pa', verdict: 'confirmed', ...at, label: 'uuid — C2PA manifest' }
    }
    if (box.uuid === XMP_UUID) {
      const packet = decodeUtf8(bytes.subarray(box.body, box.end))
      const tool = /<(?:xmp:CreatorTool|tiff:Software|dc:creator)>([^<]+)</i.exec(packet)?.[1]
      return {
        kind: 'xmp',
        verdict: 'probable',
        ...at,
        label: 'uuid — XMP packet',
        ...(tool ? { evidence: snippet(tool) } : {}),
      }
    }
    return undefined
  }

  // JUMBF is the box C2PA signs its manifest into when it is not using a UUID.
  if (box.type === 'jumb') {
    return { kind: 'c2pa', verdict: 'confirmed', ...at, label: 'jumb — JUMBF / C2PA provenance' }
  }

  if (box.type === 'colr') {
    const profile = ascii(bytes, box.body, 4)
    const strings = printableRuns(bytes.subarray(box.body + 4, box.end)).slice(0, 3)
    return {
      kind: 'generator_tag',
      verdict: 'informational',
      ...at,
      label: `colr — colour profile (${profile})`,
      ...(strings.length > 0 ? { evidence: snippet(strings.join(' · ')) } : {}),
      preserved: 'a colour profile, not provenance — removing it changes the rendering',
    }
  }

  return classifyTag(bytes, box, parent, keys)
}

// ------------------------------------------------------------- the rebuild

interface Plan {
  bytes: Uint8Array
  findings: Finding[]
  preserved: Finding[]
  /** Boxes to remove outright, by the offset their header starts at. */
  drop: Set<number>
  /** Boxes to emit as different bytes: a pruned `iloc`, `ipma` or reference entry. */
  replace: Map<number, Uint8Array>
  /** Item payload ranges to cut out of whichever leaf contains them. */
  holes: Range[]
  /** The key names each `meta` box declares, by that box's own offset. */
  keysByMeta: Map<number, string[]>
  /** Every range actually removed from the original file, in original coordinates. */
  removed: Range[]
  /** How many holes the rebuild found a home for, so an orphan can be caught. */
  holesCut: number
  /** Set to the reason when the file has to come back untouched. */
  blocker: string
}

interface Rebuilt {
  parts: Uint8Array[]
  length: number
  /** Boxes emitted, so `iinf` can rewrite the count it keeps of its children. */
  count: number
  /**
   * Whether anything in here came out different.
   *
   * Not the same question as "did the length change": a blanked timestamp is
   * the same number of bytes, and a parent that compared lengths would decide
   * nothing had happened and hand back the original bytes, throwing the edit
   * away at every level on the way up.
   */
  changed: boolean
}

function rebuild(
  plan: Plan,
  start: number,
  end: number,
  parent: string,
  keys: readonly string[],
): Rebuilt {
  const bytes = plan.bytes
  const parts: Uint8Array[] = []
  let length = 0
  let count = 0
  let changed = false
  const push = (part: Uint8Array) => {
    parts.push(part)
    length += part.length
  }

  let at = start
  while (at < end) {
    const box = readBox(bytes, at, end)
    if (!box || box.end <= at) break

    if (plan.drop.has(box.start)) {
      plan.removed.push({ start: box.start, end: box.end })
      changed = true
      at = box.end
      continue
    }

    const finding = classify(bytes, box, parent, keys)
    if (finding) {
      if (finding.preserved) {
        plan.preserved.push(finding)
      } else {
        plan.findings.push(finding)
        plan.removed.push({ start: box.start, end: box.end })
        changed = true
        at = box.end
        continue
      }
    }

    const replacement = plan.replace.get(box.start)
    if (replacement) {
      // A pruned table loses bytes from the middle, but nothing in the file
      // points into one, so for the purpose of shifting later offsets the loss
      // is booked at the box's tail. What matters is only how many bytes are
      // gone before whatever comes next.
      plan.removed.push({ start: box.start + replacement.length, end: box.end })
      push(replacement)
      changed = true
      count += 1
      at = box.end
      continue
    }

    const children = containerChildren(bytes, box)
    if (children === undefined) {
      const rewritten = rewriteLeaf(plan, box)
      push(rewritten ?? bytes.subarray(box.start, box.end))
      if (rewritten) changed = true
    } else {
      // A `meta` box brings its own key table, which its `ilst` sibling names
      // its tags by. Anything else passes down whatever it was given.
      const inner = rebuild(
        plan,
        children,
        box.end,
        box.type,
        box.type === 'meta' ? (plan.keysByMeta.get(box.start) ?? keys) : keys,
      )
      if (inner.changed) {
        const prefix = bytes.slice(box.body, children)
        if (box.type === 'iinf') writeUint(prefix, 4, prefix.length - 4, inner.count)
        push(rewriteHeader(bytes, box, headerLength(box) + prefix.length + inner.length))
        push(prefix)
        for (const part of inner.parts) push(part)
        changed = true
      } else {
        // Nothing below this box came out different, so hand back the original
        // bytes. That is what makes a file with nothing to strip come out byte
        // for byte the same, including any 64-bit or run-to-the-end size field.
        push(bytes.subarray(box.start, box.end))
      }
    }

    count += 1
    at = box.end
  }

  // A truncated or unparseable tail is still the user's file: copy it rather
  // than silently returning something shorter.
  if (at < end) push(bytes.subarray(at, end))
  return { parts, length, count, changed }
}

/**
 * A leaf that has to come out different, or nothing when it does not.
 *
 * Two reasons it might: an item's bytes sit inside it and are being cut out, or
 * it is a header whose timestamps are being blanked. The second keeps its length.
 */
function rewriteLeaf(plan: Plan, box: Box): Uint8Array | undefined {
  const bytes = plan.bytes
  const holes = plan.holes.filter((hole) => hole.start >= box.body && hole.end <= box.end)

  if (holes.length === 0) {
    const stamps = blankTimestamps(bytes, box)
    if (!stamps) return undefined
    plan.findings.push(stamps.finding)
    return stamps.patched
  }

  const pieces: Uint8Array[] = []
  let cursor = box.body
  for (const hole of holes) {
    pieces.push(bytes.subarray(cursor, hole.start))
    cursor = hole.end
    plan.removed.push(hole)
    plan.holesCut += 1
  }
  pieces.push(bytes.subarray(cursor, box.end))

  const body = concat(pieces)
  return concat([rewriteHeader(bytes, box, headerLength(box) + body.length), body])
}

/** Walk the finished file and move every stored offset to where its bytes went. */
function repoint(plan: Plan, out: Uint8Array, start: number, end: number): void {
  let at = start
  while (at < end && !plan.blocker) {
    const box = readBox(out, at, end)
    if (!box || box.end <= at) break
    if (box.type === 'stco' || box.type === 'co64') {
      plan.blocker = repointChunks(out, box, plan.removed)
    } else if (box.type === 'iloc') {
      plan.blocker = repointIloc(out, box, plan.removed)
    } else {
      const children = containerChildren(out, box)
      if (children !== undefined) repoint(plan, out, children, box.end)
    }
    at = box.end
  }
}

// ------------------------------------------------------------------- entry

/** Everything that was going to be removed, reported as kept, with the reason. */
function refuse(plan: Plan, reason: string): ContainerResult {
  const headline: Finding = {
    kind: 'doc_property',
    verdict: 'informational',
    offset: 0,
    length: 0,
    label: 'File returned unchanged — it could not be rewritten safely',
    evidence: reason,
    preserved: reason,
  }
  // Only the findings that were on their way out get the refusal attached.
  // Anything already in `preserved` was never going to be removed, and saying
  // it survived for this reason would be the wrong explanation.
  const preserved: Finding[] = [headline, ...plan.preserved]
  for (const finding of plan.findings) {
    preserved.push({ ...finding, preserved: `not removed: ${reason}` })
  }
  return { output: plan.bytes, findings: [], preserved: preserved.sort(byPosition) }
}

export function cleanIsobmff(bytes: Uint8Array): ContainerResult {
  const found: Found[] = []
  collect(bytes, 0, bytes.length, '', 0, found)
  const items = planItems(bytes, found)

  const plan: Plan = {
    bytes,
    findings: items.findings,
    preserved: items.preserved,
    drop: items.drop,
    replace: items.replace,
    holes: items.holes,
    keysByMeta: new Map(),
    removed: [],
    holesCut: 0,
    blocker: items.blocker,
  }
  if (plan.blocker) return refuse(plan, plan.blocker)

  for (const entry of found) {
    if (entry.box.type === 'keys') {
      plan.keysByMeta.set(entry.parentStart, parseKeys(bytes, entry.box))
    }
  }

  const rebuilt = rebuild(plan, 0, bytes.length, '', [])

  if (!rebuilt.changed) {
    // Nothing came out different, so the answer is the input itself — byte for
    // byte, including any 64-bit or run-to-the-end size field.
    return { output: bytes, findings: [], preserved: plan.preserved.sort(byPosition) }
  }

  // Only a rewrite that moves bytes can invalidate a stored offset. Blanking a
  // timestamp in place cannot, so it stays available in files this would refuse.
  if (plan.removed.length > 0) {
    if (found.some((entry) => FRAGILE.has(entry.box.type))) {
      return refuse(
        plan,
        'this file is fragmented or indexed, and carries byte offsets in boxes this pass ' +
          'does not rewrite (moof, sidx, saio, mfra)',
      )
    }
    if (plan.holesCut !== plan.holes.length) {
      return refuse(
        plan,
        "an item's bytes did not sit inside a single box, so they were left alone",
      )
    }
  }

  const output = concat(rebuilt.parts)
  if (plan.removed.length > 0) {
    plan.removed.sort((a, b) => a.start - b.start)
    repoint(plan, output, 0, output.length)
    if (plan.blocker) return refuse(plan, plan.blocker)
  }

  return {
    output,
    findings: plan.findings.sort(byPosition),
    preserved: plan.preserved.sort(byPosition),
  }
}
