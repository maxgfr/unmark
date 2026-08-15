import { describe, expect, it } from 'vitest'
import { cleanIsobmff, sniffIsobmff } from './index.ts'
import {
  avif,
  box,
  bytes as raw,
  C2PA_BOX_UUID,
  heic,
  jpeg,
  mp4,
  png,
  webp,
  XMP_BOX_UUID,
} from '../../../test/containers.ts'
import { ascii, concat, decodeUtf8, encode, readU32 } from '../types.ts'

// A second, deliberately independent box walker. Asserting against the same
// parser the code under test uses would only prove it is self-consistent; this
// one re-derives every size from the bytes and reports what does not add up.

const NESTED = new Set([
  'moov',
  'trak',
  'udta',
  'meta',
  'iprp',
  'ipco',
  'mdia',
  'minf',
  'stbl',
  'ilst',
  'edts',
  'iinf',
  'iref',
])

interface Seen {
  type: string
  start: number
  end: number
  depth: number
  /** Bytes inside a container that its children did not account for. Should be 0. */
  slack: number
}

const u16 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)

/** Whether a whole box starts here — the same question `meta`'s two layouts pose. */
function boxStartsAt(bytes: Uint8Array, at: number, limit: number): boolean {
  if (at + 8 > limit) return false
  const size = readU32(bytes, at) >>> 0
  if (size < 8 || at + size > limit) return false
  return [...bytes.subarray(at + 4, at + 8)].every((byte) => byte >= 0x20 && byte < 0x7f)
}

function walk(bytes: Uint8Array, start: number, end: number, depth: number, into: Seen[]): number {
  let at = start
  while (at + 8 <= end) {
    const declared = readU32(bytes, at) >>> 0
    const type = ascii(bytes, at + 4, 4)
    let header = 8
    let size = declared
    if (declared === 1) {
      size = (readU32(bytes, at + 8) >>> 0) * 2 ** 32 + (readU32(bytes, at + 12) >>> 0)
      header = 16
    } else if (declared === 0) {
      size = end - at
    }
    if (type === 'uuid') header += 16
    if (size < header || at + size > end) break

    const entry: Seen = { type, start: at, end: at + size, depth, slack: 0 }
    into.push(entry)

    if (NESTED.has(type)) {
      let children = at + header
      if (type === 'meta' && !boxStartsAt(bytes, children, at + size)) children += 4
      if (type === 'iinf') children += 4 + ((bytes[children] ?? 0) === 0 ? 2 : 4)
      if (type === 'iref') children += 4
      entry.slack = at + size - walk(bytes, children, at + size, depth + 1, into)
    }
    at += size
  }
  return at
}

const tree = (bytes: Uint8Array): Seen[] => {
  const into: Seen[] = []
  walk(bytes, 0, bytes.length, 0, into)
  return into
}

function find(bytes: Uint8Array, type: string): Seen {
  const box = tree(bytes).find((entry) => entry.type === type)
  if (!box) throw new Error(`no ${type} box in this file`)
  return box
}

/** The fixture writes `iloc` version 1 with four-byte offsets and lengths and no base. */
function itemExtents(bytes: Uint8Array): { itemId: number; offset: number; length: number }[] {
  const iloc = find(bytes, 'iloc')
  let at = iloc.start + 8 + 4 + 2 // header, version and flags, the two size nibble bytes
  const count = u16(bytes, at)
  at += 2

  const items: { itemId: number; offset: number; length: number }[] = []
  for (let i = 0; i < count; i += 1) {
    const itemId = u16(bytes, at)
    const extents = u16(bytes, at + 6)
    at += 8
    for (let j = 0; j < extents; j += 1) {
      items.push({
        itemId,
        offset: readU32(bytes, at) >>> 0,
        length: readU32(bytes, at + 4) >>> 0,
      })
      at += 8
    }
  }
  return items
}

/** What `stco` says the single chunk of media sits at. */
const chunkOffset = (bytes: Uint8Array): number =>
  readU32(bytes, find(bytes, 'stco').start + 8 + 4 + 4) >>> 0

function putU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff
  bytes[at + 1] = (value >>> 16) & 0xff
  bytes[at + 2] = (value >>> 8) & 0xff
  bytes[at + 3] = value & 0xff
}

