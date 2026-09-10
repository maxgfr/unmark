import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_FILES, RUNTIME_FILES } from './manifest.ts'
import { deleteModelStorage, modelEntries, modelStorage } from './storage.ts'

const ROOT = new URL('https://example.test/unmark/vendor/text/resolve/abc/')
const TOTAL = RUNTIME_FILES.length

/** A Cache API stand-in: one map per named store, keyed by URL. */
function fakeCaches(seed: Record<string, string[]> = {}) {
  const stores = new Map<string, Set<string>>()
  for (const [name, urls] of Object.entries(seed)) stores.set(name, new Set(urls))
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Set<string>()
      stores.set(name, store)
      return {
        match: async (url: string) => (store.has(url) ? {} : undefined),
        delete: async (url: string) => store.delete(url),
      }
    },
  }
  return { caches, stores }
}

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches
})

describe('modelEntries', () => {
  it('addresses each downloaded file by its exact URL under the model root', () => {
    const entries = modelEntries(ROOT)
    expect(entries.map((entry) => entry.url)).toEqual(
      RUNTIME_FILES.map((file) => `${ROOT.href}${file}`),
    )
    expect(new Set(entries.map((entry) => entry.scope))).toEqual(
      new Set(['webllm/wasm', 'webllm/config', 'webllm/model']),
    )
  })

  it('leaves out the served files the runtime never fetches', () => {
    const urls = new Set(modelEntries(ROOT).map((entry) => entry.url))
    for (const file of ['vocab.json', 'merges.txt', 'tokenizer_config.json'])
      expect(urls.has(`${ROOT.href}${file}`)).toBe(false)
  })
})

describe('modelStorage', () => {
  it('reports nothing downloaded without a Cache API', async () => {
    expect(await modelStorage(ROOT)).toEqual({ cached: 0, total: TOTAL })
  })

  it('counts only the downloaded files that are present, store by store', async () => {
    const { caches } = fakeCaches({
      'webllm/wasm': [`${ROOT.href}model.wasm`],
      'webllm/model': [`${ROOT.href}tokenizer.json`, `${ROOT.href}params_shard_0.bin`],
      // A stale file in the wrong store is not the pinned one.
      'webllm/config': [`${ROOT.href}tokenizer.json`],
    })
    ;(globalThis as { caches?: unknown }).caches = caches
    expect(await modelStorage(ROOT)).toEqual({ cached: 3, total: TOTAL })
  })

  it('reads a failing Cache API as nothing downloaded', async () => {
    ;(globalThis as { caches?: unknown }).caches = {
      open: async () => {
        throw new Error('blocked')
      },
    }
    expect(await modelStorage(ROOT)).toEqual({ cached: 0, total: TOTAL })
  })

  it('reads a full download as complete, so Downloaded is reachable', async () => {
    const seed: Record<string, string[]> = {}
    for (const { scope, url } of modelEntries(ROOT)) (seed[scope] ??= []).push(url)
    ;(globalThis as { caches?: unknown }).caches = fakeCaches(seed).caches
    expect(await modelStorage(ROOT)).toEqual({ cached: TOTAL, total: TOTAL })
  })
})

describe('deleteModelStorage', () => {
  it('removes every pinned file, including ones this runtime never fetches', async () => {
    const seed: Record<string, string[]> = { 'webllm/model': [] }
    for (const { scope, url } of modelEntries(ROOT)) (seed[scope] ??= []).push(url)
    // An older runtime cached the tokenizer fallbacks; they must go too.
    for (const file of ['vocab.json', 'merges.txt', 'tokenizer_config.json'])
      seed['webllm/model']?.push(`${ROOT.href}${file}`)
    seed['webllm/model']?.push('https://example.test/unmark/vendor/other/keep.bin')
    const { caches, stores } = fakeCaches(seed)
    ;(globalThis as { caches?: unknown }).caches = caches
    expect(await deleteModelStorage(ROOT)).toBe(MODEL_FILES.length)
    expect(await modelStorage(ROOT)).toEqual({ cached: 0, total: TOTAL })
    expect([...(stores.get('webllm/model') ?? [])]).toEqual([
      'https://example.test/unmark/vendor/other/keep.bin',
    ])
  })

  it('reports zero when nothing was there', async () => {
    ;(globalThis as { caches?: unknown }).caches = fakeCaches().caches
    expect(await deleteModelStorage(ROOT)).toBe(0)
  })
})
