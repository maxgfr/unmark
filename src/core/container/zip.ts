// A minimal ZIP reader and writer, built on the platform's own deflate.
//
// DOCX, XLSX, PPTX and ODT are all zip archives, so reaching them normally
// means taking on a zip library. `DecompressionStream('deflate-raw')` has been
// in every browser and in Node since 18, which makes that dependency avoidable
// — and avoiding it is what lets the whole core ship as one file the Claude
// skill can run with nothing installed.
//
// Deliberately partial: no encryption, no ZIP64, no multi-disk. Those exist in
// the wild but not in the office documents this handles, and a reader that
// silently mishandles them would be worse than one that declines.
//
// Awaiting inside loops is the shape of this file, not an oversight: a stream
// yields one chunk at a time, and every local header offset is the running
// total of the entries written before it. Nothing here can be parallelised.
// oxlint-disable no-await-in-loop

import { ascii, concat, encode, readU32LE, type ContainerResult } from './types.ts'
import { crc32 } from './crc32.ts'

export interface ZipEntry {
  name: string
  data: Uint8Array
  /** ODF requires its `mimetype` entry to be stored, not deflated, and first. */
  stored?: boolean
}

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const EOCD = 0x06054b50

const readU16LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)

const u16 = (value: number) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff])
const u32 = (value: number) =>
  new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])

async function collect(readable: ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  // Sequential by nature: a stream is read one chunk at a time.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value as Uint8Array)
  }
  return concat(chunks)
}

/**
 * Push bytes through a compression stream and collect the result.
 *
 * Written against the stream's two halves rather than `pipeThrough` because the
 * pair's writable side is typed as accepting BufferSource, which does not line
 * up with a `ReadableStream<Uint8Array>` source under TypeScript's generic
 * Uint8Array. Reading starts before the write so a large entry cannot deadlock
 * against the stream's own backpressure.
 */
function through(
  bytes: Uint8Array,
  transform: { readable: ReadableStream; writable: WritableStream },
): Promise<Uint8Array> {
  const collected = collect(transform.readable)
  const writer = transform.writable.getWriter()
  return writer
    .write(bytes)
    .then(() => writer.close())
    .then(() => collected)
}

const inflateRaw = (bytes: Uint8Array) => through(bytes, new DecompressionStream('deflate-raw'))
const deflateRaw = (bytes: Uint8Array) => through(bytes, new CompressionStream('deflate-raw'))

export const sniffZip = (bytes: Uint8Array) =>
  bytes.length > 4 && readU32LE(bytes, 0) === LOCAL_HEADER

/** Locate the end-of-central-directory record, which is the only fixed anchor. */
function findEocd(bytes: Uint8Array): number {
  // It sits at the very end unless there is an archive comment, which is capped
  // at 64 KiB by the format.
  const floor = Math.max(0, bytes.length - 0xffff - 22)
  for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
    if (readU32LE(bytes, offset) === EOCD) return offset
  }
  return -1
}

export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const eocd = findEocd(bytes)
  if (eocd === -1) throw new Error('not a zip archive: no end-of-central-directory record')

  const count = readU16LE(bytes, eocd + 10)
  let offset = readU32LE(bytes, eocd + 16)
  const entries: ZipEntry[] = []

  // Sequential on purpose: entries are inflated one at a time so a corrupt
  // central directory stops the walk instead of racing ahead of it.
  for (let i = 0; i < count; i += 1) {
    if (readU32LE(bytes, offset) !== CENTRAL_HEADER) break

    const method = readU16LE(bytes, offset + 10)
    const compressedSize = readU32LE(bytes, offset + 20)
    const nameLength = readU16LE(bytes, offset + 28)
    const extraLength = readU16LE(bytes, offset + 30)
    const commentLength = readU16LE(bytes, offset + 32)
    const localOffset = readU32LE(bytes, offset + 42)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))

    // The local header repeats the name and extra-field lengths, and they are
    // allowed to differ from the central directory's. The data starts after
    // the local copy, so that is the one to trust.
    const localNameLength = readU16LE(bytes, localOffset + 26)
    const localExtraLength = readU16LE(bytes, localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(start, start + compressedSize)

    entries.push({
      name,
      data: method === 8 ? await inflateRaw(raw) : raw.slice(),
      stored: method === 0,
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

export async function writeZip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  // Sequential by necessity: each local header offset is the running total of
  // every entry written before it.
  for (const entry of entries) {
    const name = encode(entry.name)
    const checksum = crc32(entry.data)
    const deflate = !entry.stored
    const payload = deflate ? await deflateRaw(entry.data) : entry.data
    const method = deflate ? 8 : 0

    const header = concat([
      u32(LOCAL_HEADER),
      u16(20),
      u16(0),
      u16(method),
      u16(0), // time: zeroed on purpose — a timestamp is metadata too
      u16(0x21), // date: 1980-01-01, the format's own epoch
      u32(checksum),
      u32(payload.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
    ])
    locals.push(header, payload)

    centrals.push(
      concat([
        u32(CENTRAL_HEADER),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0x21),
        u32(checksum),
        u32(payload.length),
        u32(entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    )
    offset += header.length + payload.length
  }

  const central = concat(centrals)
  return concat([
    ...locals,
    central,
    concat([
      u32(EOCD),
      u16(0),
      u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(central.length),
      u32(offset),
      u16(0),
    ]),
  ])
}

/** Which flavour of zipped document this is, or undefined if it is neither. */
export function zipDocumentKind(entries: readonly ZipEntry[]): 'ooxml' | 'odf' | undefined {
  const names = new Set(entries.map((entry) => entry.name))
  if (names.has('[Content_Types].xml')) return 'ooxml'

  const mimetype = entries.find((entry) => entry.name === 'mimetype')
  if (mimetype && ascii(mimetype.data, 0, 40).includes('opendocument')) return 'odf'
  return undefined
}

export type { ContainerResult }
