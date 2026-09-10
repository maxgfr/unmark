import { expect, it } from 'vitest'
import { buildBrief } from '../core/rewrite.ts'
import { localRewritePrompt } from './prompt.ts'

it('gives a short editing task for a short French message without report scaffolding', () => {
  const source = 'bonjour c cool'
  const prompt = localRewritePrompt(source, buildBrief(source))
  expect(prompt).toContain('same language')
  expect(prompt).toContain('Do not add new ideas')
  expect(prompt).toContain('If no changes are needed, copy the text exactly')
  expect(prompt.endsWith(`Text:\n${source}`)).toBe(true)
  expect(prompt).not.toContain('WHAT IS WRONG WITH IT')
  expect(prompt).not.toContain('nothing extracted')
})
