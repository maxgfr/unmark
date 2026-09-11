import TextWorker from './text.worker.ts?worker'
import { type Generate } from '../core/rewrite-loop.ts'
import { rewriteDocument } from '../core/rewrite-document.ts'
import { ultraClean } from '../core/ultra.ts'
import { localRewritePrompt } from './prompt.ts'
import { modelState, setModelState as setState } from './state.ts'

let worker: Worker | undefined
let nextId = 0
let running = false

export async function canDeepClean(): Promise<boolean> {
  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter: () => Promise<{ features: { has: (name: string) => boolean } } | null>
      }
    }
  ).gpu
  try {
    return (await gpu?.requestAdapter())?.features.has('shader-f16') ?? false
  } catch {
    return false
  }
}

export function releaseTextModel(): void {
  worker?.terminate()
  worker = undefined
  setState({ phase: 'idle', detail: '' })
}

type Reply = { kind: string; id?: number; text: string }

/**
 * One request to the worker, answered by the message carrying the same id.
 *
 * Progress lines update the shared model state as well as the caller, so the
 * settings panel shows a download that Clean text started, and Clean text's
 * status line shows one the panel started.
 */
function ask(
  message: { id: number; kind: 'prepare' } | { id: number; prompt: string },
  signal: AbortSignal,
  onProgress?: (text: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    worker ??= new TextWorker()
    const current = worker
    const dispose = () => {
      current.removeEventListener('message', handle)
      current.removeEventListener('error', crashed)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      dispose()
      releaseTextModel()
      setState({ phase: 'error', detail: error.message })
      reject(error)
    }
    const abort = () => {
      dispose()
      releaseTextModel()
      reject(signal.reason)
    }
    const crashed = () => fail(new Error('The local model stopped. Retry or use basic cleaning.'))
    const handle = (event: MessageEvent<Reply>) => {
      if (event.data.kind === 'progress') {
        setState({ phase: 'loading', detail: event.data.text })
        onProgress?.(event.data.text)
        return
      }
      if (event.data.id !== message.id) return
      if (event.data.kind === 'answer' || event.data.kind === 'ready') {
        dispose()
        setState({ phase: 'ready', detail: '' })
        resolve(event.data.text)
      } else fail(new Error(event.data.text))
    }
    signal.addEventListener('abort', abort, { once: true })
    current.addEventListener('message', handle)
    current.addEventListener('error', crashed)
    if (signal.aborted) {
      abort()
      return
    }
    if (modelState().phase !== 'ready')
      setState({ phase: 'loading', detail: 'Loading the local model…' })
    current.postMessage(message)
  })
}

/** Downloads the files if needed and loads the model, without rewriting anything. */
export async function prepareTextModel(signal: AbortSignal): Promise<void> {
  if (running) throw new Error('A rewrite is already running.')
  if (!(await canDeepClean()))
    throw new Error('AI rewriting needs WebGPU with shader-f16. Basic cleaning is ready.')
  signal.throwIfAborted()
  running = true
  try {
    await ask({ id: ++nextId, kind: 'prepare' }, signal)
  } finally {
    running = false
  }
}

export async function deepClean(
  text: string,
  signal: AbortSignal,
  onProgress: (text: string) => void,
  mode: 'deep' | 'ultra' = 'deep',
) {
  if (running) throw new Error('A rewrite is already running.')
  if (!(await canDeepClean()))
    throw new Error('AI rewriting needs WebGPU with shader-f16. Basic cleaning is ready.')
  signal.throwIfAborted()
  running = true
  try {
    const generate: Generate = (prompt, attemptSignal) =>
      ask({ id: ++nextId, prompt }, attemptSignal, onProgress)
    const options = { timeoutMs: 180_000, signal, onProgress, makePrompt: localRewritePrompt }
    return mode === 'ultra'
      ? await ultraClean(text, generate, options)
      : await rewriteDocument(text, generate, { ...options, attempts: 2 })
  } finally {
    running = false
  }
}
