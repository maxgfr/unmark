import { afterEach, expect, it, vi } from 'vitest'
import { buildBrief } from '../core/rewrite.ts'
import { runRewrite } from './rewrite.ts'
afterEach(() => vi.unstubAllGlobals())
const source = 'The report arrived.'
it('emits destination before the request and accepts a valid local response', async () => {
  const events: string[] = []
  vi.stubGlobal('fetch', async () => {
    events.push('request')
    return new Response(JSON.stringify({ response: source }))
  })
  const result = await runRewrite(source, buildBrief(source), {
    onNote: (note) => events.push(note),
  })
  expect(result.kind).toBe('accepted')
  expect(events[0]).toContain('Local only')
  expect(events[1]).toBe('request')
})
it.each([
  [() => new Response('{}'), 'no text'],
  [() => new Response('invalid'), 'invalid JSON'],
  [() => new Response('', { status: 503 }), 'HTTP 503'],
])('reports malformed or unavailable model responses', async (response, message) => {
  vi.stubGlobal('fetch', async () => response())
  const result = await runRewrite(source, buildBrief(source))
  expect(result.kind).toBe('unavailable')
  expect(result.notes.join()).toContain(message)
})
it('print prompt performs no request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect((await runRewrite(source, buildBrief(source), { printPrompt: true })).kind).toBe('prompt')
  expect(fetch).not.toHaveBeenCalled()
})
