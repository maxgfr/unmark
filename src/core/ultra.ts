import { cleanText, PLAIN, type TextOptions } from './text/index.ts'
import { buildBrief, type briefToPrompt } from './rewrite.ts'
import { rewriteLoop, type Generate, type RewriteOutcome } from './rewrite-loop.ts'

/** Full deterministic cleanup without destructive multilingual normalisation. */
export const ULTRA_OPTIONS: TextOptions = { ...PLAIN, paranoid: false, confusables: false }

/** Check the final cleaned candidate, so a rewrite cannot reintroduce supported marks. */
export async function ultraClean(
  text: string,
  generate: Generate,
  options: {
    signal?: AbortSignal
    onProgress?: (message: string) => void
    timeoutMs?: number
    makePrompt?: typeof briefToPrompt
  } = {},
): Promise<RewriteOutcome> {
  const baseline = cleanText(text, ULTRA_OPTIONS).output
  if (!baseline.trim()) {
    return { kind: 'accepted', text: baseline, attempts: 0, notes: [] }
  }
  const outcome = await rewriteLoop(
    baseline,
    buildBrief(baseline),
    async (prompt, signal) => cleanText(await generate(prompt, signal), ULTRA_OPTIONS).output,
    { ...options, attempts: 3 },
  )
  // A failed candidate must never replace the usable deterministic result.
  return outcome.kind === 'accepted' ? outcome : { ...outcome, text: baseline }
}
