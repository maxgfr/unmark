// The eval contract this repo now holds itself to: every rule gets a case that
// must fire and a case that must not. The false-positive rows are the point.
// A guard that seals everything passes every "did you protect X" test and
// silently turns the whole product into a no-op.

import { describe, expect, it } from 'vitest'
import {
  blocksOf,
  isSealed,
  paragraphsOf,
  protectedMask,
  replaceInProse,
  type BlockKind,
} from './regions.ts'

const kinds = (text: string): BlockKind[] => blocksOf(text).map((block) => block.kind)

/** Whether the first occurrence of `needle` is sealed. */
const sealed = (text: string, needle: string): boolean => {
  const index = text.indexOf(needle)
  if (index === -1) throw new Error(`fixture does not contain ${JSON.stringify(needle)}`)
  return isSealed(protectedMask(text), index, index + needle.length)
}

describe('blocksOf', () => {
  it('reads a plain paragraph as one block', () => {
    expect(kinds('One sentence. And another.')).toEqual(['paragraph'])
  })

  it('keeps a paragraph together across a soft line break', () => {
    const blocks = blocksOf('First line\nsecond line\n\nNext paragraph')
    expect(blocks.filter((b) => b.kind === 'paragraph')).toHaveLength(2)
  })

  it('reads a fenced block, including its fence lines', () => {
    const text = 'Before\n\n```js\nconst a = 1\n```\n\nAfter'
    const fence = blocksOf(text).find((block) => block.kind === 'fence')
    expect(text.slice(fence?.start, fence?.end)).toBe('```js\nconst a = 1\n```')
  })

  it('runs an unclosed fence to the end rather than reopening the document', () => {
    // The commoner mistake is a missing closing fence, not a stray opening one.
    // Treating the tail as prose would let a rule edit inside real code.
    const text = 'Intro\n\n```\nnot closed\nstill code'
    expect(blocksOf(text).at(-1)?.kind).toBe('fence')
  })

  it('does not treat a tilde fence as prose', () => {
    expect(kinds('~~~\ncode\n~~~')).toEqual(['fence'])
  })

  it('reads frontmatter only at the top of the file', () => {
    expect(kinds('---\ntitle: x\n---\n\nBody')[0]).toBe('frontmatter')
  })

  it('does not read a horizontal rule mid-document as frontmatter', () => {
    // This is the false-positive row. A `---` after a paragraph is a rule or a
    // setext underline; treating it as frontmatter would seal the rest of the file.
    expect(kinds('Body text\n\n---\n\nMore body')).not.toContain('frontmatter')
  })

  it('records heading depth', () => {
    const heading = blocksOf('### Deep heading').find((block) => block.kind === 'heading')
    expect(heading?.level).toBe(3)
  })

  it('reads a setext underline as a heading', () => {
    expect(kinds('Title\n=====')).toEqual(['heading'])
  })

  it('does not read a hash inside a sentence as a heading', () => {
    expect(kinds('Issue #4 is open.')).toEqual(['paragraph'])
  })

  it('groups consecutive blockquote lines', () => {
    expect(kinds('> one\n> two\n\nprose')).toEqual(['blockquote', 'blank', 'paragraph'])
  })

  it('reads an indented run after a blank line as code', () => {
    expect(kinds('Prose.\n\n    const a = 1\n    const b = 2')).toEqual([
      'paragraph',
      'blank',
      'indented_code',
    ])
  })

  it('does not read a nested list body as code', () => {
    // The ambiguous case that matters. Four spaces under a list item is the
    // item's own continuation, and sealing it would freeze every nested list.
    expect(kinds('- item\n\n    continued text')).not.toContain('indented_code')
  })

  it('reads a table with its delimiter row', () => {
    expect(kinds('| a | b |\n| - | - |\n| 1 | 2 |')).toEqual(['table'])
  })

  it('does not read a sentence containing a pipe as a table', () => {
    expect(kinds('Run `a | b` to pipe it.')).toEqual(['paragraph'])
  })

  it('is empty on empty input', () => {
    expect(blocksOf('')).toEqual([])
  })
})

