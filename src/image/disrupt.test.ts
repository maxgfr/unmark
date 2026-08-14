import { describe, expect, it } from 'vitest'
import { addNoise, cropBorder, disrupt, resample, scrubLowBits } from './disrupt.ts'
import { at, createRaster, xorshift, type Raster } from './raster.ts'

function picture(width: number, height: number, seed = 5): Raster {
  const raster = createRaster(width, height)
  const random = xorshift(seed)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(raster, x, y)
      raster.data[index] = 30 + (x / width) * 180 + random() * 40
      raster.data[index + 1] = 60 + (y / height) * 150 + random() * 40
      raster.data[index + 2] = 200 - (y / height) * 120 + random() * 40
      raster.data[index + 3] = 255
    }
  }
  return raster
}

/** Hide one bit per channel, the way LSB steganography does. */
function embedLsb(raster: Raster, bits: readonly number[]): Raster {
  const out = { ...raster, data: new Uint8ClampedArray(raster.data) }
  for (const [i, bit] of bits.entries()) {
    out.data[i * 4] = ((out.data[i * 4] ?? 0) & 0xfe) | bit
  }
  return out
}

const readLsb = (raster: Raster, count: number) =>
  Array.from({ length: count }, (_, i) => (raster.data[i * 4] ?? 0) & 1)

describe('scrubLowBits', () => {
  it('destroys an LSB payload', () => {
    const payload = [1, 0, 1, 1, 0, 0, 1, 0]
    const carrier = embedLsb(picture(64, 64), payload)
    expect(readLsb(carrier, 8)).toEqual(payload)

    const scrubbed = scrubLowBits(carrier, 1)
    expect(readLsb(scrubbed, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('changes each channel by at most one level', () => {
    // Invisible by construction: one part in 256 is below what a display or an
    // eye resolves. A destructive scrub that was also visible would be useless.
    const before = picture(32, 32)
    const after = scrubLowBits(before, 1)
    for (let i = 0; i < before.data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        expect(Math.abs((before.data[i + c] ?? 0) - (after.data[i + c] ?? 0))).toBeLessThanOrEqual(
          1,
        )
      }
    }
  })

  it('leaves alpha alone', () => {
    // Flattening alpha would change which pixels are visible — a different
    // picture, not a cleaned one.
    const before = picture(16, 16)
    before.data[3] = 128
    expect(scrubLowBits(before, 3).data[3]).toBe(128)
  })
})

describe('resample', () => {
  it('produces the requested size', () => {
    const out = resample(picture(100, 60), 0.5)
    expect([out.width, out.height]).toEqual([50, 30])
  })

  it('returns an untouched copy at scale 1', () => {
    const before = picture(32, 32)
    expect([...resample(before, 1).data]).toEqual([...before.data])
  })

  it('keeps the picture recognisable', () => {
    // The point is to move every pixel off the grid a mark was embedded
    // against, not to destroy the image. A round trip should stay close.
    const before = picture(64, 64)
    const round = resample(resample(before, 0.5), 2)
    let worst = 0
    for (let i = 0; i < before.data.length; i += 4) {
      worst = Math.max(worst, Math.abs((before.data[i] ?? 0) - (round.data[i] ?? 0)))
    }
    expect(worst).toBeLessThan(90)
  })

  it('actually changes the pixel values', () => {
    const before = picture(64, 64)
    const round = resample(resample(before, 0.5), 2)
    const identical = [...before.data].filter((v, i) => v === round.data[i]).length
    expect(identical).toBeLessThan(before.data.length)
  })
})

describe('cropBorder', () => {
  it('trims every edge', () => {
    const out = cropBorder(picture(100, 80), 5)
    expect([out.width, out.height]).toEqual([90, 70])
  })

  it('moves the origin, which is the point', () => {
    const before = picture(50, 50)
    const after = cropBorder(before, 4)
    // The pixel now at (0,0) is the one that was at (4,4).
    expect(after.data[0]).toBe(before.data[at(before, 4, 4)])
  })

  it('refuses to crop a picture away', () => {
    const out = cropBorder(picture(20, 20), 500)
    expect(out.width).toBeGreaterThan(0)
    expect(out.height).toBeGreaterThan(0)
  })
})

describe('addNoise', () => {
  it('is reproducible for a given seed', () => {
    // Math.random would make the same operation produce a different file every
    // run: untestable, and unrepeatable for a user who liked the result.
    const before = picture(32, 32)
    expect([...addNoise(before, 3, 42).data]).toEqual([...addNoise(before, 3, 42).data])
  })

  it('differs between seeds', () => {
    const before = picture(32, 32)
    expect([...addNoise(before, 3, 1).data]).not.toEqual([...addNoise(before, 3, 2).data])
  })

  it('stays within the amplitude asked for', () => {
    const before = picture(32, 32)
    const after = addNoise(before, 2, 9)
    for (let i = 0; i < before.data.length; i += 4) {
      expect(Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0))).toBeLessThanOrEqual(2)
    }
  })
})

describe('disrupt', () => {
  it('does nothing when nothing is asked for', () => {
    const before = picture(32, 32)
    expect([...disrupt(before, {}).data]).toEqual([...before.data])
  })

  it('applies a combination and keeps the original dimensions', () => {
    const before = picture(64, 64)
    const after = disrupt(before, { lowBits: 1, resampleTo: 0.75, noiseAmplitude: 1 })
    expect(after.width).toBeLessThanOrEqual(before.width)
    expect(after.height).toBeLessThanOrEqual(before.height)
    expect([...after.data]).not.toEqual([...before.data])
  })

  it('destroys an LSB payload through the full pipeline', () => {
    const carrier = embedLsb(picture(64, 64), [1, 1, 1, 1, 1, 1, 1, 1])
    const after = disrupt(carrier, { resampleTo: 0.8, lowBits: 1 })
    expect(readLsb(after, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})
