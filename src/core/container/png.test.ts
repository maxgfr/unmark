import { describe, expect, it } from 'vitest'
import { cleanPng, sniffPng } from './png.ts'
import { png, textChunkData } from '../../test/containers.ts'
import { concat, encode } from './types.ts'

const kinds = (bytes: Uint8Array) => cleanPng(bytes).findings.map((f) => f.kind)

describe('sniffPng', () => {
  it('recognises a PNG by its signature, not its extension', () => {
    expect(sniffPng(png())).toBe(true)
    expect(sniffPng(encode('not a png'))).toBe(false)
    expect(sniffPng(new Uint8Array())).toBe(false)
  })
})

describe('cleanPng', () => {
  it('leaves a file with no metadata byte-identical', () => {
    // The strongest property this module has: touching nothing means the pixels
    // come out exactly as they went in, with no re-encode in the middle.
    const clean = png()
    expect([...cleanPng(clean).output]).toEqual([...clean])
    expect(cleanPng(clean).findings).toEqual([])
  })

  it('removes a text chunk and reports its keyword and value', () => {
    const marked = png([{ type: 'tEXt', data: textChunkData('Software', 'SomeGenerator 3.1') }])
    const result = cleanPng(marked)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ kind: 'text_chunk' })
    expect(result.findings[0]?.label).toContain('Software')
    expect(result.findings[0]?.evidence).toBe('SomeGenerator 3.1')
    expect(result.output.length).toBeLessThan(marked.length)
  })

  it('calls a C2PA manifest confirmed', () => {
    // Unlike an EXIF timestamp, a signed provenance manifest is not something a
    // camera left behind by accident.
    const result = cleanPng(png([{ type: 'caBX', data: 'signed manifest bytes' }]))
    expect(result.findings[0]).toMatchObject({ kind: 'c2pa', verdict: 'confirmed' })
  })

  it('names an XMP packet as XMP rather than as a generic text chunk', () => {
    const xmp = textChunkData('XML:com.adobe.xmp', '<x:xmpmeta>...</x:xmpmeta>')
    expect(kinds(png([{ type: 'iTXt', data: xmp }]))).toEqual(['xmp'])
  })

  it('keeps the colour profile', () => {
    // iCCP is not provenance. Dropping it changes how the image renders, which
    // is precisely the thing a metadata strip must not do.
    const withProfile = png([{ type: 'iCCP', data: 'profile' }])
    expect([...cleanPng(withProfile).output]).toEqual([...withProfile])
  })

  it('strips several chunks at once and keeps the image data', () => {
    const marked = png([
      { type: 'tEXt', data: textChunkData('Comment', 'hello') },
      { type: 'eXIf', data: 'exif bytes' },
      { type: 'caBX', data: 'c2pa' },
    ])
    const result = cleanPng(marked)
    expect(kinds(marked)).toEqual(['text_chunk', 'exif', 'c2pa'])
    expect([...result.output]).toEqual([...png()])
  })

  it('is idempotent — a second pass finds nothing', () => {
    const once = cleanPng(png([{ type: 'tEXt', data: textChunkData('a', 'b') }]))
    const twice = cleanPng(once.output)
    expect(twice.findings).toEqual([])
    expect([...twice.output]).toEqual([...once.output])
  })

  it('does not walk off the end of a truncated file', () => {
    const truncated = png([{ type: 'tEXt', data: textChunkData('a', 'b') }]).subarray(0, 30)
    expect(() => cleanPng(truncated)).not.toThrow()
  })

  it('does not read a chunk whose declared length overruns the file', () => {
    // A hostile or corrupt length field must not turn into an out-of-bounds
    // read that silently returns half a file.
    const good = png()
    const broken = concat([good.subarray(0, 8), new Uint8Array([0x7f, 0xff, 0xff, 0xff])])
    expect(() => cleanPng(broken)).not.toThrow()
  })
})