const itemAt = (bytes: Uint8Array, index: number): string => {
  const extent = itemExtents(bytes)[index]
  if (!extent) throw new Error('no such item')
  return decodeUtf8(bytes.subarray(extent.offset, extent.offset + extent.length))
}

const mdatBody = (bytes: Uint8Array): string => {
  const mdat = find(bytes, 'mdat')
  const header = readU32(bytes, mdat.start) >>> 0 === 1 ? 16 : 8
  return decodeUtf8(bytes.subarray(mdat.start + header, mdat.end))
}

const EXIF = 'Exif\0\0Canon EOS, 2026-08-14, 48.8566N 2.3522E'
const XMP = '<x:xmpmeta><xmp:CreatorTool>Sora 2</xmp:CreatorTool></x:xmpmeta>'

describe('sniffIsobmff', () => {
  it('names each brand from the ftyp box', () => {
    expect(sniffIsobmff(heic())).toBe('HEIC')
    expect(sniffIsobmff(avif())).toBe('AVIF')
    expect(sniffIsobmff(mp4())).toBe('MP4')
    expect(sniffIsobmff(mp4({ brand: 'qt  ', compatible: ['qt  '] }))).toBe('MP4')
    expect(sniffIsobmff(mp4({ brand: 'M4V ', compatible: ['M4V ', 'mp42'] }))).toBe('MP4')
  })

  it('reads the compatible brands, not only the major one', () => {
    const file = mp4({ brand: 'mp41', compatible: ['mp41', 'isom'] })
    expect(sniffIsobmff(file)).toBe('MP4')
  })

  it('calls a file AVIF when it claims both AVIF and HEIC brands', () => {
    // Every AVIF in existence declares `mif1`, which is HEIC's brand too.
    // Asking "is it HEIC?" first would answer yes for all of them.
    expect(sniffIsobmff(avif())).toBe('AVIF')
    expect(sniffIsobmff(heic())).toBe('HEIC')
  })

  it('does not claim a PNG, a JPEG, a WebP or plain text', () => {
    expect(sniffIsobmff(png())).toBeUndefined()
    expect(sniffIsobmff(jpeg())).toBeUndefined()
    expect(sniffIsobmff(webp())).toBeUndefined()
    expect(sniffIsobmff(encode('hello'))).toBeUndefined()
    expect(sniffIsobmff(new Uint8Array())).toBeUndefined()
  })

  it('does not claim an ISOBMFF file whose brands mean nothing to it', () => {
    expect(sniffIsobmff(mp4({ brand: 'crx ', compatible: ['crx '] }))).toBeUndefined()
  })
})

