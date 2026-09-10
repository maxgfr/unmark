import { briefToPrompt, verifyRewrite, type Brief, type RewriteVerdict } from './rewrite.ts'

export interface RewriteOutcome {
  kind: 'prompt' | 'accepted' | 'rejected' | 'unavailable'
  text: string
  verdict?: RewriteVerdict | undefined
  attempts: number
  notes: string[]
}

export type Generate = (prompt: string, signal: AbortSignal) => Promise<string>

/** Transport-independent loop. A late or cancelled answer can never be accepted. */
export async function rewriteLoop(
  text: string,
  brief: Brief,
  generate: Generate,
  options: {
    attempts?: number
    timeoutMs?: number
    signal?: AbortSignal
    onProgress?: (message: string) => void
    makePrompt?: typeof briefToPrompt
  } = {},
): Promise<RewriteOutcome> {
  const attempts = options.attempts ?? 3
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Rewrite attempts must be a positive whole number.')
  }
  const prompt = (options.makePrompt ?? briefToPrompt)(text, brief)
  let verdict: RewriteVerdict | undefined
  let candidate = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => controller.abort(new Error('Rewrite cancelled.'))
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (options.signal?.aborted) cancel()
      controller.signal.throwIfAborted()
      const aimed = verdict
        ? `${prompt}\n\nPREVIOUS CANDIDATE:\n${candidate}\n\nCORRECT THESE FAILURES:\n${verdict.failures.map((failure) => `${failure.what}: ${failure.detail}`).join('\n')}`
        : prompt
      options.onProgress?.(`Rewriting: attempt ${attempt} of ${attempts}.`)
      // Race as well as abort: injected transports may ignore the signal.
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        })
        timer = setTimeout(
          () => controller.abort(new Error('Rewrite timed out. Try a shorter passage.')),
          options.timeoutMs ?? 120_000,
        )
      })
      // oxlint-disable-next-line no-await-in-loop -- each attempt corrects the last
      candidate = (await Promise.race([generate(aimed, controller.signal), interrupted])).trim()
      controller.signal.throwIfAborted()
      verdict = verifyRewrite(text, candidate, brief)
      if (verdict.ok)
        return { kind: 'accepted', text: candidate, verdict, attempts: attempt, notes: [] }
    } catch (error) {
      return {
        kind: 'unavailable',
        text: '',
        attempts: attempt - 1,
        notes: [
          error instanceof Error ? error.message : 'The model could not complete the rewrite.',
        ],
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
  }
  return {
    kind: 'rejected',
    text: candidate,
    verdict,
    attempts,
    notes: [
      'The AI rewrite was not used.',
      ...[
        ...new Set(verdict?.failures.map((failure) => `${failure.what}: ${failure.detail}.`)),
      ].slice(0, 3),
    ],
  }
}
