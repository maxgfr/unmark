import { describe, expect, it } from 'vitest'
import { docxText, decodeXmlText } from './docx-text.ts'
import { zip } from '../../test/containers.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const paragraph = (text: string, style?: string, extra = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${extra}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

const STYLES = `<?xml version="1.0"?><w:styles ${W}>
<w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Titre2"><w:name w:val="heading 2"/><w:basedOn w:val="Titre1"/></w:style>
<w:style w:type="paragraph" w:styleId="Lgende"><w:name w:val="caption"/></w:style>
<w:style w:type="paragraph" w:styleId="TM1"><w:name w:val="toc 1"/></w:style>
</w:styles>`

const docx = (body: string, pages?: number) =>
  zip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    {
      name: 'word/document.xml',
      content: `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    },
    { name: 'word/styles.xml', content: STYLES },
    ...(pages === undefined
      ? []
      : [
          { name: 'docProps/app.xml', content: `<Properties><Pages>${pages}</Pages></Properties>` },
        ]),
  ])

describe('docxText', () => {
  it('keeps body paragraphs and labels them with the heading above', async () => {
    const read = await docxText(
      docx(
        [
          paragraph('1. Introduction', 'Titre1'),
          paragraph('The first paragraph of the introduction.'),
          paragraph('2.6.3 Mechanistic hypotheses', 'Titre2'),
          paragraph('Two mechanisms &amp; one &lt;hypothesis&gt;.'),
        ].join(''),
      ),
    )
    expect(read?.text).toBe(
      'The first paragraph of the introduction.\n\nTwo mechanisms & one <hypothesis>.',
    )
    expect(read?.paragraphs.map((p) => [p.index, p.section])).toEqual([
      [2, '1. Introduction'],
      [4, '2.6.3 Mechanistic hypotheses'],
    ])
    expect(read?.skipped.heading).toBe(2)
    const first = read?.paragraphs[0]
    expect(read?.text.slice(first?.start, first?.end)).toBe(
      'The first paragraph of the introduction.',
    )
  })

  it('leaves out data tables, captions, the contents and the reference list', async () => {
    const cell = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`
    const prose = 'word '.repeat(40).trim()
    const read = await docxText(
      docx(
        [
          paragraph('Table des matières'),
          paragraph('1. Introduction 12'),
          paragraph('2.6.3 Mechanistic hypotheses 27'),
          paragraph('Body text that stays.'),
          `<w:tbl><w:tr>${cell('n')}${cell('41')}</w:tr><w:tr>${cell(prose)}</w:tr></w:tbl>`,
          paragraph('Figure 4. Classification of the anchors.'),
          paragraph('A caption by style.', 'Lgende'),
          paragraph('Contents line', 'TM1'),
          paragraph('Références', 'Titre1'),
          paragraph('1. Gurney NT. Intraocular lens implantation. 2018.'),
          paragraph('Annexe', 'Titre1'),
          paragraph('After the references.'),
        ].join(''),
      ),
    )
    expect(read?.text.split('\n\n')).toEqual([
      'Body text that stays.',
      prose,
      'After the references.',
    ])
    expect(read?.skipped).toMatchObject({ table: 2, caption: 2, references: 1, toc: 4 })
  })

  it('reads tabs, line breaks and field results, but not field codes or deletions', async () => {
    const read = await docxText(
      docx(
        `<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r>` +
          `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF x </w:instrText></w:r>` +
          `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>d</w:t></w:r>` +
          `<w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
      ),
    )
    expect(read?.text).toBe('a b\ncd')
  })

  it('numbers pages only when the rendered breaks account for the document', async () => {
    const body = [
      paragraph('Page one text.'),
      `<w:p><w:r><w:lastRenderedPageBreak/><w:t>Page two text.</w:t></w:r></w:p>`,
      `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
      paragraph('Page three text.'),
    ].join('')
    const trusted = await docxText(docx(body, 3))
    expect(trusted?.paged).toBe(true)
    expect(trusted?.paragraphs.map((p) => p.page)).toEqual([1, 2, 3])
    const untrusted = await docxText(docx(body, 40))
    expect(untrusted?.paged).toBe(false)
    expect(untrusted?.paragraphs.every((p) => p.page === undefined)).toBe(true)
  })

  it('returns undefined for bytes that are not a .docx', async () => {
    expect(await docxText(new Uint8Array([1, 2, 3]))).toBeUndefined()
    expect(await docxText(zip([{ name: 'a.txt', content: 'x' }]))).toBeUndefined()
  })

  it('decodes character references', () => {
    expect(decodeXmlText('&#233;t&#xE9; &amp; &quot;x&quot; &unknown;')).toBe('été & "x" &unknown;')
  })
})
