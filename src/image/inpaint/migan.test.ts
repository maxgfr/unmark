import { describe, expect, it } from 'vitest'
import {
  compositeWindow,
  inpaintWithMigan,
  packWindow,
  windowFor,
  type MiganRunner,
} from './migan.ts'
import { at, createRaster, type Raster } from '../raster.ts'

// This file had no tests at all, and the three things it does that are easy to
// get silently wrong are all pure: the window arithmetic, the CHW packing with
// its inverted mask, and the masked-only composite. None of them need the
// model, so none of them are tested against it — a stub runner stands in, and
// the real 28 MB graph is never loaded here.

function picture(width: number, height: number): Raster {
  const raster = createRaster(width, height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(raster, x, y)
      raster.data[index] = (x * 3) % 256
      raster.data[index + 1] = (y * 5) % 256
      raster.data[index + 2] = (x + y) % 256
      raster.data[index + 3] = 255
    }
  }
  return raster
}

function maskRect(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) mask[y * width + x] = 1
  }
  return mask
}

describe('windowFor', () => {
  it('finds nothing when nothing is masked', () => {
    expect(windowFor(picture(64, 64), new Uint8Array(64 * 64))).toBeUndefined()
  })

  it('centres a window on the hole and keeps it a multiple of eight', () => {
    // Not only 512: the graph accepts any multiple of 8, and running a 4000px
    // photograph through it would spend the model's capacity on pixels nowhere
    // near the hole.
    const hole = { x: 400, y: 300, width: 40, height: 40 }
    const region = windowFor(picture(1024, 1024), maskRect(1024, 1024, hole))
    expect(region).toBeDefined()
    if (!region) return

    expect(region.width % 8).toBe(0)
    expect(region.height % 8).toBe(0)
    expect(region.width).toBe(region.height)

    // The hole has to be inside the window, or the model is filling the wrong
    // part of the picture.
    expect(region.x).toBeLessThanOrEqual(hole.x)
    expect(region.y).toBeLessThanOrEqual(hole.y)
    expect(region.x + region.width).toBeGreaterThanOrEqual(hole.x + hole.width)
    expect(region.y + region.height).toBeGreaterThanOrEqual(hole.y + hole.height)

    // Centred: the hole's middle should sit near the window's middle.
    expect(Math.abs(region.x + region.width / 2 - (hole.x + hole.width / 2))).toBeLessThan(8)
  })

  it('never opens a window smaller than 256 for a tiny hole', () => {
    // A 4-pixel hole still needs surroundings to be filled from.
    const region = windowFor(
      picture(1024, 1024),
      maskRect(1024, 1024, { x: 500, y: 500, width: 4, height: 4 }),
    )
    expect(region?.width).toBeGreaterThanOrEqual(256)
  })

  it('never opens one larger than 1024, however big the hole', () => {
    const region = windowFor(
      picture(4096, 2048),
      maskRect(4096, 2048, { x: 100, y: 100, width: 1800, height: 900 }),
    )
    expect(region?.width).toBeLessThanOrEqual(1024)
  })

  it('slides a corner hole back inside the picture rather than off it', () => {
    // The clamp that decides whether the tensor is in bounds at all. A hole in
    // the very corner would otherwise centre a window half outside the image.
    const region = windowFor(
      picture(512, 512),
      maskRect(512, 512, { x: 500, y: 500, width: 10, height: 10 }),
    )
    expect(region).toBeDefined()
    if (!region) return

    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.width).toBeLessThanOrEqual(512)
    expect(region.y + region.height).toBeLessThanOrEqual(512)
  })

  it('does not exceed the short side of a picture smaller than the minimum window', () => {
    const region = windowFor(
      picture(120, 200),
      maskRect(120, 200, { x: 40, y: 40, width: 10, height: 10 }),
    )
    expect(region).toBeDefined()
    if (!region) return
    expect(region.width).toBeLessThanOrEqual(120)
    expect(region.x + region.width).toBeLessThanOrEqual(120)
  })
})

describe('packWindow', () => {
  it('lays the tile out as three planes, not as interleaved pixels', () => {
    const raster = picture(32, 32)
    const region = { x: 4, y: 8, width: 16, height: 16 }
    const { image } = packWindow(raster, new Uint8Array(32 * 32), region)

    const plane = region.width * region.height
    expect(image.length).toBe(3 * plane)

    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const source = at(raster, region.x + x, region.y + y)
        const target = y * region.width + x
        expect(image[target]).toBe(raster.data[source])
        expect(image[plane + target]).toBe(raster.data[source + 1])
        expect(image[2 * plane + target]).toBe(raster.data[source + 2])
      }
    }
  })

  it('inverts the mask, because 0 is a hole for this model and 1 is one for us', () => {
    // Getting this backwards makes the model reconstruct everything *except*
    // the watermark, and the result still looks like a picture.
    const raster = picture(32, 32)
    const region = { x: 0, y: 0, width: 16, height: 16 }
    const hole = { x: 4, y: 4, width: 6, height: 6 }
    const { mask } = packWindow(raster, maskRect(32, 32, hole), region)

    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        const inHole =
          x >= hole.x && x < hole.x + hole.width && y >= hole.y && y < hole.y + hole.height
        expect(mask[y * region.width + x]).toBe(inHole ? 0 : 255)
      }
    }
  })

  it('reads from the window, not from the top-left corner of the picture', () => {
    const raster = picture(64, 64)
    const { image } = packWindow(raster, new Uint8Array(64 * 64), {
      x: 16,
      y: 24,
      width: 8,
      height: 8,
    })
    expect(image[0]).toBe(raster.data[at(raster, 16, 24)])
  })
})

