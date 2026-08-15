import { describe, expect, it } from 'vitest'
import { deflate, deflateRaw, inflate, inflateRaw } from './flate.ts'
import { encode, decodeUtf8 } from './types.ts'

const SAMPLE = encode('the same sentence, repeated, '.repeat(40))

describe('raw deflate', () => {
  it('round-trips the bytes it was given', async () => {
    expect([...(await inflateRaw(await deflateRaw(SAMPLE)))]).toEqual([...SAMPLE])
  })

  it('refuses a zlib-wrapped stream, which is what makes the two functions distinct', async () => {
    // If the raw decoder quietly accepted the wrapped form there would be no
    // reason for `inflate` to exist, and no way to notice the wrapper is wrong.
    await expect(inflateRaw(await deflate(SAMPLE))).rejects.toThrow()
  })
})

describe('inflate', () => {
  it('reads the zlib-wrapped form the spec asks for', async () => {
    expect(decodeUtf8(await inflate(await deflate(SAMPLE)))).toBe(decodeUtf8(SAMPLE))
  })

  it('falls back to raw deflate when the zlib header is not there', async () => {
    // The reason the fallback exists: PDFs in the wild carry raw deflate under
    // the /FlateDecode name, and a reader without this refuses files Acrobat
    // opens without complaint.
    expect(decodeUtf8(await inflate(await deflateRaw(SAMPLE)))).toBe(decodeUtf8(SAMPLE))
  })

  it('still fails on bytes that are neither', async () => {
    // The fallback must not become "never report a broken stream". A corrupt
    // stream has to reach the caller so the PDF path can fall back honestly
    // rather than write out an empty object.
    await expect(inflate(encode('this is not compressed at all'))).rejects.toThrow()
  })

  it('handles a stored deflate block, which carries no compressed data at all', async () => {
    // Test fixtures build their streams this way — a valid deflate stream with
    // BTYPE 00 — so this path has to work or every PDF fixture is untestable.
    // zlib header, one final stored block holding 'hi', adler-32.
    const stored = new Uint8Array([
      0x78, 0x01, 0x01, 0x02, 0x00, 0xfd, 0xff, 0x68, 0x69, 0x01, 0x3b, 0x00, 0xd2,
    ])
    expect(decodeUtf8(await inflate(stored))).toBe('hi')
  })
})