describe('the box walker', () => {
  it('follows the 64-bit size escape', () => {
    // size 1 means the real size is the eight bytes after the type. A parser
    // that read the 1 as a length would step four bytes into the payload.
    const file = heic({
      largeMdat: true,
      picture: 'PICTURE',
      items: [{ type: 'Exif', data: EXIF }],
    })
    expect(readU32(file, find(file, 'mdat').start) >>> 0).toBe(1)

    const result = cleanIsobmff(file)
    expect(result.findings.map((finding) => finding.kind)).toEqual(['exif'])
    expect(readU32(result.output, find(result.output, 'mdat').start) >>> 0).toBe(1)
    expect(itemAt(result.output, 0)).toBe('PICTURE')
  })

  it('follows a size of zero to the end of the file', () => {
    const file = heic({ openMdat: true, picture: 'PICTURE', items: [{ type: 'Exif', data: EXIF }] })
    expect(readU32(file, find(file, 'mdat').start) >>> 0).toBe(0)

    const out = cleanIsobmff(file).output
    const mdat = find(out, 'mdat')
    // The box shrank, so it can no longer say "to the end of the file" and get
    // the same answer: a real size goes in.
    expect(readU32(out, mdat.start) >>> 0).toBe(out.length - mdat.start)
    expect(itemAt(out, 0)).toBe('PICTURE')
  })

  it('leaves a size of zero alone when the box it heads did not shrink', () => {
    const file = heic({
      openMdat: true,
      extra: [{ type: 'uuid', uuid: C2PA_BOX_UUID, data: 'a signed manifest' }],
    })
    const out = cleanIsobmff(file).output
    expect(readU32(out, find(out, 'mdat').start) >>> 0).toBe(0)
  })

  it('reads meta as the FullBox it is, and QuickTime meta as the one it is not', () => {
    // Four bytes of version and flags sit between an ISO `meta` header and its
    // first child, and nowhere in QuickTime's. Read the wrong one and every
    // child is four bytes off, so the walk finds nothing to strip at all.
    const iso = cleanIsobmff(mp4({ tags: { '©too': 'Lavf60.16.100' } }))
    const quicktime = cleanIsobmff(mp4({ tags: { '©too': 'Lavf60.16.100' }, quicktimeMeta: true }))

    expect(iso.findings.map((finding) => finding.label)).toEqual(['©too — encoder name'])
    expect(quicktime.findings.map((finding) => finding.label)).toEqual(['©too — encoder name'])
  })

  it('does not throw on a truncated file', () => {
    const file = heic({ items: [{ type: 'Exif', data: EXIF }] })
    for (const cut of [4, 12, 40, file.length - 3]) {
      expect(() => cleanIsobmff(file.subarray(0, cut))).not.toThrow()
    }
    expect(() => cleanIsobmff(mp4({ tags: { '©too': 'x' } }).subarray(0, 30))).not.toThrow()
  })

  it('copies a tail it cannot parse rather than dropping it', () => {
    const file = concat([mp4({ tags: { '©too': 'Lavf60' } }), encode('not a box at all')])
    const out = cleanIsobmff(file).output
    expect(decodeUtf8(out.subarray(-16))).toBe('not a box at all')
  })
})