describe('compositeWindow', () => {
  it('takes only the masked pixels from the model', () => {
    // The whole tile coming back would replace real pixels with the model's
    // reconstruction of them over an area many times the watermark's size.
    const raster = picture(48, 48)
    const region = { x: 8, y: 8, width: 32, height: 32 }
    const hole = { x: 16, y: 16, width: 8, height: 8 }
    const mask = maskRect(48, 48, hole)

    const plane = region.width * region.height
    const result = new Uint8Array(3 * plane).fill(200)

    const out = compositeWindow(raster, mask, region, result)
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        const index = at(raster, x, y)
        const inHole =
          x >= hole.x && x < hole.x + hole.width && y >= hole.y && y < hole.y + hole.height
        expect(out.data[index]).toBe(inHole ? 200 : raster.data[index])
      }
    }
  })

  it('leaves the alpha channel alone', () => {
    const raster = picture(32, 32)
    raster.data[at(raster, 10, 10) + 3] = 64
    const region = { x: 0, y: 0, width: 32, height: 32 }
    const result = new Uint8Array(3 * 32 * 32).fill(7)

    const out = compositeWindow(raster, maskRect(32, 32, region), region, result)
    expect(out.data[at(out, 10, 10) + 3]).toBe(64)
  })
})

describe('inpaintWithMigan', () => {
  it('runs the whole path against a stub and fills only the hole', async () => {
    const raster = picture(300, 300)
    const hole = { x: 140, y: 140, width: 20, height: 20 }
    const mask = maskRect(300, 300, hole)

    let sawSize: [number, number] | undefined
    let sawHolePixels = 0
    const run: MiganRunner = async (image, modelMask, width, height) => {
      sawSize = [width, height]
      for (const value of modelMask) if (value === 0) sawHolePixels += 1
      // A model that returns the tile it was given, except mid-grey everywhere.
      expect(image.length).toBe(3 * width * height)
      return new Uint8Array(3 * width * height).fill(128)
    }

    const result = await inpaintWithMigan(raster, mask, { run })
    expect(result).toBeDefined()
    if (!result) return

    expect(sawSize).toEqual([result.window.width, result.window.height])
    expect(sawHolePixels).toBe(hole.width * hole.height)
    expect(result.milliseconds).toBeGreaterThanOrEqual(0)

    expect(result.raster.data[at(raster, 145, 145)]).toBe(128)
    expect(result.raster.data[at(raster, 10, 10)]).toBe(raster.data[at(raster, 10, 10)])
  })

  it('does not run the model at all when nothing is masked', async () => {
    let called = false
    const run: MiganRunner = async () => {
      called = true
      return new Uint8Array(0)
    }
    expect(
      await inpaintWithMigan(picture(64, 64), new Uint8Array(64 * 64), { run }),
    ).toBeUndefined()
    expect(called).toBe(false)
  })

  it('refuses a picture too small for the graph to accept', async () => {
    // The model needs a multiple of 8 in both directions; below that there is
    // no tensor to build.
    const run: MiganRunner = async () => new Uint8Array(0)
    const tiny = picture(4, 4)
    expect(
      await inpaintWithMigan(tiny, maskRect(4, 4, { x: 1, y: 1, width: 2, height: 2 }), { run }),
    ).toBeUndefined()
  })
})

describe('the window that ran off the edge', () => {
  it('never opens a window wider than the picture it came from', () => {
    // The bug these tests found. The short side was rounded *up* to a multiple
    // of eight, so a 300px picture asked for a 304px tile; the packing then
    // read four pixels past the end of every row and the model was fed a tile
    // with each row's tail wrapped in from the row beneath it. Nothing threw.
    for (const [width, height] of [
      [300, 300],
      [301, 507],
      [1023, 1023],
      [130, 130],
    ] as const) {
      const mask = maskRect(width, height, {
        x: 10,
        y: 10,
        width: width - 20,
        height: height - 20,
      })
      const region = windowFor(picture(width, height), mask)
      expect(region).toBeDefined()
      if (!region) continue

      expect(region.x + region.width).toBeLessThanOrEqual(width)
      expect(region.y + region.height).toBeLessThanOrEqual(height)
      expect(region.width % 8).toBe(0)
    }
  })
})
