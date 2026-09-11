// Rewriting a document that is longer than the model can answer in one go.
//
// The local model returns a usable repair up to roughly 250 words. Past that it
// stops returning the whole passage — it drops sentences, the content checks
// correctly report a lost date, and the entire rewrite is refused. A document
// therefore failed as a whole while each of its paragraphs would have passed on
// its own.
//
// So a long document is cut into pieces that tile it, each piece goes through
// the ordinary loop with its own brief and its own verdict, and the results are
// concatenated. Two consequences worth stating plainly:
//
//   a piece that fails keeps its own source, so one stubborn paragraph costs
//   that paragraph rather than the document;
//
//   the checks are per piece. A fact moved from one paragraph to another would
//   read as lost in the first and invented in the second — which is the
//   conservative direction, and the reason pieces are cut at paragraph
//   boundaries wherever the text has any.

import { buildBrief, type briefToPrompt } from './rewrite.ts'
import { rewriteLoop, type Generate, type RewriteOutcome } from './rewrite-loop.ts'
import { chunkDocument, CHUNK_WORDS } from './text/chunk.ts'

export interface DocumentOptions {
  attempts?: number
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
  makePrompt?: typeof briefToPrompt
  /** Words per piece; the default is the measured ceiling with headroom. */
  budget?: number
}

/**
 * Rewrite a document, one model-sized piece at a time.
 *
 * A document that fits in one piece behaves exactly as a direct `rewriteLoop`
 * call, including its outcome kind and notes, so nothing changes for the short texts
 * that already worked.
 */
export async function rewriteDocument(
  text: string,
  generate: Generate,
  options: DocumentOptions = {},
): Promise<RewriteOutcome> {
  const { budget = CHUNK_WORDS, ...loopOptions } = options
  const chunks = chunkDocument(text, budget)
  if (chunks.length <= 1) {
    return rewriteLoop(text, buildBrief(text), generate, loopOptions)
  }

  const pieces: string[] = []
  const notes: string[] = []
  let accepted = 0
  let attempts = 0
  for (const [index, chunk] of chunks.entries()) {
    options.signal?.throwIfAborted()
    options.onProgress?.(`Rewriting section ${index + 1} of ${chunks.length}.`)
    // The blank line between two paragraphs belongs to the document, not to
    // either paragraph, and the loop trims whatever the model returns. Hold it
    // aside and put it back, or the sections come back glued together.
    const body = chunk.text.trimEnd()
    const separator = chunk.text.slice(body.length)
    // oxlint-disable-next-line no-await-in-loop -- one model at a time, in order
    const outcome = await rewriteLoop(body, buildBrief(body), generate, loopOptions)
    attempts += outcome.attempts
    if (outcome.kind === 'unavailable') {
      // The model stopped or the run was cancelled: nothing later can succeed,
      // and a partial document is not what the caller asked for.
      return { ...outcome, attempts }
    }
    if (outcome.kind === 'accepted') {
      accepted += 1
      pieces.push(outcome.text + separator)
    } else {
      pieces.push(chunk.text)
      notes.push(...outcome.notes)
    }
  }

  const joined = pieces.join('')
  if (accepted === 0) {
    return {
      kind: 'rejected',
      text,
      attempts,
      notes: [
        `No section of this text passed the checks (${chunks.length} tried).`,
        ...[...new Set(notes)].slice(0, 2),
      ],
    }
  }
  return {
    kind: 'accepted',
    text: joined,
    attempts,
    notes:
      accepted === chunks.length
        ? []
        : [
            `${accepted} of ${chunks.length} sections were rewritten; the rest were left as they are.`,
          ],
  }
}