describe('cleanIsobmff on HEIC and AVIF', () => {
  it('leaves a file with nothing to strip byte-identical', () => {
    const clean = heic()
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
    expect([...cleanIsobmff(avif()).output]).toEqual([...avif()])
  })

  it('removes the Exif item together with its infe, iloc and iref entries', () => {
    const file = heic({ items: [{ type: 'Exif', data: EXIF }] })
    expect(tree(file).filter((entry) => entry.type === 'infe')).toHaveLength(2)

    const result = cleanIsobmff(file)
    const out = result.output

    expect(result.findings.map((finding) => finding.kind)).toEqual(['exif'])
    expect(result.findings[0]?.verdict).toBe('informational')
    expect(decodeUtf8(out)).not.toContain('Canon EOS')

    expect(tree(out).filter((entry) => entry.type === 'infe')).toHaveLength(1)
    expect(u16(out, find(out, 'iinf').start + 12)).toBe(1)
    expect(itemExtents(out)).toHaveLength(1)
    // The reference that tied the Exif item to the picture goes with it, or it
    // would point at an item id that no longer exists.
    expect(tree(out).filter((entry) => entry.type === 'cdsc')).toHaveLength(0)
  })

  it('corrects the offsets of the items it kept', () => {
    // This is the part that silently corrupts a file: cut bytes out of `mdat`
    // and every item located after them is now read from the wrong place.
    const file = heic({ picture: 'PICTURE', items: [{ type: 'Exif', data: EXIF }] })
    expect(itemAt(file, 0)).toBe('PICTURE')

    const out = cleanIsobmff(file).output
    expect(itemExtents(out)[0]?.offset).toBeLessThan(itemExtents(file)[0]?.offset ?? 0)
    expect(itemAt(out, 0)).toBe('PICTURE')
  })

  it('corrects them when the removed item sat in front of the picture', () => {
    // The picture has to move by the length of the item that went, on top of
    // whatever the shrinking metadata boxes took off. Getting only the second
    // half of that right reads back bytes from the middle of the image.
    const file = heic({
      picture: 'PICTURE',
      pictureLast: true,
      items: [{ type: 'Exif', data: EXIF }],
    })
    expect(itemAt(file, 0)).toBe('PICTURE')

    const out = cleanIsobmff(file).output
    expect(itemAt(out, 0)).toBe('PICTURE')
    const moved = (itemExtents(file)[0]?.offset ?? 0) - (itemExtents(out)[0]?.offset ?? 0)
    expect(moved).toBeGreaterThan(EXIF.length)
  })

  it('corrects them when a whole box in front of the media went away', () => {
    const file = heic({
      picture: 'PICTURE',
      extra: [{ type: 'uuid', uuid: C2PA_BOX_UUID, data: 'a signed C2PA manifest' }],
    })
    const result = cleanIsobmff(file)
    expect(result.findings.map((finding) => finding.kind)).toEqual(['c2pa'])
    expect(result.findings[0]?.verdict).toBe('confirmed')
    expect(itemAt(result.output, 0)).toBe('PICTURE')
  })

  it('removes an XMP mime item and quotes the tool that wrote it', () => {
    const file = avif({
      picture: 'PICTURE',
      items: [{ type: 'mime', content: 'application/rdf+xml', data: XMP }],
    })
    const result = cleanIsobmff(file)

    expect(result.findings.map((finding) => finding.kind)).toEqual(['xmp'])
    expect(result.findings[0]?.verdict).toBe('probable')
    expect(result.findings[0]?.label).toContain('application/rdf+xml')
    expect(result.findings[0]?.evidence).toBe('Sora 2')
    expect(decodeUtf8(result.output)).not.toContain('xmpmeta')
    expect(itemAt(result.output, 0)).toBe('PICTURE')
  })

  it('removes a jumb box', () => {
    const file = heic({ extra: [{ type: 'jumb', data: 'a JUMBF superbox' }] })
    const result = cleanIsobmff(file)
    expect(result.findings.map((finding) => finding.kind)).toEqual(['c2pa'])
    expect(result.output.length).toBeLessThan(file.length)
  })

  it('keeps the colour profile, and reports what it kept', () => {
    // Removing it changes how the image renders. Keeping it quietly would hide
    // that an ICC profile's description names whoever wrote the file, and that
    // it outlives every EXIF strip.
    const result = cleanIsobmff(heic())
    expect(result.findings).toEqual([])
    expect(result.preserved).toHaveLength(1)
    expect(result.preserved[0]?.label).toContain('colr')
    expect(result.preserved[0]?.evidence).toContain('sRGB IEC61966-2.1')
    expect(result.preserved[0]?.preserved).toContain('rendering')
  })

  it('keeps the image properties, because ipma associates them by index', () => {
    // Drop one property box and every association after it points at the wrong
    // property. None of these is provenance in the first place.
    const file = heic({
      properties: [
        { type: 'ispe', full: true, data: concat([encode('  '), encode('  ')]) },
        { type: 'pixi', full: true, data: new Uint8Array([3, 8, 8, 8]) },
        { type: 'hvcC', data: 'codec configuration' },
      ],
      items: [{ type: 'Exif', data: EXIF }],
    })
    const kinds = tree(cleanIsobmff(file).output).map((entry) => entry.type)
    expect(kinds).toContain('ispe')
    expect(kinds).toContain('pixi')
    expect(kinds).toContain('hvcC')
  })

  it('rewrites every parent size on the way to the root', () => {
    const file = heic({ items: [{ type: 'Exif', data: EXIF }] })
    const out = cleanIsobmff(file).output
    // Slack is what a container claims minus what its children account for.
    expect(tree(out).filter((entry) => entry.slack !== 0)).toEqual([])
    expect(out.length).toBeLessThan(file.length)
  })

  it('is idempotent', () => {
    const once = cleanIsobmff(heic({ items: [{ type: 'Exif', data: EXIF }] }))
    const twice = cleanIsobmff(once.output)
    expect(twice.findings).toEqual([])
    expect([...twice.output]).toEqual([...once.output])
  })
})

