import TextWorker from './text.worker.ts?worker'
import { buildBrief } from '../core/rewrite.ts'
import { rewriteLoop, type Generate } from '../core/rewrite-loop.ts'
import { ultraClean } from '../core/ultra.ts'
import { localRewritePrompt } from './prompt.ts'

let worker: Worker | undefined
let nextId = 0
let running = false

export async function canDeepClean(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu
  try {
    return !!(await gpu?.requestAdapter())
  } catch {
    return false
  }
}

export function releaseTextModel(): void {
  worker?.terminate()
  worker = undefined
}

export async function deepClean(
  text: string,
  signal: AbortSignal,
  onProgress: (text: string) => void,
  mode: 'deep' | 'ultra' = 'deep',
) {
  if (running) throw new Error('A rewrite is already running.')
  if (!(await canDeepClean())) throw new Error('Deep clean needs WebGPU. Basic cleaning is ready.')
  signal.throwIfAborted()
  running = true
  try {
    const generate: Generate = (prompt, attemptSignal) =>
      new Promise<string>((resolve, reject) => {
        worker ??= new TextWorker()
        const current = worker
        const id = ++nextId
        const dispose = () => {
          current.removeEventListener('message', message)
          current.removeEventListener('error', error)
          attemptSignal.removeEventListener('abort', abort)
        }
        const abort = () => {
          dispose()
          releaseTextModel()
          reject(attemptSignal.reason)
        }
        const error = () => {
          dispose()
          releaseTextModel()
          reject(new Error('The local model stopped. Retry or use basic cleaning.'))
        }
        const message = (event: MessageEvent<{ kind: string; id?: number; text: string }>) => {
          if (event.data.kind === 'progress') {
            onProgress(event.data.text)
            return
          }
          if (event.data.id !== id) return
          dispose()
          if (event.data.kind === 'answer') resolve(event.data.text)
          else {
            releaseTextModel()
            reject(new Error(event.data.text))
          }
        }
        attemptSignal.addEventListener('abort', abort, { once: true })
        current.addEventListener('message', message)
        current.addEventListener('error', error)
        if (attemptSignal.aborted) {
          abort()
          return
        }
        current.postMessage({ id, prompt })
      })
    const options = { timeoutMs: 180_000, signal, onProgress, makePrompt: localRewritePrompt }
    return mode === 'ultra'
      ? await ultraClean(text, generate, options)
      : await rewriteLoop(text, buildBrief(text), generate, { ...options, attempts: 2 })
  } finally {
    running = false
  }
}
