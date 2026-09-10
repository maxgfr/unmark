import { expect, it } from 'vitest'
import assets from '../../scripts/text-model-assets.json'
import { MODEL_BASE, MODEL_BYTES, MODEL_FILES } from './manifest.ts'

it('keeps the download size and runtime allowlist aligned with the pinned model artifacts', () => {
  expect(assets.reduce((total, asset) => total + asset.bytes, 0)).toBe(MODEL_BYTES)
  const directory = MODEL_BASE.slice('vendor/'.length)
  expect(assets.map((asset) => asset.file.slice(directory.length)).sort()).toEqual(
    [...MODEL_FILES].sort(),
  )
  expect(assets.every((asset) => asset.file.startsWith(directory))).toBe(true)
})
