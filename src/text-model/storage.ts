// What of the model is on disk, and how to remove it.
//
// WebLLM keeps its downloads in the Cache API keyed by URL, in three named
// stores. Reading those stores directly means the settings panel can answer
// "is the model downloaded?" without loading the runtime, and can honour
// "delete the files" even on a device that cannot run the model at all.

import { cacheScopeOf, MODEL_BASE, MODEL_FILES, RUNTIME_FILES } from './manifest.ts'

export interface ModelStorage {
  /** Files the runtime downloads that are present in the cache. */
  cached: number
  /** Files the runtime downloads, in total. */
  total: number
}

type CacheLike = {
  match: (url: string) => Promise<unknown>
  delete: (url: string) => Promise<boolean>
}
type CachesLike = { open: (name: string) => Promise<CacheLike> }

function stores(): CachesLike | undefined {
  return (globalThis as { caches?: CachesLike }).caches
}

function modelRoot(): URL {
  return new URL(`${import.meta.env.BASE_URL}${MODEL_BASE}`, globalThis.location.origin)
}

/** One entry per file, with the store it lives in and its exact URL. */
function entriesOf(files: readonly string[], root: URL): { scope: string; url: string }[] {
  return files.map((file) => ({ scope: cacheScopeOf(file), url: new URL(file, root).href }))
}

/** The files whose presence answers "is the model downloaded?". */
export function modelEntries(root: URL = modelRoot()): { scope: string; url: string }[] {
  return entriesOf(RUNTIME_FILES, root)
}

export async function modelStorage(root?: URL): Promise<ModelStorage> {
  const caches = stores()
  const entries = modelEntries(root)
  if (!caches) return { cached: 0, total: entries.length }
  try {
    const present = await Promise.all(
      entries.map(
        async ({ scope, url }) => (await (await caches.open(scope)).match(url)) !== undefined,
      ),
    )
    return { cached: present.filter(Boolean).length, total: entries.length }
  } catch {
    // A blocked or absent Cache API reads as "nothing downloaded", which is
    // also what the runtime will find when it looks.
    return { cached: 0, total: entries.length }
  }
}

/**
 * Removes every pinned file from every store, including the three the current
 * runtime never fetches: an older build may have cached them, and "delete the
 * downloaded files" has to mean all of them.
 */
export async function deleteModelStorage(root: URL = modelRoot()): Promise<number> {
  const caches = stores()
  if (!caches) return 0
  const removed = await Promise.all(
    entriesOf(MODEL_FILES, root).map(async ({ scope, url }) =>
      (await caches.open(scope)).delete(url),
    ),
  )
  return removed.filter(Boolean).length
}
