// A plain RGBA buffer, deliberately not ImageData.
//
// Everything in src/image operates on this shape, which is structurally
// compatible with ImageData but does not require the DOM to construct. That is
// what lets the resampling, the overlay detector and the inpainter be tested in
// Node against buffers built by hand, rather than only inside a browser where
// an assertion costs a screenshot.

export interface Raster {
  /**
   * Pinned to ArrayBuffer rather than left as the default ArrayBufferLike.
   *
   * ImageData and Blob both refuse a view that might be backed by a
   * SharedArrayBuffer, and every buffer here is allocated locally or handed
   * over by getImageData — so the narrower type is the true one, and stating it
   * removes a cast at every boundary instead of adding one.
   */
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

export const createRaster = (width: number, height: number): Raster => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
})

export const cloneRaster = (raster: Raster): Raster => ({
  data: new Uint8ClampedArray(raster.data),
  width: raster.width,
  height: raster.height,
})

/** Index of the red channel for a pixel. Green, blue and alpha follow it. */
export const at = (raster: Raster, x: number, y: number): number => (y * raster.width + x) * 4

export const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value

/**
 * A seeded generator, so "add noise" is reproducible.
 *
 * Math.random would make every run of the same operation produce a different
 * file, which means a test cannot assert what it did and a user cannot repeat
 * a result they liked.
 */
export function xorshift(seed: number): () => number {
  let state = seed || 0x2f6e2b1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 100_000) / 100_000
  }
}
