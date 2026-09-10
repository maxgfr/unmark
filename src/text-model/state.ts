// Where the model is right now, shared between the worker client and the page.
//
// Kept apart from client.ts so the settings panel can subscribe without
// pulling the rewrite pipeline into the first bundle; the actions that change
// this state are still imported on demand.

/**
 * `idle` — nothing in memory. `loading` — files are being fetched or the
 * weights are being sent to the GPU; `detail` is the runtime's own progress
 * line. `ready` — loaded and answering. `error` — the last load or answer
 * failed; the worker has been dropped so the next use starts clean.
 */
export interface ModelState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  detail: string
}

let state: ModelState = { phase: 'idle', detail: '' }
const listeners = new Set<(state: ModelState) => void>()

export function setModelState(next: ModelState): void {
  state = next
  for (const listener of listeners) listener(state)
}

export function modelState(): ModelState {
  return state
}

export function subscribeModel(listener: (state: ModelState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
