import { expect, it } from 'vitest'
import { modelText } from './response.ts'

it('removes the empty thinking header inserted by WebLLM in non-thinking mode', () => {
  expect(modelText('<think>\n\n</think>\n\nBonjour, c’est cool !')).toBe('Bonjour, c’est cool !')
})
it('does not remove source content that mentions thinking tags', () => {
  const source = 'Example: `<think>private</think>`.'
  expect(modelText('<think>\n\n</think>\n\n' + source)).toBe(source)
  const literal = '<think>\n\n</think>\n\nLiteral tags in a document.'
  expect(modelText('<think>\n\n</think>\n\n' + literal)).toBe(literal)
})
