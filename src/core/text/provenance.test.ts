import { describe, expect, it } from 'vitest'
import { cleanProvenance } from './provenance.ts'
import { cleanText } from './unicode.ts'

const cp = (...points: number[]) => String.fromCodePoint(...points)

describe('tracking parameters', () => {
  it('strips the parameter that names the tool', () => {
    const { output } = cleanProvenance('See https://example.com/post?utm_source=chatgpt.com here.')
    expect(output).toBe('See https://example.com/post here.')
  })

  it('keeps the other parameters on the same link', () => {
    const { output } = cleanProvenance('https://example.com/p?id=7&utm_source=chatgpt.com&page=2')
    expect(output).toBe('https://example.com/p?id=7&page=2')
  })

  it('keeps the fragment', () => {
    const { output } = cleanProvenance('https://example.com/p?utm_source=chatgpt.com#results')
    expect(output).toBe('https://example.com/p#results')
  })

  it('leaves an ordinary campaign parameter alone', () => {
    // The false-positive row, and the line this module is built around. A
    // sender's own analytics on their own link says nothing about how the text
    // was written; stripping it would be editing someone's URL for our reasons.
    const text = 'https://example.com/p?utm_source=newsletter&utm_campaign=spring'
    expect(cleanProvenance(text).output).toBe(text)
  })

  it('leaves a URL with no query alone', () => {
    const text = 'Read https://example.com/chatgpt-guide for more.'
    expect(cleanProvenance(text).output).toBe(text)
  })

  it('does not swallow the full stop that ends the sentence', () => {
    const { output } = cleanProvenance('Read https://example.com/p?utm_source=chatgpt.com.')
    expect(output).toBe('Read https://example.com/p.')
  })

  it('cleans a Markdown link target', () => {
    const { output } = cleanProvenance('[the post](https://example.com/p?utm_source=chatgpt.com)')
    expect(output).toBe('[the post](https://example.com/p)')
  })

  it('reports it as a confirmed mark, not as style', () => {
    const [finding] = cleanProvenance('https://example.com/p?ref=perplexity.ai').findings
    expect(finding?.verdict).toBe('confirmed')
    expect(finding?.kind).toBe('generator_tag')
  })

  it('handles several links in one paragraph', () => {
    const { output, findings } = cleanProvenance(
      'One https://a.example/x?utm_source=chatgpt.com and two https://b.example/y?ref=claude.ai.',
    )
    expect(output).toBe('One https://a.example/x and two https://b.example/y.')
    expect(findings).toHaveLength(2)
  })
})

describe('citation furniture', () => {
  it('removes a bracket citation glyph', () => {
    const { output } = cleanProvenance('Revenue rose 4%【4:0†source】 last quarter.')
    expect(output).toBe('Revenue rose 4% last quarter.')
  })

  it('removes a private-use-delimited citation token', () => {
    const marked = `Revenue rose${cp(0xe200)}citeturn0search1${cp(0xe201)} last quarter.`
    expect(cleanProvenance(marked).output).toBe('Revenue rose last quarter.')
  })

  it('removes a bare citation token whose delimiters were lost', () => {
    // One space, not two. This asserted the double space, which made a
    // cosmetic flaw into the specification.
    expect(cleanProvenance('Revenue rose citeturn0search1 last quarter.').output).toBe(
      'Revenue rose last quarter.',
    )
  })

  it('removes an oaicite reference', () => {
    const { output } = cleanProvenance('The figure is 12 :contentReference[oaicite:0]{index=0}.')
    expect(output).toBe('The figure is 12 .')
  })

  it('leaves ordinary CJK brackets alone', () => {
    // 【 】 are real punctuation in Japanese and Chinese. Only the shape that
    // carries a citation separator is furniture.
    const text = '見出し【重要】をお読みください。'
    expect(cleanProvenance(text).output).toBe(text)
  })

  it('leaves prose with no furniture in it byte-identical', () => {
    const text = 'A plain paragraph with a link to https://example.com/page and nothing else.'
    expect(cleanProvenance(text).output).toBe(text)
    expect(cleanProvenance(text).findings).toEqual([])
  })
})

describe('wired into the default clean', () => {
  it('removes a tracking parameter without being asked', () => {
    // Not opt-in, unlike the style passes: this is a mark, and the tool's
    // promise is that a clean removes marks.
    const { output, findings } = cleanText('Source: https://example.com/p?utm_source=chatgpt.com')
    expect(output).toBe('Source: https://example.com/p')
    expect(findings.some((f) => f.kind === 'generator_tag' && f.verdict === 'confirmed')).toBe(true)
  })
})
