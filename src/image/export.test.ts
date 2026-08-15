import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUALITY,
  defaultFormat,
  exportName,
  hasTransparency,
  measureKey,
  mimeOf,
} from './export.ts'
import { createRaster } from './raster.ts'

describe('defaultFormat', () => {
  it('keeps a lossy photograph lossy', () => {
    expect(defaultFormat('JPEG')).toBe('jpeg')
  })

  it('sends the two formats no browser can encode to JPEG', () => {
    // HEIC and AVIF have no canvas encoder anywhere. They arrived as
    // photographs, so they leave as the photographic format that does exist.
    expect(defaultFormat('HEIC')).toBe('jpeg')
    expect(defaultFormat('AVIF')).toBe('jpeg')
  })

  it('keeps WebP as WebP', () => {
    expect(defaultFormat('WebP')).toBe('webp')
  })

  it('sends everything that might carry transparency or flat colour to PNG', () => {
    expect(defaultFormat('PNG')).toBe('png')
    expect(defaultFormat('GIF')).toBe('png')
    expect(defaultFormat('unknown')).toBe('png')
  })
})

describe('exportName', () => {
  it('replaces the extension rather than appending one', () => {
    // The bug this exists to prevent: photo.jpg-unmarked.png.
    expect(exportName('photo.jpg', 'png')).toBe('photo-unmarked.png')
  })

  it('writes .jpg, not .jpeg', () => {
    expect(exportName('photo.png', 'jpeg')).toBe('photo-unmarked.jpg')
  })

  it('only replaces the last suffix of a dotted name', () => {
    expect(exportName('holiday.2024.raw.jpeg', 'webp')).toBe('holiday.2024.raw-unmarked.webp')
  })

  it('adds an extension to a name that has none', () => {
    expect(exportName('screenshot', 'png')).toBe('screenshot-unmarked.png')
  })

  it('does not read a leading dot as an extension', () => {
    // .profile is a name, not a suffix. Slicing at index 0 would leave an
    // empty stem and produce "-unmarked.png".
    expect(exportName('.profile', 'png')).toBe('.profile-unmarked.png')
  })
})

describe('hasTransparency', () => {
  it('is false for a fully opaque raster', () => {
    const raster = createRaster(4, 4)
    for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255
    expect(hasTransparency(raster)).toBe(false)
  })

  it('is true when a single pixel is not fully opaque', () => {
    const raster = createRaster(4, 4)
    for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255
    raster.data[4 * 4 * 4 - 1] = 254
    expect(hasTransparency(raster)).toBe(true)
  })

  it('reads the alpha channel, not the colour channels', () => {
    // Every colour byte is 0 and every alpha byte is 255: black, not clear.
    const raster = createRaster(4, 4)
    for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = 255
    expect(hasTransparency(raster)).toBe(false)
  })
})

describe('measureKey', () => {
  it('ignores quality for PNG, which has none', () => {
    expect(measureKey('png', 0.4)).toBe(measureKey('png', 0.9))
  })

  it('separates two qualities of the same lossy format', () => {
    expect(measureKey('jpeg', 0.8)).not.toBe(measureKey('jpeg', 0.85))
  })

  it('separates two formats at the same quality', () => {
    expect(measureKey('jpeg', 0.85)).not.toBe(measureKey('webp', 0.85))
  })
})

describe('mimeOf', () => {
  it('names the type convertToBlob expects', () => {
    expect(mimeOf('jpeg')).toBe('image/jpeg')
    expect(DEFAULT_QUALITY).toBeGreaterThan(0)
    expect(DEFAULT_QUALITY).toBeLessThan(1)
  })
})
