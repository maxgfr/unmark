import { describe, expect, it } from 'vitest'
import { placeMedia } from './docx-media.ts'
import { cleanZipDocument } from './zipdoc.ts'
import { encode } from './types.ts'
import type { ZipEntry } from './zip.ts'
import { c2paStore, CLAUDE_STORE } from '../../test/c2pa.ts'
import { png, zip } from '../../test/containers.ts'

const W = 'xmlns:w="w" xmlns:r="r"'

const para = (text: string, style = '') =>
  `<w:p w:rsidR="1">${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const picture = (id: string) =>
  `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:blip r:embed="${id}"/></a:graphic></wp:inline></w:drawing></w:r></w:p>`
const pageBreak = (text: string) =>
  `<w:p><w:r><w:lastRenderedPageBreak/><w:t>${text}</w:t></w:r></w:p>`

const rels = (...ids: string[]) =>
  `<Relationships>${ids
    .map(
      (id, index) => `<Relationship Id="${id}" Type="image" Target="media/image${index + 1}.png"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rLink" Type="hyperlink" Target="https://example.org" TargetMode="External"/></Relationships>`

const entries = (body: string, ids: string[]): ZipEntry[] => [
  {
    name: 'word/document.xml',
    data: encode(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
  },
  { name: 'word/_rels/document.xml.rels', data: encode(rels(...ids)) },
]

describe('placeMedia', () => {
  it('finds the paragraph a picture is anchored in and the caption under it', () => {
    const placed = placeMedia(
      entries(para('Intro.') + picture('rId1') + para('Figure 1. A chart &amp; its legend.'), [
        'rId1',
      ]),
    )
    expect(placed.get('word/media/image1.png')).toEqual({
      paragraph: 2,
      caption: 'Figure 1. A chart & its legend.',
    })
  })

  it('reads a caption style in any of the languages Word ships, above or below', () => {
    const placed = placeMedia(
      entries(para('Courbe de survie', 'Lgende') + picture('rId1'), ['rId1']),
    )
    expect(placed.get('word/media/image1.png')?.caption).toBe('Courbe de survie')
  })

  it('steps over empty paragraphs between a picture and its caption', () => {
    const placed = placeMedia(
      entries(para('Figure 1. Above.') + para('') + para('') + picture('rId1'), ['rId1']),
    )
    expect(placed.get('word/media/image1.png')?.caption).toBe('Figure 1. Above.')
  })

  it('gives a stacked picture the caption on its own page', () => {
    // Caption, picture, caption, picture: read the same whether captions go
    // above or below. Word's rendered page breaks say which caption shares a
    // page with which picture.
    const body =
      pageBreak('Figure 1. First.') +
      picture('rId1') +
      pageBreak('Figure 2. Second.') +
      picture('rId2')
    const placed = placeMedia(entries(body, ['rId1', 'rId2']))
    expect(placed.get('word/media/image1.png')?.caption).toBe('Figure 1. First.')
    expect(placed.get('word/media/image2.png')?.caption).toBe('Figure 2. Second.')
  })

  it('falls back to below when both sides are equally plausible, as Word inserts them', () => {
    const body = para('Figure 1. First.') + picture('rId1') + para('Figure 2. Second.')
    expect(placeMedia(entries(body, ['rId1'])).get('word/media/image1.png')?.caption).toBe(
      'Figure 2. Second.',
    )
  })

  it("learns the document's habit from pictures captioned on one side only", () => {
    const body =
      para('Figure 1. One.') +
      picture('rId1') +
      para('Some text.') +
      para('Figure 2. Two.') +
      picture('rId2') +
      para('Figure 3. Three.') +
      picture('rId3')
    const placed = placeMedia(entries(body, ['rId1', 'rId2', 'rId3']))
    expect(placed.get('word/media/image2.png')?.caption).toBe('Figure 2. Two.')
  })

  it('takes a caption in the picture paragraph itself and stops at a neighbouring picture', () => {
    const inline = `<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r><w:r><w:t>Fig. 3 — inline</w:t></w:r></w:p>`
    const placed = placeMedia(entries(inline + picture('rId2'), ['rId1', 'rId2']))
    expect(placed.get('word/media/image1.png')?.caption).toBe('Fig. 3 — inline')
    expect(placed.get('word/media/image2.png')?.caption).toBeUndefined()
  })

  it('counts self-closing paragraphs and gives text-box paragraphs to the innermost one', () => {
    const textBox = `<w:p><w:r><w:drawing><w:txbxContent>${para('inside')}</w:txbxContent><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>`
    const placed = placeMedia(entries(`<w:p/>${textBox}`, ['rId1']))
    expect(placed.get('word/media/image1.png')?.paragraph).toBe(2)
  })

  it('returns nothing for a package without a Word body', () => {
    expect(placeMedia([]).size).toBe(0)
  })

  it('resolves a target written from the package root', () => {
    const placed = placeMedia([
      {
        name: 'word/document.xml',
        data: encode(`<w:document><w:body>${picture('rId9')}</w:body></w:document>`),
      },
      {
        name: 'word/_rels/document.xml.rels',
        data: encode(
          '<Relationships><Relationship Id="rId9" Target="/word/media/x.png"/></Relationships>',
        ),
      },
    ])
    expect(placed.get('word/media/x.png')?.paragraph).toBe(1)
  })
})

describe('cleanZipDocument with pictures', () => {
  const docx = () =>
    zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      {
        name: 'word/document.xml',
        content: `<w:document ${W}><w:body>${para('Text.')}${picture('rId1')}${para('Figure 4. Classification.')}${picture('rId2')}</w:body></w:document>`,
      },
      { name: 'word/_rels/document.xml.rels', content: rels('rId1', 'rId2') },
      {
        name: 'word/media/image1.png',
        content: png([{ type: 'caBX', data: c2paStore(CLAUDE_STORE) }]),
      },
      { name: 'word/media/image2.png', content: png() },
      { name: 'word/media/image3.png', content: png() },
    ])

  it('places the finding on a marked picture', async () => {
    const result = await cleanZipDocument(docx())
    const c2pa = result.findings.find((finding) => finding.kind === 'c2pa')
    expect(c2pa).toMatchObject({
      where: 'word/media/image1.png',
      placement: { paragraph: 2, caption: 'Figure 4. Classification.' },
    })
  })

  it('lists every picture, marked or not, in document order', async () => {
    const { media } = await cleanZipDocument(docx())
    expect(media).toEqual([
      {
        part: 'word/media/image1.png',
        paragraph: 2,
        caption: 'Figure 4. Classification.',
        marks: 1,
        c2pa: expect.stringContaining('file passed through an AI tool'),
      },
      { part: 'word/media/image2.png', paragraph: 4, marks: 0 },
      { part: 'word/media/image3.png', marks: 0 },
    ])
  })

  it('lists no pictures for a package that is not a Word document', async () => {
    const { media } = await cleanZipDocument(
      zip([
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: 'ppt/presentation.xml', content: '<p/>' },
        { name: 'ppt/media/image1.png', content: png() },
      ]),
    )
    expect(media).toBeUndefined()
  })
})
