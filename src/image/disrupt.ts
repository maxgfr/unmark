// Signal disruption: breaking marks that live in the exact pixel values.
//
// Some watermarks are not drawn on top of an image, they *are* the image —
// encoded in the low bits, or in a pattern that survives only while the sample
// grid stays put. Those do not need inpainting; they need the pixel values to
// stop being exactly what they were.
//
// Every operation here is honest about being lossy. None of them touches a
// robust watermark (SynthID, Tree-Ring, StableSignature), which is stated on
// the page rather than left for the user to discover.

import { at, clamp, cloneRaster, createRaster, xorshift, type Raster } from './raster.ts'

/**
 * Zero the low bits of every channel.
 *
 * LSB steganography hides a payload in the bit nobody can see. Overwriting that
 * bit destroys the payload and is invisible: one level out of 256 is well below
 * what a display or an eye resolves.
 */
export function scrubLowBits(raster: Raster, bits = 1): Raster {
  const out = cloneRaster(raster)
  const mask = (0xff << bits) & 0xff

  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = (out.data[i] ?? 0) & mask
    out.data[i + 1] = (out.data[i + 1] ?? 0) & mask
    out.data[i + 2] = (out.data[i + 2] ?? 0) & mask
    // Alpha is left alone: flattening it would change which pixels are visible.
  }
  return out
}

const LANCZOS_A = 3

const lanczos = (x: number): number => {
  if (x === 0) return 1
  const a = Math.abs(x)
  if (a >= LANCZOS_A) return 0
  const pix = Math.PI * a
  return (LANCZOS_A * Math.sin(pix) * Math.sin(pix / LANCZOS_A)) / (pix * pix)
}

/**
 * Lanczos-3 resample.
 *
 * Resampling moves every pixel off the grid a mark was embedded against, which
 * is what breaks a fragile watermark. Lanczos rather than bilinear because the
 * point is to keep the picture worth looking at afterwards.
 */
export function resample(raster: Raster, scale: number): Raster {
  const width = Math.max(1, Math.round(raster.width * scale))
  const height = Math.max(1, Math.round(raster.height * scale))
  if (width === raster.width && height === raster.height) return cloneRaster(raster)

  const out = createRaster(width, height)
  // Below 1:1 the filter has to widen or it samples between the input pixels
  // and aliases everything it was meant to smooth.
  const support = Math.max(1, 1 / scale)

  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) / scale - 0.5
    const y0 = Math.max(0, Math.ceil(sourceY - LANCZOS_A * support))
    const y1 = Math.min(raster.height - 1, Math.floor(sourceY + LANCZOS_A * support))

    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) / scale - 0.5
      const x0 = Math.max(0, Math.ceil(sourceX - LANCZOS_A * support))
      const x1 = Math.min(raster.width - 1, Math.floor(sourceX + LANCZOS_A * support))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let total = 0

      for (let sy = y0; sy <= y1; sy += 1) {
        const wy = lanczos((sy - sourceY) / support)
        if (wy === 0) continue

        for (let sx = x0; sx <= x1; sx += 1) {
          const weight = wy * lanczos((sx - sourceX) / support)
          if (weight === 0) continue

          const index = at(raster, sx, sy)
          r += (raster.data[index] ?? 0) * weight
          g += (raster.data[index + 1] ?? 0) * weight
          b += (raster.data[index + 2] ?? 0) * weight
          a += (raster.data[index + 3] ?? 0) * weight
          total += weight
        }
      }

      const target = at(out, x, y)
      const norm = total === 0 ? 1 : total
      out.data[target] = clamp(r / norm, 0, 255)
      out.data[target + 1] = clamp(g / norm, 0, 255)
      out.data[target + 2] = clamp(b / norm, 0, 255)
      out.data[target + 3] = clamp(a / norm, 0, 255)
    }
  }

  return out
}

/**
 * Trim a border off every edge.
 *
 * A watermark keyed to absolute pixel coordinates loses its reference frame
 * when the origin moves. A few pixels are usually enough and usually invisible.
 */
