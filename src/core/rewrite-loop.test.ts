import { describe, expect, it, vi } from 'vitest'
import { buildBrief } from './rewrite.ts'
import { rewriteLoop } from './rewrite-loop.ts'

const source = 'Sales reached 10 units.'
describe('rewrite loop', () => {
  it('retries against the rejected candidate, then accepts a preserved fact', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('Sales reached 99 units.')
      .mockResolvedValueOnce('The team sold 10 units.')
    const result = await rewriteLoop(source, buildBrief(source), generate)
    expect(result.kind).toBe('accepted')
    expect(result.attempts).toBe(2)
    expect(generate.mock.calls[1]?.[0]).toContain('Sales reached 99 units.')
    expect(generate.mock.calls[1]?.[0]).toContain('number 10')
  })
  it('does not publish a rejected answer', async () => {
    const result = await rewriteLoop(
      source,
      buildBrief(source),
      async () => 'Sales reached 99 units.',
      { attempts: 2 },
    )
    expect(result.kind).toBe('rejected')
    expect(result.attempts).toBe(2)
  })
  it('times out a transport that ignores cancellation', async () => {
    const result = await rewriteLoop(source, buildBrief(source), () => new Promise(() => {}), {
      timeoutMs: 5,
    })
    expect(result.kind).toBe('unavailable')
    expect(result.notes.join()).toContain('timed out')
  })
  it('never calls a model after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const generate = vi.fn()
    const result = await rewriteLoop(source, buildBrief(source), generate, {
      signal: controller.signal,
    })
    expect(result.kind).toBe('unavailable')
    expect(generate).not.toHaveBeenCalled()
  })
  it('rejects a late answer after cancellation', async () => {
    const controller = new AbortController()
    const result = await rewriteLoop(
      source,
      buildBrief(source),
      async () => {
        controller.abort()
        return source
      },
      { signal: controller.signal },
    )
    expect(result.kind).toBe('unavailable')
  })
})
