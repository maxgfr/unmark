import { describe, expect, it } from 'vitest'
import { decodeCbor, field, isTagged, list, text } from './cbor.ts'
import { cbor } from '../../test/c2pa.ts'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('decodeCbor', () => {
  it('reads integers of every width, and negatives', () => {
    expect(decodeCbor(bytes(0x17))).toBe(23)
    expect(decodeCbor(bytes(0x18, 0xff))).toBe(255)
    expect(decodeCbor(bytes(0x19, 0x01, 0x00))).toBe(256)
    expect(decodeCbor(bytes(0x1a, 0x80, 0x00, 0x00, 0x00))).toBe(2 ** 31)
    expect(decodeCbor(bytes(0x1b, 0, 0, 0, 1, 0, 0, 0, 0))).toBe(2 ** 32)
    expect(decodeCbor(bytes(0x26))).toBe(-7)
  })

  it('reads text, bytes, arrays and maps as written', () => {
    const value = decodeCbor(cbor({ action: 'c2pa.opened', n: [1, 2], raw: bytes(9) }))
    expect(text(field(value, 'action'))).toBe('c2pa.opened')
    expect(list(field(value, 'n'))).toEqual([1, 2])
    expect(field(value, 'raw')).toEqual(bytes(9))
  })

  it('keeps integer map keys as numbers, which is how COSE labels its headers', () => {
    const value = decodeCbor(cbor(new Map([[33, 'chain']])))
    expect(field(value, 33)).toBe('chain')
  })

  it('reads a tag and the value under it', () => {
    const value = decodeCbor(cbor({ tag: 18, value: [1] }))
    expect(isTagged(value) && value.tag).toBe(18)
  })

  it('reads simple values and the three float widths', () => {
    expect(decodeCbor(bytes(0xf4))).toBe(false)
    expect(decodeCbor(bytes(0xf5))).toBe(true)
    expect(decodeCbor(bytes(0xf6))).toBeNull()
    expect(decodeCbor(bytes(0xf7))).toBeUndefined()
    expect(decodeCbor(bytes(0xf9, 0x3c, 0x00))).toBe(1)
    expect(decodeCbor(bytes(0xf9, 0x7c, 0x00))).toBe(Number.POSITIVE_INFINITY)
    expect(decodeCbor(bytes(0xf9, 0x00, 0x01))).toBeCloseTo(5.96e-8)
    expect(decodeCbor(bytes(0xfa, 0x3f, 0xc0, 0x00, 0x00))).toBe(1.5)
    expect(decodeCbor(bytes(0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0))).toBe(1.5)
  })

  it('reads indefinite-length strings, arrays and maps', () => {
    // "ab" in two chunks, [1, 2], {"a": 1}
    expect(decodeCbor(bytes(0x7f, 0x61, 0x61, 0x61, 0x62, 0xff))).toBe('ab')
    expect(decodeCbor(bytes(0x5f, 0x41, 0x01, 0x41, 0x02, 0xff))).toEqual(bytes(1, 2))
    expect(decodeCbor(bytes(0x9f, 0x01, 0x02, 0xff))).toEqual([1, 2])
    expect(field(decodeCbor(bytes(0xbf, 0x61, 0x61, 0x01, 0xff)), 'a')).toBe(1)
  })

  it('throws on truncated or malformed input instead of inventing a value', () => {
    expect(() => decodeCbor(bytes(0x62, 0x61))).toThrow(/truncated/)
    expect(() => decodeCbor(bytes())).toThrow(/truncated/)
    expect(() => decodeCbor(bytes(0xff))).toThrow(/break/)
    expect(() => decodeCbor(bytes(0x1c))).toThrow(/reserved/)
    expect(() => decodeCbor(bytes(0x82, 0x01, 0xff))).toThrow(/break/)
    expect(() => decodeCbor(bytes(0x7f, 0x01, 0xff))).toThrow(/wrong type/)
  })

  it('refuses nesting deep enough to be hostile', () => {
    expect(() => decodeCbor(new Uint8Array(200).fill(0x81))).toThrow(/deeply/)
  })
})