export function cropBorder(raster: Raster, pixels: number): Raster {
  const trim = Math.max(0, Math.min(pixels, Math.floor(Math.min(raster.width, raster.height) / 4)))
  if (trim === 0) return cloneRaster(raster)

  const width = raster.width - trim * 2
  const height = raster.height - trim * 2
  const out = createRaster(width, height)

  for (let y = 0; y < height; y += 1) {
    const from = at(raster, trim, y + trim)
    out.data.set(raster.data.subarray(from, from + width * 4), at(out, 0, y))
  }
  return out
}

/**
 * Add low-amplitude noise.
 *
 * The bluntest instrument here, and the most visible. It raises the noise floor
 * above the amplitude a fragile watermark was embedded at, at the cost of
 * actually degrading the picture — so it is the option offered last.
 */
export function addNoise(raster: Raster, amplitude = 2, seed = 1): Raster {
  const out = cloneRaster(raster)
  const random = xorshift(seed)

  for (let i = 0; i < out.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const jitter = (random() * 2 - 1) * amplitude
      out.data[i + channel] = clamp((out.data[i + channel] ?? 0) + jitter, 0, 255)
    }
  }
  return out
}

export interface DisruptionOptions {
  /** Bits to clear per channel. 0 disables. */
  lowBits?: number
  /** Resample factor, 1 disables. Applied down then back up to the original size. */
  resampleTo?: number
  cropPixels?: number
  noiseAmplitude?: number
  seed?: number
  /** 0–1 JPEG quality. Needs an encoder; without one this leg is skipped. */
  jpegQuality?: number
}

/**
 * A JPEG round trip, supplied by the caller.
 *
 * Encoding a JPEG needs a canvas, and nothing in this directory is allowed to
 * import canvas.ts — that rule is what lets every algorithm here run under Node
 * in the test suite rather than only in a browser. So the one operation that
 * genuinely needs the platform is injected: the page passes `requantizeJpeg`,
 * a test passes a function that pretends, and the sequencing is tested either
 * way.
 */
export interface JpegEncoder {
  (raster: Raster, quality: number): Promise<Raster>
}

/** Crop and resample: the legs that change the picture's size. */
function reshape(raster: Raster, options: DisruptionOptions): Raster {
  let out = cloneRaster(raster)
  if (options.cropPixels) out = cropBorder(out, options.cropPixels)

  if (options.resampleTo && options.resampleTo !== 1) {
    const { width, height } = out
    out = resample(out, options.resampleTo)
    // Back to the original size, so the file stays a drop-in replacement.
    out = resample(out, Math.min(width / out.width, height / out.height))
  }
  return out
}

/** The legs that only touch values, and must run after everything that resamples. */
function scour(raster: Raster, options: DisruptionOptions): Raster {
  let out = raster
  if (options.lowBits) out = scrubLowBits(out, options.lowBits)
  if (options.noiseAmplitude) out = addNoise(out, options.noiseAmplitude, options.seed ?? 1)
  return out
}

/**
 * Run the selected disruptions in the order that does least damage.
 *
 * Crop first (it only removes), then resample, then the JPEG round trip, then
 * the low-bit scrub, then noise. Scrubbing before a resample or a JPEG pass
 * would be pointless — both recompute every low bit anyway — and noise added
 * before the JPEG pass would be half thrown away by it.
 *
 * Synchronous unless an encoder is passed, and the overloads say so rather than
 * leaving it to be discovered. Making the whole function async would have been
 * tidier to read and would have forced every existing caller and every existing
 * test to await a result that is, in the no-JPEG case, already sitting there.
 * The two signatures are not a convenience: without an encoder there is nothing
 * asynchronous in here to wait for, and with one there is exactly one thing.
 */
export function disrupt(raster: Raster, options: DisruptionOptions): Raster
export function disrupt(
  raster: Raster,
  options: DisruptionOptions,
  encodeJpeg: JpegEncoder,
): Promise<Raster>
export function disrupt(
  raster: Raster,
  options: DisruptionOptions,
  encodeJpeg?: JpegEncoder,
): Raster | Promise<Raster> {
  const reshaped = reshape(raster, options)
  if (!encodeJpeg) return scour(reshaped, options)
  if (!options.jpegQuality) return Promise.resolve(scour(reshaped, options))
  return encodeJpeg(reshaped, options.jpegQuality).then((next) => scour(next, options))
}