describe('cleanIsobmff on MP4 and MOV', () => {
  it('leaves a file with nothing to strip byte-identical', () => {
    const clean = mp4()
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('removes the encoder and software tags and quotes them', () => {
    const result = cleanIsobmff(
      mp4({ tags: { '©too': 'Lavf60.16.100', '©swr': 'Some Video App 3.2', '©nam': 'Untitled' } }),
    )
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      'generator_tag',
      'generator_tag',
      'doc_property',
    ])
    expect(result.findings.map((finding) => finding.evidence)).toEqual([
      'Lavf60.16.100',
      'Some Video App 3.2',
      'Untitled',
    ])
  })

  it('keeps tags that describe the work rather than the tool', () => {
    const clean = mp4({ tags: { '©gen': 'Documentary', trkn: '3' } })
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('leaves the media byte-identical and moves stco to follow it', () => {
    const file = mp4({ tags: { '©too': 'Lavf60.16.100' }, media: 'MEDIABYTES' })
    expect(decodeUtf8(file.subarray(chunkOffset(file), chunkOffset(file) + 10))).toBe('MEDIABYTES')

    const out = cleanIsobmff(file).output
    expect(mdatBody(out)).toBe('MEDIABYTES')
    expect(chunkOffset(out)).toBeLessThan(chunkOffset(file))
    expect(decodeUtf8(out.subarray(chunkOffset(out), chunkOffset(out) + 10))).toBe('MEDIABYTES')
  })

  it('removes the GPS location a phone stamps into udta', () => {
    // The single most sensitive thing a video container carries, written
    // without being asked, and nowhere near the tag list iTunes uses.
    const result = cleanIsobmff(mp4({ udta: { '©xyz': '+48.8566+002.3522/' } }))
    expect(result.findings.map((finding) => finding.kind)).toEqual(['exif'])
    expect(result.findings[0]?.label).toContain('GPS location')
    expect(result.findings[0]?.evidence).toBe('+48.8566+002.3522/')
  })

  it('leaves udta atoms that are not provenance alone', () => {
    const clean = mp4({ udta: { '©gen': 'Documentary' } })
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('removes a free-form ---- atom and names it', () => {
    const result = cleanIsobmff(mp4({ freeForm: { 'ai.generated': 'true' } }))
    expect(result.findings.map((finding) => finding.kind)).toEqual(['doc_property'])
    expect(result.findings[0]?.evidence).toContain('ai.generated')
  })

  it('removes a C2PA uuid box and an XMP uuid box at the top level', () => {
    const result = cleanIsobmff(
      mp4({
        media: 'MEDIABYTES',
        extra: [
          { type: 'uuid', uuid: C2PA_BOX_UUID, data: 'a signed manifest' },
          { type: 'uuid', uuid: XMP_BOX_UUID, data: XMP },
        ],
      }),
    )
    expect(result.findings.map((finding) => finding.kind)).toEqual(['c2pa', 'xmp'])
    expect(result.findings[1]?.evidence).toBe('Sora 2')
    expect(mdatBody(result.output)).toBe('MEDIABYTES')
  })

  it('leaves a uuid box it does not recognise alone', () => {
    // A uuid box is an extension point, not a synonym for provenance: plenty of
    // cameras write their own and the file needs them.
    const clean = mp4({
      extra: [{ type: 'uuid', uuid: '0123456789abcdef0123456789abcdef', data: 'vendor data' }],
    })
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('rewrites every parent size on the way to the root', () => {
    const file = mp4({ tags: { '©too': 'Lavf60.16.100', '©cmt': 'a note' } })
    const out = cleanIsobmff(file).output
    expect(tree(out).filter((entry) => entry.slack !== 0)).toEqual([])

    // Four levels shrank between the tag and the file: ilst, meta, udta, moov.
    for (const type of ['ilst', 'meta', 'udta', 'moov']) {
      const before = find(file, type)
      const after = find(out, type)
      expect(after.end - after.start).toBeLessThan(before.end - before.start)
    }
  })

  it('is idempotent', () => {
    const once = cleanIsobmff(mp4({ tags: { '©too': 'Lavf60.16.100' }, media: 'MEDIABYTES' }))
    const twice = cleanIsobmff(once.output)
    expect(twice.findings).toEqual([])
    expect([...twice.output]).toEqual([...once.output])
  })
})

describe('QuickTime keys metadata', () => {
  const IPHONE = {
    'com.apple.quicktime.make': 'Apple',
    'com.apple.quicktime.model': 'iPhone 15 Pro',
    'com.apple.quicktime.software': '18.2',
    'com.apple.quicktime.location.ISO6709': '+48.8566+002.3522+035.000/',
  }

  it('resolves the numbered ilst entries through the keys box', () => {
    // This is the layout every iPhone .mov actually uses: the `ilst` children
    // are named by their position in `keys`, so a table of four-character codes
    // never fires on one and the whole file reads as clean.
    const result = cleanIsobmff(mp4({ keyed: IPHONE }))

    expect(result.findings.map((finding) => finding.label)).toEqual([
      'com.apple.quicktime.make — device maker',
      'com.apple.quicktime.model — device model',
      'com.apple.quicktime.software — software that wrote the file',
      'com.apple.quicktime.location.ISO6709 — GPS location (ISO 6709)',
    ])
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      'exif',
      'exif',
      'generator_tag',
      'exif',
    ])
    expect(result.findings[1]?.evidence).toBe('iPhone 15 Pro')
    expect(decodeUtf8(result.output)).not.toContain('iPhone 15 Pro')
  })

  it('leaves the media where stco says it is', () => {
    const file = mp4({ keyed: IPHONE, media: 'MEDIABYTES' })
    const out = cleanIsobmff(file).output
    expect(mdatBody(out)).toBe('MEDIABYTES')
    expect(decodeUtf8(out.subarray(chunkOffset(out), chunkOffset(out) + 10))).toBe('MEDIABYTES')
  })

  it('leaves keys it has no opinion about alone', () => {
    const clean = mp4({
      keyed: { 'com.apple.quicktime.rating.user': '0', 'com.android.version': '13' },
    })
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('does not let the two namings answer for each other', () => {
    // Both live in an `ilst`. A four-character name read as a number lands far
    // outside any key list, and an index read as characters spells NUL bytes.
    const result = cleanIsobmff(
      mp4({ tags: { '©gen': 'Documentary' }, keyed: { 'com.apple.quicktime.make': 'Apple' } }),
    )
    expect(result.findings.map((finding) => finding.label)).toEqual([
      'com.apple.quicktime.make — device maker',
    ])
  })

  it('ignores an index that points past the end of the key list', () => {
    const clean = mp4({
      inMoov: [
        {
          type: 'meta',
          full: true,
          children: [
            // One key, and an ilst entry claiming to be the ninth.
            { type: 'keys', full: true, data: raw(0, 0, 0, 1, 0, 0, 0, 9, 'mdta', 'k') },
            {
              type: 'ilst',
              children: [{ type: String.fromCharCode(0, 0, 0, 9), data: raw(0, 0, 0, 0) }],
            },
          ],
        },
      ],
    })
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })
})

describe('header timestamps', () => {
  const CREATED = 3_800_000_000 // seconds since 1904, which is 2024 in ours

  it('blanks the creation and modification times in mvhd, tkhd and mdhd', () => {
    const file = mp4({ created: CREATED })
    const result = cleanIsobmff(file)

    expect(result.findings.map((finding) => finding.label)).toEqual([
      'mvhd — creation and modification timestamps',
      'tkhd — creation and modification timestamps',
      'mdhd — creation and modification timestamps',
    ])
    expect(result.findings[0]?.evidence).toBe('2024-05-31 11:33:20')
    expect(readU32(result.output, find(result.output, 'mvhd').start + 12) >>> 0).toBe(0)
    expect(readU32(result.output, find(result.output, 'tkhd').start + 12) >>> 0).toBe(0)
    expect(readU32(result.output, find(result.output, 'mdhd').start + 12) >>> 0).toBe(0)
  })

  it('overwrites rather than cuts, so nothing after them moves', () => {
    const file = mp4({ created: CREATED, media: 'MEDIABYTES' })
    const out = cleanIsobmff(file).output
    expect(out.length).toBe(file.length)
    expect(chunkOffset(out)).toBe(chunkOffset(file))
    expect(mdatBody(out)).toBe('MEDIABYTES')
  })

  it('says nothing about a file whose timestamps are already zero', () => {
    const clean = mp4()
    const result = cleanIsobmff(clean)
    expect(result.findings).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('is idempotent', () => {
    const once = cleanIsobmff(mp4({ created: CREATED }))
    const twice = cleanIsobmff(once.output)
    expect(twice.findings).toEqual([])
    expect([...twice.output]).toEqual([...once.output])
  })

  it('still blanks them in a file whose boxes may not be moved', () => {
    // Overwriting in place cannot invalidate a stored offset, so the refusal
    // that covers removals has no reason to cover this as well.
    const file = mp4({
      created: CREATED,
      extra: [{ type: 'sidx', full: true, data: new Uint8Array(20) }],
    })
    const result = cleanIsobmff(file)
    expect(result.findings).toHaveLength(3)
    expect(result.output.length).toBe(file.length)
  })
})

describe('refusing rather than corrupting', () => {
  it('returns a fragmented file untouched, and says why', () => {
    // `sidx` indexes segments by size from its own end. Shifting anything ahead
    // of the media invalidates it, and this pass does not rewrite it — so it
    // does nothing at all rather than hand back a video that no longer plays.
    const file = mp4({
      tags: { '©too': 'Lavf60.16.100' },
      extra: [{ type: 'sidx', full: true, data: new Uint8Array(20) }],
    })
    const result = cleanIsobmff(file)

    expect([...result.output]).toEqual([...file])
    expect(result.findings).toEqual([])
    expect(result.preserved[0]?.label).toContain('unchanged')
    expect(result.preserved[0]?.evidence).toContain('sidx')
  })

  it('still says what it found and did not remove', () => {
    const result = cleanIsobmff(
      mp4({
        tags: { '©too': 'Lavf60.16.100' },
        extra: [{ type: 'moof', data: new Uint8Array(8) }],
      }),
    )
    const tag = result.preserved.find((finding) => finding.kind === 'generator_tag')
    expect(tag?.evidence).toBe('Lavf60.16.100')
    expect(tag?.preserved).toContain('not removed')
  })

  it('does not refuse a file that merely contains those boxes with nothing to strip', () => {
    const clean = mp4({ extra: [{ type: 'sidx', full: true, data: new Uint8Array(20) }] })
    const result = cleanIsobmff(clean)
    expect(result.preserved).toEqual([])
    expect([...result.output]).toEqual([...clean])
  })

  it('refuses when a stored offset points into the bytes it is removing', () => {
    // Nothing sane writes a file shaped like this. The check is the last thing
    // between a mistake in the plan and a video that no longer plays, so it
    // gets a case of its own rather than being trusted because it looks right.
    const file = mp4({
      media: 'MEDIABYTES',
      extra: [{ type: 'uuid', uuid: C2PA_BOX_UUID, data: 'a signed manifest' }],
    })
    const patched = file.slice()
    putU32(patched, find(file, 'stco').start + 16, find(file, 'uuid').start + 24)

    const result = cleanIsobmff(patched)
    expect([...result.output]).toEqual([...patched])
    expect(result.findings).toEqual([])
    expect(result.preserved[0]?.evidence).toContain('media chunk offset')
  })

  it('keeps an item it cannot relocate, and says so', () => {
    // Construction method 1 puts the item's bytes in `idat` and addresses them
    // relative to that box. Cutting them would move every other item stored the
    // same way, so the item stays and the report says why.
    const file = heic({ items: [{ type: 'Exif', data: EXIF }] })
    const iloc = find(file, 'iloc')
    // Second entry, second byte of the reserved-and-construction-method field.
    const patched = file.slice()
    patched[iloc.start + 8 + 4 + 2 + 2 + 8 + 8 + 3] = 1

    const result = cleanIsobmff(patched)
    expect(result.findings).toEqual([])
    expect(result.preserved.map((finding) => finding.kind)).toContain('exif')
    expect([...result.output]).toEqual([...patched])
  })
})

describe('a box a handler does not own', () => {
  it('copies boxes it has no opinion about, at every depth', () => {
    const clean = mp4({
      inMoov: [{ type: 'iods', full: true, data: 'object descriptor' }],
      extra: [{ type: 'free', data: 'padding' }],
    })
    const result = cleanIsobmff(clean)
    expect([...result.output]).toEqual([...clean])
    expect(tree(result.output).map((entry) => entry.type)).toContain('iods')
  })

  it('does not mistake a box for one of the ilst tags outside a tag list', () => {
    // The tag names are only tags where iTunes puts them. A `©too` sitting at
    // the top level of some other file's box tree is not this handler's to read.
    const clean = concat([mp4(), box({ type: '©too', data: 'not a tag here' })])
    expect(cleanIsobmff(clean).findings).toEqual([])
  })
})
