import { describe, expect, it } from 'vitest'
import { glyphToText, layoutChunks, parseToUnicode, pdfText } from './text.ts'
import { encode } from '../types.ts'
import { pdfObjects as build, pdfStream as stream } from '../../../test/containers.ts'

const WIDTHS = `/FirstChar 32 /LastChar 126 /Widths [${Array.from({ length: 95 }, () => 500).join(' ')}]`

describe('pdfText', () => {
  it('reads each page in order, with spaces from positions and paragraph breaks', async () => {
    const page1 = [
      'BT /F1 10 Tf 1 0 0 1 72 700 Tm (First) Tj 1 0 0 1 102 700 Tm (line goes) Tj ET',
      'BT /F1 10 Tf 72 688 Td (continues here) Tj 0 -12 Td (ends.) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 72 640 Tm [(Sec) -20 (ond) -900 (para)] TJ ET',
    ].join('\n')
    const page2 = "BT /F1 10 Tf 14 TL 72 700 Td (Page two) Tj (and more) ' ET"
    const file = build([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>',
      '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
      `<< /Type /Font /Subtype /TrueType /Encoding /WinAnsiEncoding ${WIDTHS} >>`,
      stream('', page1, true),
      stream('', page2),
    ])
    const read = await pdfText(file)
    expect(read?.unreadable).toEqual([])
    expect(read?.pages.map((p) => p.page)).toEqual([1, 2])
    expect(read?.pages[0]?.text).toBe('First line goes\ncontinues here\nends.\n\nSecond para')
    expect(read?.pages[1]?.text).toBe('Page two\nand more')
  })

  it('decodes through ToUnicode and through /Differences', async () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin begincmap',
      '1 begincodespacerange <00> <FF> endcodespacerange',
      '2 beginbfchar <01> <00E9> <02> <FB01> endbfchar',
      '1 beginbfrange <41> <43> <0058> endbfrange',
      'endcmap',
    ].join('\n')
    const file = build([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>',
      stream(
        '',
        'BT /F1 10 Tf 72 700 Td (\\001t\\001 ABC \\002) Tj ET BT /F2 10 Tf 72 600 Td (\\200x) Tj ET',
      ),
      `<< /Type /Font /Subtype /TrueType /ToUnicode 6 0 R ${WIDTHS} >>`,
      stream('', cmap),
      '<< /Type /Font /Subtype /Type1 /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [128 /eacute] >> >>',
    ])
    const text = (await pdfText(file))?.pages[0]?.text
    expect(text).toBe('été XYZ ﬁ\n\néx')
  })

  it('returns undefined for bytes that are not a PDF it can load', async () => {
    expect(await pdfText(encode('not a pdf'))).toBeUndefined()
  })
})

describe('the pieces', () => {
  it('maps glyph names', () => {
    expect(glyphToText('eacute')).toBe('é')
    expect(glyphToText('uni00E9')).toBe('é')
    expect(glyphToText('u1F600')).toBe('😀')
    expect(glyphToText('f_f_i')).toBe('ffi')
    expect(glyphToText('a.sc')).toBe('a')
    expect(glyphToText('quoteright')).toBe('’')
    expect(glyphToText('nonsense')).toBe('')
  })

  it('reads two-byte ToUnicode maps and array ranges', () => {
    const { bytes, map } = parseToUnicode(
      '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0003> <0004> [<0041> <00420043>] endbfrange',
    )
    expect(bytes).toBe(2)
    expect(map.get(3)).toBe('A')
    expect(map.get(4)).toBe('BC')
  })

  it('joins a word hyphenated at a line end', () => {
    const chunk = (text: string, y: number) => ({ text, x: 0, y, endX: 400, size: 10 })
    expect(layoutChunks([chunk('an extério-', 700), chunk('risation here', 688)])).toBe(
      'an extériorisation here',
    )
  })
})
