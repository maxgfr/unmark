import { describe, expect, it } from 'vitest'
import {
  asName,
  asNumber,
  decodeStream,
  parseIndirect,
  Reader,
  source,
  unpredict,
  type PdfObject,
} from './lex.ts'
import { concat, encode, decodeUtf8 } from '../types.ts'
import { zlibStored } from '../../../test/containers.ts'

const parse = (text: string): PdfObject => new Reader(source(encode(text))).parse()
const stringOf = (object: PdfObject): string =>
  object.type === 'string' ? String.fromCharCode(...object.bytes) : `not a string: ${object.type}`

describe('numbers', () => {
  it('reads the forms the format actually uses', () => {
    expect(parse('42')).toEqual({ type: 'number', value: 42 })
    expect(parse('-3')).toEqual({ type: 'number', value: -3 })
    expect(parse('+17')).toEqual({ type: 'number', value: 17 })
    expect(parse('6.02')).toEqual({ type: 'number', value: 6.02 })
    // Both of these are legal reals and both look truncated.
    expect(parse('4.')).toEqual({ type: 'number', value: 4 })
    expect(parse('-.002')).toEqual({ type: 'number', value: -0.002 })
  })

  it('reads leading zeros as a value, which is how xref rows are written', () => {
    expect(parse('0000000017')).toEqual({ type: 'number', value: 17 })
  })
})

describe('names', () => {
  it('decodes #xx escapes', () => {
    expect(asName(parse('/A#20B'))).toBe('A B')
    expect(asName(parse('/Lime#20Green'))).toBe('Lime Green')
  })

  it('leaves a # that is not an escape alone', () => {
    // The escape is two hex digits or it is not an escape. Consuming a bare #
    // would rename /Sub#total and break whatever refers to it.
    expect(asName(parse('/Sub#total'))).toBe('Sub#total')
  })

  it('ends at a delimiter rather than at whitespace only', () => {
    expect(asName(parse('/Type/Page'))).toBe('Type')
  })
})

describe('literal strings', () => {
  it('keeps balanced inner parentheses', () => {
    // The case a regex gets wrong: /\(([^)]*)\)/ stops at the first inner `)`
    // and reports half a title as the whole value.
    expect(stringOf(parse('(Quarterly (Q1 (draft)) report)'))).toBe('Quarterly (Q1 (draft)) report')
  })

  it('reads the named escapes', () => {
    expect(stringOf(parse(String.raw`(a\nb\tc\\d\(e\))`))).toBe('a\nb\tc\\d(e)')
  })

  it('reads octal escapes, including short ones', () => {
    expect(stringOf(parse(String.raw`(\101\102\7)`))).toBe('AB')
  })

  it('treats a backslash before a newline as a line continuation', () => {
    // Not a newline in the value: it is how a writer wraps a long string.
    expect(stringOf(parse('(one \\\ntwo)'))).toBe('one two')
  })

  it('stops at the parenthesis that closes it and not before', () => {
    const reader = new Reader(source(encode('(first)(second)')))
    expect(stringOf(reader.parse())).toBe('first')
    expect(stringOf(reader.parse())).toBe('second')
  })
})

describe('hex strings', () => {
  it('reads pairs of digits', () => {
    expect(stringOf(parse('<48656C6C6F>'))).toBe('Hello')
  })

  it('ignores whitespace and pads a trailing half-byte with zero', () => {
    expect(stringOf(parse('<48 65>'))).toBe('He')
    // <7> means 0x70, not 0x07. Getting this backwards shifts every value.
    expect(stringOf(parse('<7>'))).toBe('p')
  })
})

describe('references', () => {
  it('reads 12 0 R as one object rather than two numbers', () => {
    expect(parse('12 0 R')).toEqual({ type: 'ref', num: 12, gen: 0 })
    expect(parse('[1 0 R 2 3 R]')).toEqual({
      type: 'array',
      items: [
        { type: 'ref', num: 1, gen: 0 },
        { type: 'ref', num: 2, gen: 3 },
      ],
    })
  })

  it('does not read a number followed by an unrelated keyword as a reference', () => {
    // `1 0 RG` is a colour operator in a content stream. Nothing about the two
    // integers says which it is; only the lookahead does.
    expect(parse('1 0 RG')).toEqual({ type: 'number', value: 1 })
    expect(parse('[1 0]')).toEqual({
      type: 'array',
      items: [
        { type: 'number', value: 1 },
        { type: 'number', value: 0 },
      ],
    })
  })
})

describe('containers and keywords', () => {
  it('reads nested dictionaries and arrays', () => {
    const object = parse('<< /A [1 2 << /B (x) >>] /C true /D null /E false >>')
    expect(object.type).toBe('dict')
    const entries = object.type === 'dict' ? object.entries : new Map()
    expect([...entries.keys()]).toEqual(['A', 'C', 'D', 'E'])
    expect(entries.get('C')).toEqual({ type: 'bool', value: true })
    expect(entries.get('D')).toEqual({ type: 'null' })
    expect(entries.get('E')).toEqual({ type: 'bool', value: false })
  })

  it('skips comments between tokens', () => {
    expect(parse('% a comment\n<< /A 1 >>').type).toBe('dict')
  })

  it('refuses a dictionary key that is not a name', () => {
    expect(() => parse('<< 1 2 >>')).toThrow(/key is not a name/)
  })
})

