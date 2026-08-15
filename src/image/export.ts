// What the download panel has to decide before a canvas is involved.
//
// The Image tab used to have no decisions here at all: it called
// `rasterToBlob(raster)`, took the PNG default, and named the file
// `<stem>-unmarked.png` whatever had gone in. A three-megabyte photograph came
// back out at twenty, because a lossless re-encode of a picture that was
// already lossy is the largest file the browser knows how to make.
//
// Everything in this file is arithmetic on names, numbers and bytes, so it is
// testable under Node. The one part that genuinely needs the platform — asking
// the browser which formats it can actually encode — lives in canvas.ts.

import type { ContainerFormat } from '../core/container/index.ts'
import type { Raster } from './raster.ts'

export type ExportFormat = 'png' | 'jpeg' | 'webp'

/** The three the UI offers, in the order it offers them. */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp']

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** How each one is spelled on screen. WebP is not an acronym; WEBP is not a word. */
export const FORMAT_LABEL: Record<ExportFormat, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
}

const EXTENSION: Record<ExportFormat, string> = {
  png: '.png',
  // .jpg rather than .jpeg. Both are correct and one of them is what every
  // other program on the machine writes.
  jpeg: '.jpg',
  webp: '.webp',
}

export const mimeOf = (format: ExportFormat): string => MIME[format]

/**
 * Where the quality slider starts.
 *
 * 0.85 is the point either side of which the trade changes character: above it
 * the file grows fast for detail nobody can see, below it the 8x8 blocks start
 * showing on flat gradients. It is also what `requantizeJpeg` already defaults
 * to, and two different "default qualities" in one codebase is one too many.
 */
export const DEFAULT_QUALITY = 0.85

/**
 * The format to offer first, from what the file actually was.
 *
 * Sniffed rather than taken from the extension — `cleanContainer` returns the
 * format it found in the magic bytes, and a JPEG called `.png` is still a JPEG.
 *
 * The rule is "do not change the kind of file someone brought you": a photo
 * arrives lossy and leaves lossy, and anything that might carry transparency
 * or flat colour leaves as PNG. HEIC and AVIF have no encoder in any browser,
 * so they fall to JPEG, which is what they were standing in for.
 */
export function defaultFormat(container: ContainerFormat): ExportFormat {
  if (container === 'JPEG' || container === 'HEIC' || container === 'AVIF') return 'jpeg'
  if (container === 'WebP') return 'webp'
  return 'png'
}

/**
 * Name the download after the original, with the extension it will really have.
 *
 * The suffix is replaced rather than appended: `photo.jpg` re-encoded as PNG is
 * `photo-unmarked.png`, not `photo-unmarked.jpg.png`. A leading dot is not an
 * extension — `.profile` keeps its name and gains a suffix.
 */
export function exportName(original: string, format: ExportFormat): string {
  const dot = original.lastIndexOf('.')
  const stem = dot <= 0 ? original : original.slice(0, dot)
  return `${stem}-unmarked${EXTENSION[format]}`
}

/**
 * Whether any pixel is less than fully opaque.
 *
 * JPEG has no alpha channel, and a canvas encoding one composites the
 * transparent parts onto black rather than refusing. That is a surprise worth
 * naming before the download rather than after it, so the panel asks this and
 * says so.
 */
export function hasTransparency(raster: Raster): boolean {
  const { data } = raster
  for (let index = 3; index < data.length; index += 4) {
    if ((data[index] ?? 255) < 255) return true
  }
  return false
}

/** The key a measured blob is cached under. Format and quality, nothing else. */
export const measureKey = (format: ExportFormat, quality: number): string =>
  format === 'png' ? 'png' : `${format}@${Math.round(quality * 100)}`
