// The browser-only edge of the image pipeline.
//
// Everything else in src/image is arithmetic on a plain RGBA buffer and runs
// under Node in the test suite. Decoding a JPEG and encoding one back are the
// two things that genuinely need the platform, so they are confined here — the
// algorithms never import this file, which is what keeps them testable.

import { createRaster, type Raster } from './raster.ts'

/** Decode any format the browser can read into a plain buffer. */
export async function rasterFromBlob(blob: Blob): Promise<Raster> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('this browser did not provide a 2D canvas context')

    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { data: image.data, width: image.width, height: image.height }
  } finally {
    bitmap.close()
  }
}

function toCanvas(raster: Raster): OffscreenCanvas {
  const canvas = new OffscreenCanvas(raster.width, raster.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('this browser did not provide a 2D canvas context')
  context.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0)
  return canvas
}

/**
 * Encode a buffer back to a file.
 *
 * PNG by default and deliberately: re-encoding a JPEG to strip a watermark
 * would add a second generation of compression loss to a picture the user
 * wanted preserved.
 */
export const rasterToBlob = (raster: Raster, type = 'image/png', quality?: number): Promise<Blob> =>
  toCanvas(raster).convertToBlob(quality === undefined ? { type } : { type, quality })

/**
 * Round-trip through JPEG at a given quality.
 *
 * A disruption in its own right: JPEG throws away high-frequency detail in 8×8
 * blocks, which is where a fragile watermark usually lives. It is also the one
 * operation here that visibly costs quality, so the UI names the price.
 */
export async function requantizeJpeg(raster: Raster, quality = 0.85): Promise<Raster> {
  const blob = await rasterToBlob(raster, 'image/jpeg', quality)
  return rasterFromBlob(blob)
}

/** Draw a raster into a visible canvas, sized to fit its box. */
export function paint(canvas: HTMLCanvasElement, raster: Raster): void {
  canvas.width = raster.width
  canvas.height = raster.height
  const context = canvas.getContext('2d')
  if (!context) return
  context.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0)
}

/** An empty raster, for the initial state before anything is loaded. */
export const emptyRaster = (): Raster => createRaster(1, 1)
