import { describe, expect, it } from 'vitest'
import { cleanHtml, cleanMarkdown, cleanSvg } from './markup.ts'

describe('cleanSvg', () => {
  it('leaves a plain SVG untouched', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    const result = cleanSvg(svg)
    expect(result.output).toBe(svg)
    expect(result.findings).toEqual([])
  })

  it('removes a metadata block and keeps the drawing', () => {
    const svg = '<svg><metadata><rdf:RDF>author stuff</rdf:RDF></metadata><rect width="1"/></svg>'
    const result = cleanSvg(svg)
    expect(result.output).toBe('<svg><rect width="1"/></svg>')
    expect(result.findings.map((f) => f.kind)).toEqual(['doc_property'])
  })

  it('removes an XMP packet', () => {
    const svg = `<svg><?xpacket begin="" id="W5M0"?><x:xmpmeta>tool</x:xmpmeta><?xpacket end="w"?><rect/></svg>`
    expect(cleanSvg(svg).output).toBe('<svg><rect/></svg>')
  })

  it('removes a generator comment', () => {
    const svg = '<svg><!-- Generator: SomeEditor 1.0 --><rect/></svg>'
    const result = cleanSvg(svg)
    expect(result.output).toBe('<svg><rect/></svg>')
    expect(result.findings[0]?.kind).toBe('generator_tag')
  })

  it('keeps an ordinary comment', () => {
    // Not every comment is provenance. Stripping all of them would delete the
    // author's own notes.
    const svg = '<svg><!-- the logo mark --><rect/></svg>'
    expect(cleanSvg(svg).output).toBe(svg)
  })

  it('removes data-ai attributes without touching the element', () => {
    const svg = '<svg><rect data-ai-model="something" width="1"/></svg>'
    expect(cleanSvg(svg).output).toBe('<svg><rect width="1"/></svg>')
  })
})

describe('cleanHtml', () => {
  it('removes a generator meta tag and quotes its content', () => {
    const html = '<head><meta name="generator" content="SiteBuilder 9"><title>x</title></head>'
    const result = cleanHtml(html)
    expect(result.output).toBe('<head><title>x</title></head>')
    expect(result.findings[0]?.evidence).toBe('SiteBuilder 9')
  })

  it('calls an explicit AI-generated declaration confirmed', () => {
    const html = '<meta name="ai-generated" content="true">'
    expect(cleanHtml(html).findings[0]).toMatchObject({ verdict: 'confirmed' })
  })

  it('removes JSON-LD that names a software creator', () => {
    const html = `<script type="application/ld+json">{"@type":"Article","creator":{"@type":"SoftwareApplication","name":"Writer"}}</script><p>body</p>`
    const result = cleanHtml(html)
    expect(result.output).toBe('<p>body</p>')
    expect(result.findings).toHaveLength(1)
  })

  it('keeps JSON-LD that is ordinary structured data', () => {
    // A page's Article or Product schema is what makes it findable. Stripping
    // every ld+json block to catch provenance would break the site.
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Bike","offers":{"price":"10"}}</script>`
    const result = cleanHtml(html)
    expect(result.output).toBe(html)
    expect(result.findings).toEqual([])
  })

  it('keeps ordinary meta tags', () => {
    const html = '<meta name="description" content="a page"><meta charset="utf-8">'
    expect(cleanHtml(html).output).toBe(html)
  })

  it('reports offsets into the original document', () => {
    const html = '<p>hello</p><meta name="generator" content="X">'
    expect(cleanHtml(html).findings[0]?.offset).toBe(html.indexOf('<meta'))
  })
})

describe('cleanMarkdown', () => {
  it('does nothing to a document with no frontmatter', () => {
    const md = '# Title\n\nSome prose.\n'
    expect(cleanMarkdown(md)).toEqual({ output: md, findings: [] })
  })

  it('removes AI provenance keys and keeps the rest of the frontmatter', () => {
    const md = [
      '---',
      'title: My post',
      'generated_by: some-model',
      'date: 2026-01-01',
      '---',
      '',
      'Body.',
    ].join('\n')
    const result = cleanMarkdown(md)
    expect(result.output).toContain('title: My post')
    expect(result.output).toContain('date: 2026-01-01')
    expect(result.output).not.toContain('generated_by')
    expect(result.output).toContain('Body.')
    expect(result.findings).toHaveLength(1)
  })

  it('leaves frontmatter that has nothing to do with provenance', () => {
    const md = '---\ntitle: x\ntags: [a, b]\n---\n\nBody.'
    expect(cleanMarkdown(md)).toEqual({ output: md, findings: [] })
  })

  it('does not touch a "model:" line in the body', () => {
    // Only the frontmatter block is metadata. The same word in prose is prose.
    const md = '---\ntitle: x\n---\n\nThe model: a description of one.'
    expect(cleanMarkdown(md).output).toBe(md)
  })

  it('is idempotent', () => {
    const md = '---\ntitle: x\nllm: something\n---\n\nBody.'
    const once = cleanMarkdown(md)
    expect(cleanMarkdown(once.output).findings).toEqual([])
    expect(cleanMarkdown(once.output).output).toBe(once.output)
  })
})
