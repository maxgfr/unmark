// Selecting a region on the image with a finger.
//
// This path had never been run once. The canvas had no `touch-action`, so the
// browser claimed the first vertical drag for page scroll and fired
// `pointercancel`; nothing cleared the drag origin, so the *next* pointer move
// — a hover, a tap anywhere — resumed drawing a selection anchored to a stale
// point. On a phone the feature simply did not work, and no test would have
// noticed because every test used a mouse.

// oxlint-disable no-await-in-loop -- a drag is a sequence of pointer moves;
// dispatching them in parallel would not be a drag.

import { expect, test } from '@playwright/test'

test.describe('touch selection', () => {
  test.skip(({ hasTouch }) => !hasTouch, 'only meaningful on a touch device')

  test.beforeEach(async ({ page }) => {
    await page.goto('./#image')
  })

  /** A textured picture with a flat badge in the bottom-right corner. */
  const makeImage = async (page: import('@playwright/test').Page) => {
    const bytes = await page.evaluate(async () => {
      const size = 240
      const canvas = new OffscreenCanvas(size, size)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')

      const image = context.createImageData(size, size)
      let seed = 7
      const random = () => {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        return Math.abs(seed % 64)
      }
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const index = (y * size + x) * 4
          const base = 40 + (x / size) * 120 + random()
          image.data[index] = base
          image.data[index + 1] = base * 0.8
          image.data[index + 2] = 200 - base * 0.5
          image.data[index + 3] = 255
        }
      }
      context.putImageData(image, 0, 0)

      context.globalAlpha = 0.45
      context.fillStyle = '#ffffff'
      context.fillRect(size - 70, size - 70, 56, 56)
      context.globalAlpha = 1

      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return [...new Uint8Array(await blob.arrayBuffer())]
    })
    return Buffer.from(bytes)
  }

  test('the canvas opts out of the browser gesture that would steal the drag', async ({ page }) => {
    // The deterministic half, and the one that actually fails on the code this
    // was written against. Without `touch-action: none` the browser claims the
    // first vertical drag for page scroll and fires `pointercancel` at us, and
    // no amount of correct handler logic survives that. Synthesised pointer
    // events cannot detect it — they bypass touch-action entirely — so the
    // property is asserted directly rather than inferred from a gesture.
    await page.setInputFiles('input[type=file]', {
      name: 'badge.png',
      mimeType: 'image/png',
      buffer: await makeImage(page),
    })

    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()
    expect(await canvas.evaluate((node) => getComputedStyle(node).touchAction)).toBe('none')
  })

  test('a finger drag selects a region, and the page does not scroll under it', async ({
    page,
  }) => {
    await page.setInputFiles('input[type=file]', {
      name: 'badge.png',
      mimeType: 'image/png',
      buffer: await makeImage(page),
    })

    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    const before = await page.evaluate(() => window.scrollY)

    // A real touch drag, not a mouse. Diagonally across the badge corner.
    const from = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 }
    const to = { x: box.x + box.width * 0.95, y: box.y + box.height * 0.95 }
    await page.touchscreen.tap(from.x, from.y)
    await page.mouse.move(from.x, from.y)
    await page.dispatchEvent('canvas', 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: from.x,
      clientY: from.y,
      button: 0,
      buttons: 1,
    })
    for (let step = 1; step <= 6; step += 1) {
      await page.dispatchEvent('canvas', 'pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        clientX: from.x + ((to.x - from.x) * step) / 6,
        clientY: from.y + ((to.y - from.y) * step) / 6,
        button: -1,
        buttons: 1,
      })
    }
    await page.dispatchEvent('canvas', 'pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: to.x,
      clientY: to.y,
      button: 0,
      buttons: 0,
    })

    // The selection panel only appears once a region wider than a few pixels
    // exists, so its presence is the assertion.
    await expect(page.getByRole('heading', { name: /selection/i })).toBeVisible()
    expect(await page.evaluate(() => window.scrollY)).toBe(before)
  })

  test('a cancelled gesture does not leave a selection drawing itself', async ({ page }) => {
    // The stale-origin bug: after `pointercancel` the drag reference stayed
    // populated, so the next pointer *move* — with no finger down at all —
    // carried on drawing from wherever the cancelled gesture had started.
    await page.setInputFiles('input[type=file]', {
      name: 'badge.png',
      mimeType: 'image/png',
      buffer: await makeImage(page),
    })

    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()
    const box = await canvas.boundingBox()
    if (!box) return

    await page.dispatchEvent('canvas', 'pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box.x + 10,
      clientY: box.y + 10,
      button: 0,
      buttons: 1,
    })
    await page.dispatchEvent('canvas', 'pointercancel', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box.x + 10,
      clientY: box.y + 10,
      button: 0,
      buttons: 0,
    })
    await page.dispatchEvent('canvas', 'pointermove', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box.x + box.width - 10,
      clientY: box.y + box.height - 10,
      button: -1,
      buttons: 0,
    })

    await expect(page.getByRole('heading', { name: /selection/i })).toHaveCount(0)
  })
})
