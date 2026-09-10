import { expect, it } from 'vitest'
import assets from '../../scripts/text-model-assets.json'
import pkg from '../../package.json'
import {
  cacheScopeOf,
  MODEL_BASE,
  MODEL_BYTES,
  MODEL_FILES,
  RUNTIME_BYTES,
  RUNTIME_FILES,
  RUNTIME_LABEL,
  RUNTIME_VERSION,
} from './manifest.ts'

it('keeps the download size and runtime allowlist aligned with the pinned model artifacts', () => {
  expect(assets.reduce((total, asset) => total + asset.bytes, 0)).toBe(MODEL_BYTES)
  const directory = MODEL_BASE.slice('vendor/'.length)
  expect(assets.map((asset) => asset.file.slice(directory.length)).sort()).toEqual(
    [...MODEL_FILES].sort(),
  )
  expect(assets.every((asset) => asset.file.startsWith(directory))).toBe(true)
})

it('counts as downloaded exactly the files the runtime fetches, and their real size', () => {
  // Evidence: a real headed load fetched these 15 and no others (2026-09-10).
  expect(RUNTIME_FILES).toHaveLength(15)
  expect(RUNTIME_FILES.every((file) => MODEL_FILES.includes(file))).toBe(true)
  expect(MODEL_FILES.filter((file) => !RUNTIME_FILES.includes(file))).toEqual([
    'tokenizer_config.json',
    'vocab.json',
    'merges.txt',
  ])
  const bytesOf = (files: string[]) =>
    assets
      .filter((asset) => files.includes(asset.file.split('/').pop() ?? ''))
      .reduce((total, asset) => total + asset.bytes, 0)
  expect(bytesOf(RUNTIME_FILES)).toBe(RUNTIME_BYTES)
  expect(RUNTIME_BYTES).toBeLessThan(MODEL_BYTES)
})

it('names the runtime version that package.json actually pins', () => {
  expect(pkg.dependencies['@mlc-ai/web-llm']).toBe(RUNTIME_VERSION)
  expect(RUNTIME_LABEL).toBe(`WebLLM ${RUNTIME_VERSION}`)
})

it('maps every pinned file to the store WebLLM keeps it in', () => {
  expect(cacheScopeOf('model.wasm')).toBe('webllm/wasm')
  expect(cacheScopeOf('mlc-chat-config.json')).toBe('webllm/config')
  expect(cacheScopeOf('tokenizer.json')).toBe('webllm/model')
  expect(cacheScopeOf('params_shard_3.bin')).toBe('webllm/model')
  expect(MODEL_FILES.filter((file) => cacheScopeOf(file) === 'webllm/model')).toHaveLength(
    MODEL_FILES.length - 2,
  )
})
