import { describe, expect, it, vi } from 'vitest'
import { ultraClean } from './ultra.ts'

const source = 'Sales reached 10 units.'

describe('Ultra text cleaning', () => {
  it('cleans both the source and the candidate before checking facts', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue(
        'In order to proceed\u200B — we sold 10 units. https://example.com/?utm_source=chatgpt.com',
      )
    const result = await ultraClean(
      'In order to proceed\u200B — we sold 10 units. https://example.com/?utm_source=chatgpt.com',
      generate,
    )
    expect(result.kind).toBe('accepted')
    expect(result.text).toBe('To proceed - we sold 10 units. https://example.com/')
    expect(result.verdict?.ok).toBe(true)
    expect(generate.mock.calls[0]?.[0]).not.toContain('\u200B')
    expect(generate.mock.calls[0]?.[0]).not.toContain('utm_source')
  })

  it('uses a third attempt when the first two change a fact', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce('Sales reached 99 units.')
      .mockResolvedValueOnce('Sales reached 42 units.')
      .mockResolvedValueOnce('The team sold 10 units.')
    const result = await ultraClean(source, generate)
    expect(result.kind).toBe('accepted')
    expect(result.attempts).toBe(3)
    expect(result.text).toBe('The team sold 10 units.')
    expect(generate.mock.calls[2]?.[0]).toContain('Sales reached 42 units.')
  })

  it('returns cleaned source after three rejected candidates', async () => {
    const generate = vi.fn().mockResolvedValue('Sales reached 99 units.')
    const result = await ultraClean('Sales\u200B reached 10 units.', generate)
    expect(result.kind).toBe('rejected')
    expect(result.text).toBe(source)
    expect(generate).toHaveBeenCalledTimes(3)
  })

  it('keeps code and quotations and rejects a rewrite that changes them', async () => {
    const original = 'Run `const x = "—"` and say "keep this quotation".'
    const result = await ultraClean(
      original,
      async () => 'Run `const x = "-"` and say "a new quotation".',
    )
    expect(result.kind).toBe('rejected')
    expect(result.text).toBe(original)
    expect(result.verdict?.failures.some((failure) => failure.kind === 'protected')).toBe(true)
  })

  it('preserves emoji, script joiners and multilingual letters during cleanup', async () => {
    const text = 'Résumé 👨‍👩‍👧 می\u200Cروم Ελληνικά Кириллица.'
    const result = await ultraClean(text, async () => text)
    expect(result.kind).toBe('accepted')
    expect(result.text).toBe(text)
  })

  it.each(['\u200B', ' \u200B\n'])(
    'does not generate for a cleaned blank source %j',
    async (text) => {
      const generate = vi.fn()
      const result = await ultraClean(text, generate)
      expect(result.text.trim()).toBe('')
      expect(result.attempts).toBe(0)
      expect(generate).not.toHaveBeenCalled()
    },
  )

  it('returns the baseline on cancellation without calling the model', async () => {
    const controller = new AbortController()
    controller.abort()
    const generate = vi.fn()
    const result = await ultraClean(source, generate, { signal: controller.signal })
    expect(result.kind).toBe('unavailable')
    expect(result.text).toBe(source)
    expect(generate).not.toHaveBeenCalled()
  })

  it('returns the baseline after a model failure or timeout', async () => {
    const failed = await ultraClean(source, async () => {
      throw new Error('Model unavailable')
    })
    expect(failed.kind).toBe('unavailable')
    expect(failed.text).toBe(source)
    const timedOut = await ultraClean(source, () => new Promise(() => {}), { timeoutMs: 5 })
    expect(timedOut.kind).toBe('unavailable')
    expect(timedOut.text).toBe(source)
  })
})
