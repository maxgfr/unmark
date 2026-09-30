import { describe, expect, it } from 'vitest'
import { formatOfPaste } from './paste.ts'

describe('formatOfPaste', () => {
  it('reads a pasted page or a fragment of one as HTML', () => {
    expect(formatOfPaste('<!doctype html><html><body><p>Bonjour</p></body></html>')).toBe('HTML')
    expect(formatOfPaste('  <p>Un paragraphe copié depuis une page.</p><p>Un autre.</p>')).toBe(
      'HTML',
    )
    expect(formatOfPaste('<div class="post"><h2>Titre</h2><p>Texte</p></div>')).toBe('HTML')
  })

  it('reads page source that opens on a script, a style, a meta tag or a comment as HTML', () => {
    expect(formatOfPaste('<script>var a = 1</script><p>Texte</p>')).toBe('HTML')
    expect(formatOfPaste('<style>p { color: red }</style><p>Texte</p>')).toBe('HTML')
    expect(formatOfPaste('<meta charset="utf-8"><title>T</title>')).toBe('HTML')
    expect(formatOfPaste('<!-- nav --><p>Texte</p>')).toBe('HTML')
  })

  it('reads prose that merely contains a bracket or an inline tag as Markdown', () => {
    expect(formatOfPaste('# Titre\n\nUn texte ordinaire.')).toBe('Markdown')
    expect(formatOfPaste('Si a < b et c > d, alors rien ne change.')).toBe('Markdown')
    expect(formatOfPaste('Un mot en <b>gras</b> au milieu d’une phrase.')).toBe('Markdown')
    expect(formatOfPaste('')).toBe('Markdown')
  })
})
