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

/**
 * The longest side a *visible* canvas is allowed to have.
 *
 * The raster stays whatever size it is; this only bounds the DOM element. 2048
 * covers a wide layout on a 2x display with room to spare, and everything
 * beyond it was being downscaled by CSS anyway.
 */
const MAX_DISPLAY_EDGE = 2048

/**
 * Draw a raster into a visible canvas, at a size a browser can actually hold.
 *
 * This used to size the element to the full raster, so a 12-megapixel photo
 * became a 12-megapixel canvas element that CSS then drew at 600 pixels wide.
 * The backing store is 4 bytes a pixel and the compositor keeps its own copy,
 * so the display of an image cost more memory than the image — and on iOS,
 * where canvas area is capped, the element silently came back blank.
 *
 * The editing still happens at full resolution: the raster is never resampled,
 * and a selection is mapped through the raster's dimensions rather than the
 * element's. Only what is shown shrinks.
 */
export function paint(canvas: HTMLCanvasElement, raster: Raster): void {
  const longest = Math.max(raster.width, raster.height)
  const scale = longest > MAX_DISPLAY_EDGE ? MAX_DISPLAY_EDGE / longest : 1
  const width = Math.max(1, Math.round(raster.width * scale))
  const height = Math.max(1, Math.round(raster.height * scale))

  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return

  const image = new ImageData(raster.data, raster.width, raster.height)
  if (scale === 1) {
    context.putImageData(image, 0, 0)
    return
  }

  // putImageData ignores the transform and cannot scale, so the full-size
  // pixels go to an offscreen surface first and drawImage does the resampling.
  const source = new OffscreenCanvas(raster.width, raster.height)
  const sourceContext = source.getContext('2d')
  if (!sourceContext) return
  sourceContext.putImageData(image, 0, 0)

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, height)
}

/** An empty raster, for the initial state before anything is loaded. */
export const emptyRaster = (): Raster => createRaster(1, 1)