describe('indirect objects and streams', () => {
  const withLength = (declared: string, body: string) =>
    `1 0 obj\n<< /Length ${declared} >>\nstream\n${body}\nendstream\nendobj\n`

  it('reads a stream whose /Length is correct', () => {
    const { object } = parseIndirect(source(encode(withLength('5', 'hello'))), 0)
    expect(object.type === 'stream' && decodeUtf8(object.raw)).toBe('hello')
  })

  it('falls back to endstream when /Length is wrong', () => {
    // A declared length is a hint. Files with the wrong one open everywhere,
    // so trusting it blindly would mean failing on files that work.
    const { object } = parseIndirect(source(encode(withLength('999', 'hello'))), 0)
    expect(object.type === 'stream' && decodeUtf8(object.raw)).toBe('hello')
  })

  it('asks the caller when /Length is an indirect reference', () => {
    const text = withLength('7 0 R', 'hello')
    const resolved = parseIndirect(source(encode(text)), 0, () => 5)
    expect(resolved.object.type === 'stream' && decodeUtf8(resolved.object.raw)).toBe('hello')

    // And still lands on the right bytes when the caller cannot answer.
    const unresolved = parseIndirect(source(encode(text)), 0, () => undefined)
    expect(unresolved.object.type === 'stream' && decodeUtf8(unresolved.object.raw)).toBe('hello')
  })

  it('reads the generation number rather than assuming zero', () => {
    const { num, gen } = parseIndirect(source(encode('12 3 obj\n<< >>\nendobj\n')), 0)
    expect([num, gen]).toEqual([12, 3])
  })

  it('keeps binary stream bytes exactly, newlines included', () => {
    const body = Uint8Array.from([0, 13, 10, 255, 13, 10, 0])
    const bytes = concat([
      encode(`1 0 obj\n<< /Length ${body.length} >>\nstream\n`),
      body,
      encode('\nendstream\nendobj\n'),
    ])
    const { object } = parseIndirect(source(bytes), 0)
    expect(object.type === 'stream' && [...object.raw]).toEqual([...body])
  })
})

describe('decodeStream', () => {
  const flate = (data: Uint8Array, extra = '') =>
    parseIndirect(
      source(
        concat([
          encode(`1 0 obj\n<< /Filter /FlateDecode ${extra} /Length ${data.length} >>\nstream\n`),
          data,
          encode('\nendstream\nendobj\n'),
        ]),
      ),
      0,
    ).object

  it('inflates a FlateDecode stream', async () => {
    const stream = flate(zlibStored(encode('the payload')))
    expect(stream.type).toBe('stream')
    if (stream.type !== 'stream') return
    expect(decodeUtf8(await decodeStream(stream))).toBe('the payload')
  })

  it('refuses a filter it has not implemented instead of returning the raw bytes', async () => {
    // Returning compressed bytes as though they were content is how a cleaner
    // reports a file as clean because it could not read it.
    const lzw = parseIndirect(
      source(encode('1 0 obj\n<< /Filter /LZWDecode /Length 1 >>\nstream\nx\nendstream\nendobj\n')),
      0,
    ).object
    if (lzw.type !== 'stream') throw new Error('fixture is not a stream')
    await expect(decodeStream(lzw)).rejects.toThrow(/unsupported stream filter/)
  })
})

describe('unpredict', () => {
  const parms = (predictor: number, columns: number) =>
    source(encode(`<< /Predictor ${predictor} /Columns ${columns} >>`))

  const dict = (predictor: number, columns: number) => {
    const object = new Reader(parms(predictor, columns)).parse()
    if (object.type !== 'dict') throw new Error('fixture is not a dictionary')
    return object
  }

  it('reverses PNG Up, which is what a cross-reference stream is written with', () => {
    // Three rows of three, each stored as the difference from the row above.
    const encoded = Uint8Array.from([2, 1, 2, 3, 2, 1, 1, 1, 2, 1, 1, 1])
    expect([...unpredict(encoded, dict(12, 3))]).toEqual([1, 2, 3, 2, 3, 4, 3, 4, 5])
  })

  it('leaves the data alone when there is no predictor', () => {
    const raw = Uint8Array.from([9, 8, 7])
    expect([...unpredict(raw, dict(1, 3))]).toEqual([9, 8, 7])
    expect([...unpredict(raw, undefined)]).toEqual([9, 8, 7])
  })

  it('says so rather than guessing at a TIFF predictor', () => {
    expect(() => unpredict(Uint8Array.from([0]), dict(2, 1))).toThrow(/TIFF predictor/)
  })
})

describe('source', () => {
  it('gives a string index that is a byte offset', () => {
    // The property the whole reader is built on: a multi-byte UTF-8 sequence
    // must come out as that many characters, not as one.
    const bytes = encode('é(x)')
    expect(source(bytes).text.length).toBe(bytes.length)
    expect(asNumber(parse('1'))).toBe(1)
  })
})