describe('protectedMask', () => {
  it('seals a fenced code block', () => {
    expect(sealed('Text.\n\n```\nin order to run\n```\n', 'in order to run')).toBe(true)
  })

  it('leaves the prose beside a fenced block editable', () => {
    expect(sealed('In order to run this:\n\n```\ncode\n```\n', 'In order to')).toBe(false)
  })

  it('seals an inline code span', () => {
    expect(sealed('Call `in order to` here.', 'in order to')).toBe(true)
  })

  it('seals a code span written with a doubled backtick', () => {
    expect(sealed('Use `` ` `` for that.', '`')).toBe(true)
  })

  it('seals a blockquote', () => {
    expect(sealed('> Let us dive in to the topic.\n', 'dive in')).toBe(true)
  })

  it('seals a URL', () => {
    expect(sealed('See https://example.com/in-order-to for more.', 'in-order-to')).toBe(true)
  })

  it('seals a Markdown link target but not its visible text', () => {
    const text = 'Read [the delve guide](https://example.com/delve).'
    expect(sealed(text, 'https://example.com/delve')).toBe(true)
    expect(sealed(text, 'the delve guide')).toBe(false)
  })

  it('seals an HTML tag and its attributes', () => {
    expect(sealed('<img alt="in order to" src="a.png"> and prose.', 'alt="in order to"')).toBe(true)
  })

  it('seals a quoted phrase', () => {
    expect(sealed('He wrote "let us dive in" in the memo.', 'dive in')).toBe(true)
  })

  it('does not seal the prose around a quotation', () => {
    expect(sealed('In order to quote him: "hello".', 'In order to')).toBe(false)
  })

  it('refuses to seal quotations when they are most of the document', () => {
    // A transcript that is more quotation than prose would otherwise come out
    // of every style pass byte-identical, which reads as "nothing to fix"
    // rather than as "the guard disabled itself".
    const text = `"${'quoted '.repeat(40)}" ok`
    expect(sealed(text, 'quoted')).toBe(false)
  })

  it('seals frontmatter', () => {
    expect(sealed('---\ngenerator: in order to\n---\n\nBody.', 'in order to')).toBe(true)
  })

  it('seals an HTML entity', () => {
    expect(sealed('Tom &amp; Jerry', '&amp;')).toBe(true)
  })

  it('leaves an ordinary sentence entirely editable', () => {
    // The most important negative: on plain prose the guard must do nothing at
    // all, or every rule downstream silently stops working.
    const text = 'In order to finish, we utilize the report.'
    expect([...protectedMask(text)].some(Boolean)).toBe(false)
  })
})

describe('replaceInProse', () => {
  it('replaces in prose', () => {
    const { output, count } = replaceInProse('In order to win.', /\bin order to\b/gi, () => 'To')
    expect(output).toBe('To win.')
    expect(count).toBe(1)
  })

  it('skips a match inside a sealed region', () => {
    const text = 'Run `in order to` now.'
    expect(replaceInProse(text, /\bin order to\b/gi, () => 'to').output).toBe(text)
  })

  it('replaces some matches and skips others in one pass', () => {
    const text = 'In order to run `in order to`, read on.'
    const { output, count } = replaceInProse(text, /\bin order to\b/gi, () => 'to')
    expect(count).toBe(1)
    expect(output).toBe('to run `in order to`, read on.')
  })

  it('keeps offsets aligned when the replacement is longer than the match', () => {
    // The mask indexes the input while the output is assembled beside it. A
    // pass that rewrote the string in place would shift the mask under itself
    // and start sealing the wrong bytes after the first growing replacement.
    const text = 'a a a `a` a'
    const { output } = replaceInProse(text, /a/g, () => 'bbbb')
    expect(output).toBe('bbbb bbbb bbbb `a` bbbb')
  })

  it('is a no-op when nothing matches', () => {
    expect(replaceInProse('nothing here', /zzz/g, () => 'x').output).toBe('nothing here')
  })
})

describe('paragraphsOf', () => {
  it('returns each paragraph separately, so a rule can measure per paragraph', () => {
    expect(paragraphsOf('One — two.\n\nThree.')).toEqual(['One — two.', 'Three.'])
  })

  it('leaves out code, headings and blockquotes', () => {
    const text = '# Title\n\nReal prose.\n\n```\ncode\n```\n\n> quoted\n'
    expect(paragraphsOf(text)).toEqual(['Real prose.'])
  })

  it('is empty on a document with no prose', () => {
    expect(paragraphsOf('```\ncode\n```')).toEqual([])
  })
})

// The seal has one failure mode that looks exactly like success: sealing so
// much of a document that every style rule becomes a no-op, and the report says
// "nothing to fix". These are the rows for it.

describe('the guard cannot disable itself', () => {
  it('does not let two stray backticks seal the prose between them', () => {
    const text = [
      'To type a backtick ` press the key under escape.',
      '',
      'In order to proceed, we utilize the report. I hope this helps!',
      '',
      'Later, the same key ` appears again in this sentence.',
    ].join('\n')

    expect(sealed(text, 'In order to proceed')).toBe(false)
    expect(sealed(text, 'utilize')).toBe(false)
  })

  it('still seals a real single-line code span', () => {
    expect(sealed('Call `in order to` here.', 'in order to')).toBe(true)
  })

  it('does not read a leading horizontal rule as frontmatter', () => {
    // A `---` at the top with prose under it is a rule, not frontmatter. Reading
    // it as frontmatter sealed the whole body to the next `---` in the file.
    const text = [
      '---',
      '',
      'In order to proceed, we utilize the report.',
      '',
      '---',
      '',
      'More.',
    ].join('\n')
    expect(kinds(text)).not.toContain('frontmatter')
    expect(sealed(text, 'In order to proceed')).toBe(false)
  })

  it('still reads real frontmatter as frontmatter', () => {
    expect(kinds('---\ntitle: x\ngenerator: gpt\n---\n\nBody')[0]).toBe('frontmatter')
  })

  it('falls back to block seals when the inline patterns swallow the document', () => {
    // An unbalanced backtick re-pairs every later span. Rather than return a
    // mask that hides most of the file, the inline pass is dropped and the
    // unambiguous block seals are kept.
    const text = `A \` stray backtick. ${'Ordinary prose that should stay editable. '.repeat(6)}\` And another.`
    const mask = protectedMask(text)
    const share = [...mask].filter(Boolean).length / text.length
    expect(share).toBeLessThan(0.7)
  })
})
