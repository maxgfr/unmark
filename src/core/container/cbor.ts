// CBOR, read only, and only as much of it as a C2PA manifest uses.
//
// C2PA writes its claim, its assertions and its COSE signature in CBOR. A
// report that says "C2PA manifest present" without opening it tells the reader
// that something stamped the file and not what: a camera, an editor, or an
// image generator. Those are three different answers, and the difference is in
// here.
//
// Deliberately small: no encoder, no canonical-form checks, no bignums beyond
// what a JavaScript number holds. A value this cannot read throws, and the
// caller treats a manifest it cannot decode as present-but-unread rather than
// as absent.

/** A decoded CBOR value. Maps keep their keys as written: text or integer. */
export type CborValue =
  null | undefined | boolean | number | string | Uint8Array | CborValue[] | CborMap | CborTagged

export type CborMap = Map<string | number, CborValue>

export interface CborTagged {
  tag: number
  value: CborValue
}

/** How deep a structure may nest before it is treated as hostile. */
const MAX_DEPTH = 64

const fail = (message: string): never => {
  throw new Error(`cbor: ${message}`)
}

class Reader {
  offset = 0
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  byte(): number {
    if (this.offset >= this.bytes.length) fail('truncated')
    return this.bytes[this.offset++] as number
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) fail('truncated')
    const out = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  /** The argument that follows an initial byte, or -1 for indefinite length. */
  argument(info: number): number {
    if (info < 24) return info
    if (info === 24) return this.byte()
    if (info === 25) return (this.byte() << 8) | this.byte()
    if (info === 26)
      return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0
    if (info === 27) {
      const high =
        ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0
      const low =
        ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0
      return high * 2 ** 32 + low
    }
    if (info === 31) return -1
    return fail(`reserved additional information ${info}`)
  }
}

function halfFloat(bits: number): number {
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  const sign = bits & 0x8000 ? -1 : 1
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

const BREAK = Symbol('break')

function read(reader: Reader, depth: number): CborValue | typeof BREAK {
  if (depth > MAX_DEPTH) fail('nested too deeply')
  const initial = reader.byte()
  const major = initial >> 5
  const info = initial & 0x1f

  if (major === 7) {
    if (info === 20) return false
    if (info === 21) return true
    if (info === 22) return null
    if (info === 23) return undefined
    if (info === 25) return halfFloat((reader.byte() << 8) | reader.byte())
    if (info === 26) return new DataView(reader.take(4).slice().buffer).getFloat32(0)
    if (info === 27) return new DataView(reader.take(8).slice().buffer).getFloat64(0)
    if (info === 31) return BREAK
    if (info === 24) return reader.byte()
    return info
  }

  const argument = reader.argument(info)

  switch (major) {
    case 0: {
      return argument
    }
    case 1: {
      return -1 - argument
    }
    case 2:
    case 3: {
      let data: Uint8Array
      if (argument === -1) {
        const parts: Uint8Array[] = []
        for (;;) {
          const part = read(reader, depth + 1)
          if (part === BREAK) break
          if (major === 2 && part instanceof Uint8Array) parts.push(part)
          else if (major === 3 && typeof part === 'string')
            parts.push(new TextEncoder().encode(part))
          else fail('indefinite string chunk of the wrong type')
        }
        const total = parts.reduce((sum, part) => sum + part.length, 0)
        data = new Uint8Array(total)
        let at = 0
        for (const part of parts) {
          data.set(part, at)
          at += part.length
        }
      } else {
        data = reader.take(argument)
      }
      return major === 2 ? data : new TextDecoder('utf-8', { fatal: false }).decode(data)
    }
    case 4: {
      const items: CborValue[] = []
      for (let index = 0; argument === -1 || index < argument; index += 1) {
        const item = read(reader, depth + 1)
        if (item === BREAK) {
          if (argument === -1) break
          fail('unexpected break')
        }
        items.push(item as CborValue)
      }
      return items
    }
    case 5: {
      const map: CborMap = new Map()
      for (let index = 0; argument === -1 || index < argument; index += 1) {
        const key = read(reader, depth + 1)
        if (key === BREAK) {
          if (argument === -1) break
          fail('unexpected break')
        }
        const value = read(reader, depth + 1)
        if (value === BREAK) fail('map without a value')
        // A key that is neither text nor an integer is legal CBOR and never
        // used by C2PA. It is kept under its printed form rather than dropped.
        const name = typeof key === 'string' || typeof key === 'number' ? key : String(key)
        map.set(name, value as CborValue)
      }
      return map
    }
    case 6: {
      const value = read(reader, depth + 1)
      if (value === BREAK) fail('tag without a value')
      return { tag: argument, value: value as CborValue }
    }
    default: {
      return fail(`major type ${major}`)
    }
  }
}

/** Decode one CBOR item from the start of `bytes`. Throws on anything malformed. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const value = read(new Reader(bytes), 0)
  if (value === BREAK) fail('unexpected break')
  return value as CborValue
}

// ------------------------------------------------------------- access helpers

export const isCborMap = (value: CborValue): value is CborMap => value instanceof Map

export const isTagged = (value: CborValue): value is CborTagged =>
  typeof value === 'object' &&
  value !== null &&
  !(value instanceof Map) &&
  !(value instanceof Uint8Array) &&
  !Array.isArray(value)

/** A field of a map, or undefined when the value is not a map or has no such key. */
export const field = (value: CborValue, key: string | number): CborValue =>
  isCborMap(value) ? value.get(key) : undefined

export const text = (value: CborValue): string | undefined =>
  typeof value === 'string' ? value : undefined

export const list = (value: CborValue): CborValue[] => (Array.isArray(value) ? value : [])
