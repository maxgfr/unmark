import { describe, expect, it } from 'vitest'
import { readTextual } from './index.ts'
import { png } from '../../test/containers.ts'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('readTextual', () => {
  it('decodes text and names its format from the content, then the name', async () => {
    expect(await readTextual(bytes('Plain words.'), 'a.txt')).toEqual({
      text: 'Plain words.',
      format: 'Text',
    })
    expect((await readTextual(bytes('# Title'), 'a.md'))?.format).toBe('Markdown')
    expect((await readTextual(bytes('<!doctype html><p>x</p>'), 'a.txt'))?.format).toBe('HTML')
  })

  it('refuses bytes that are not text', async () => {
    expect(await readTextual(png([]), 'image.png')).toBeUndefined()
    expect(
      await readTextual(new Uint8Array([0xff, 0xfe, 0x00, 0x41]), 'mystery.bin'),
    ).toBeUndefined()
  })
})
