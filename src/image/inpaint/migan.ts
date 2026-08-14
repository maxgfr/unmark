// AI inpainting: MI-GAN 512 Places2, run in the browser through onnxruntime-web.
//
// Telea fills a hole by continuing its edges inward, which is right for smooth
// or repetitive surroundings and obviously wrong across a face or a texture
// boundary. MI-GAN was trained on what pictures look like, so it invents
// plausible content instead of extending a gradient — at the cost of a 28 MB
// model and a 13 MB runtime, which is why it is opt-in and downloaded once.
//
// Everything is served from this site's own origin. onnxruntime-web fetches its
// wasm from a CDN by default, which the Content-Security-Policy would block and
// the privacy gate would fail on; `wasmPaths` points it at our own copy instead.
//
// The graph, confirmed against the file rather than assumed:
//   image  uint8 [1, 3, H, W]   CHW, RGB
//   mask   uint8 [1, 1, H, W]   0 marks a hole, 255 marks known pixels
//   result uint8 [1, 3, H, W]
//
// It accepts any size that is a multiple of 8, not only 512.

import { at, cloneRaster, type Raster } from '../raster.ts'

const MODEL_URL = `${import.meta.env.BASE_URL}vendor/models/migan-pipeline-v2.onnx`

/** Roughly what the browser has to download the first time, for the prompt. */
export const MODEL_BYTES = 28_079_181
export const RUNTIME_BYTES = 13_000_000

type Session = {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Uint8Array }>>
}

let sessionPromise: Promise<Session> | undefined

/** How far MI-GAN is allowed to see around a hole, and how big a tile can get. */
const MIN_WINDOW = 256
const MAX_WINDOW = 1024
const ALIGN = 8

const alignUp = (value: number) => Math.ceil(value / ALIGN) * ALIGN

export interface LoadProgress {
  (stage: 'runtime' | 'model' | 'ready'): void
}

/**
 * Load the runtime and the weights once, and keep them.
 *
 * Concurrent callers share the same promise: a second click while the first
 * download is in flight must not start a second 28 MB fetch.
 */
export async function loadMigan(onProgress?: LoadProgress): Promise<Session> {
  if (sessionPromise) return sessionPromise

  sessionPromise = (async () => {
    onProgress?.('runtime')
    // Dynamic, so neither the runtime glue nor anything it pulls in lands in
    // the main bundle for the visitors who never open this.
    // The `/wasm` subpath, not the default export: the default is the 'all'
    // bundle, which asks for the 26 MB WebGPU runtime. This project ships the
    // backend it verified, and that is the plain wasm one.
    // `wasmPaths` is deliberately not set. The `.bundle` build resolves its own
    // wasm through `new URL(..., import.meta.url)`, which Vite rewrites to a
    // hashed asset in our own dist — so the runtime is same-origin and emitted
    // exactly once. Pointing wasmPaths at a hand-copied directory also worked,
    // but left Vite emitting a second unused 13 MB copy alongside it.
    const ort = await import('onnxruntime-web/wasm')

    onProgress?.('model')
    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })

    onProgress?.('ready')
    return session as unknown as Session
  })()

  try {
    return await sessionPromise
  } catch (error) {
    // A failed load must not poison every later attempt.
    sessionPromise = undefined
    throw error
  }
}

export const isMiganLoaded = (): boolean => sessionPromise !== undefined

interface Window {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The tile to run the model over: the hole plus enough context to fill it from.
 *
 * Running a 4000px photograph through a 512px model would be slow and would
 * spend the model's capacity on pixels nowhere near the hole. A window around
 * the mask gives it the surroundings that actually inform the fill.
 */
function windowFor(raster: Raster, mask: Uint8Array): Window | undefined {
  let minX = raster.width
  let minY = raster.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!mask[y * raster.width + x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return undefined

  const holeWidth = maxX - minX + 1
  const holeHeight = maxY - minY + 1
  const side = Math.min(
    MAX_WINDOW,
    Math.max(MIN_WINDOW, alignUp(Math.max(holeWidth, holeHeight) * 3)),
    alignUp(Math.min(raster.width, raster.height)),
  )

  const centreX = Math.round((minX + maxX) / 2)
  const centreY = Math.round((minY + maxY) / 2)

  return {
    x: Math.max(0, Math.min(raster.width - side, centreX - Math.round(side / 2))),
    y: Math.max(0, Math.min(raster.height - side, centreY - Math.round(side / 2))),
    width: side,
    height: side,
  }
}

export interface MiganResult {
  raster: Raster
  /** The tile the model was actually run over, for the report. */
  window: Window
  milliseconds: number
}

/**
 * Fill every pixel the mask marks, using MI-GAN.
 *
 * `mask` is one byte per pixel, non-zero meaning "this is a hole" — the same
 * convention as the Telea inpainter, and inverted here because the model uses
 * the opposite one.
 */
export async function inpaintWithMigan(
  raster: Raster,
  mask: Uint8Array,
  onProgress?: LoadProgress,
): Promise<MiganResult | undefined> {
  const region = windowFor(raster, mask)
  if (!region) return undefined
  if (region.width < ALIGN || region.height < ALIGN) return undefined

  const session = await loadMigan(onProgress)
  const ort = await import('onnxruntime-web/wasm')

  const { width, height } = region
  const plane = width * height
  const image = new Uint8Array(3 * plane)
  const modelMask = new Uint8Array(plane).fill(255)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = at(raster, region.x + x, region.y + y)
      const target = y * width + x
      image[target] = raster.data[source] ?? 0
      image[plane + target] = raster.data[source + 1] ?? 0
      image[2 * plane + target] = raster.data[source + 2] ?? 0
      // 0 marks a hole for this model — the inverse of ours.
      if (mask[(region.y + y) * raster.width + region.x + x]) modelMask[target] = 0
    }
  }

  const started = performance.now()
  const output = await session.run({
    image: new ort.Tensor('uint8', image, [1, 3, height, width]),
    mask: new ort.Tensor('uint8', modelMask, [1, 1, height, width]),
  })
  const milliseconds = Math.round(performance.now() - started)

  const result = output['result']?.data
  if (!result) throw new Error('the model returned no result tensor')

  // Composite: only the masked pixels are taken from the model. Copying the
  // whole tile back would replace real pixels with the model's reconstruction
  // of them, which is a quiet quality loss over the entire window.
  const out = cloneRaster(raster)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = y * width + x
      if (!mask[(region.y + y) * raster.width + region.x + x]) continue

      const destination = at(out, region.x + x, region.y + y)
      out.data[destination] = result[target] ?? 0
      out.data[destination + 1] = result[plane + target] ?? 0
      out.data[destination + 2] = result[2 * plane + target] ?? 0
    }
  }

  return { raster: out, window: region, milliseconds }
}
