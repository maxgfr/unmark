// What the browser actually writes when you press Download.
//
// This is the only place the encoder is exercised at all. `src/image/canvas.ts`
// has no unit test and cannot have one — `createImageBitmap` and
// `convertToBlob` are the two things in the image pipeline that genuinely need
// a browser, which is why they are confined to that file. Everything downstream
// of them was tested; the file the visitor ends up with was not.
//
// The bug this was written against: `download()` called `rasterToBlob(raster)`
// with no arguments, took the PNG default, and named the result `.png`
// regardless. A three-megabyte photograph came back out at twenty, and the
// metadata-stripped original the tab had already computed was thrown away.

import { expect, test } from '@playwright/test'

/**
 * A photograph-ish JPEG: a smooth gradient with a little grain.
 *
 * Smooth on purpose. Pure noise is incompressible in both formats and the two
 * sizes come out close, which would make the assertions below pass or fail for
 * reasons that have nothing to do with the code under test.
 */
async function makePhoto(page: import('@playwright/test').Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const width = 1200
    const height = 900
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no 2d context')

    const image = context.createImageData(width, height)
    let seed = 11
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return Math.abs(seed % 24)
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4
        image.data[index] = 30 + (x / width) * 180 + random()
        image.data[index + 1] = 70 + (y / height) * 140 + random()
        image.data[index + 2] = 200 - (x / width) * 120 + random()
        image.data[index + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  return Buffer.from(bytes)
}

/**
 * Choose one of the segmented options, the way a pointer does.
 *
 * The radio itself is `sr-only` — one pixel, clipped, behind its own label —
 * because the visible control is the label. That is correct for a user and for
 * a screen reader, and it means a test has to click what a user clicks.
 */
const pick = (panel: import('@playwright/test').Locator, label: string) =>
  panel
    .locator('label')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .click()

/** The megabyte/kilobyte reading the panel prints, back as a number of bytes. */
const parseSize = (reading: string): number => {
  const match = /([\d.]+)\s*(B|kB|MB)/.exec(reading)
  if (!match) throw new Error(`no size in ${JSON.stringify(reading)}`)
  const scale = match[2] === 'MB' ? 1024 * 1024 : match[2] === 'kB' ? 1024 : 1
  return Number(match[1]) * scale
}

/** A picture with a flat white scrim across the bottom third — a caption bar. */
async function makeBanded(page: import('@playwright/test').Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const size = 384
    const canvas = new OffscreenCanvas(size, size)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no 2d context')

    const image = context.createImageData(size, size)
    let seed = 7
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return Math.abs(seed % 60)
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4
        image.data[index] = 40 + (x / size) * 120 + random()
        image.data[index + 1] = 90 + (y / size) * 90 + random()
        image.data[index + 2] = 150 - (x / size) * 80 + random()
        image.data[index + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)

    // Full width, so no corner probe can describe it. This is the shape the
    // corner scan structurally cannot report and the wide scan exists for.
    context.globalAlpha = 0.4
    context.fillStyle = '#ffffff'
    context.fillRect(0, 288, size, 64)
    context.globalAlpha = 1

    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  return Buffer.from(bytes)
}

test.describe('the overlay scan', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./#image')
  })

  const loadBanded = async (page: import('@playwright/test').Page) => {
    await page.setInputFiles('input[type=file]', {
      name: 'banded.png',
      mimeType: 'image/png',
      buffer: await makeBanded(page),
    })
    await expect(page.locator('canvas')).toBeVisible()
  }

  const overlayPanel = (page: import('@playwright/test').Page) =>
    page.locator('section', { has: page.getByRole('heading', { name: 'Overlay scan' }) })

  /**
   * Run the wide scan and wait for it to have actually landed.
   *
   * Not `toContainText('whole image')`: the button that starts the scan is
   * labelled "Scan the whole image", so that assertion is satisfied before the
   * click has done anything and a test can go on to count rows that are not
   * there yet. The button itself is only rendered while the panel is still in
   * corner mode, so its disappearance is the honest signal.
   */
  const wideScan = async (page: import('@playwright/test').Page) => {
    const panel = overlayPanel(page)
    const button = panel.getByRole('button', { name: 'Scan the whole image' })
    await button.click()
    await expect(button).toHaveCount(0, { timeout: 60_000 })
    return panel
  }

  test('says what it looked at, and says an empty result is not a clean bill', async ({ page }) => {
    await loadBanded(page)
    const panel = overlayPanel(page)

    // The aside used to read "nothing flat in the corners", which a reader takes
    // as "no watermark here".
    await expect(panel).toContainText('4 corners')
    await expect(panel.getByRole('button', { name: 'Scan the whole image' })).toBeVisible()
  })

  test('finds a full-width band once the whole image is scanned', async ({ page }) => {
    await loadBanded(page)
    const panel = await wideScan(page)

    // Named by where it is, not only by its coordinates — the change that makes
    // the list mean something next to the picture.
    await expect(panel.getByText(/band/).first()).toBeVisible()
    // And the caveat is on screen, not in a footnote.
    await expect(panel).toContainText('report, not a verdict')
  })

  test('draws every proposed region on the picture', async ({ page }) => {
    await loadBanded(page)
    const panel = await wideScan(page)

    // One outline per row. Without these the list is coordinates with nothing
    // to point at.
    const rows = await panel.locator('input[type=checkbox]').count()
    expect(rows).toBeGreaterThan(0)
    expect(await page.locator('canvas ~ div[aria-hidden]').count()).toBe(rows)
  })

  test('proposes nothing already ticked', async ({ page }) => {
    await loadBanded(page)
    const panel = await wideScan(page)

    // The wide pass used to arrive with every flat candidate ticked, and
    // scan.test.ts records that a patch of smooth sky reads as one at least as
    // confidently as a real mark. So the panel's own "a report, not a verdict"
    // sat beside a loaded button. Removal is a decision now, taken by hand.
    const boxes = panel.locator('input[type=checkbox]')
    expect(await boxes.count()).toBeGreaterThan(0)
    for (const box of await boxes.all()) await expect(box).not.toBeChecked()
    await expect(panel.getByRole('button', { name: /^Unblend/ })).toHaveCount(0)
  })

  test('removes every ticked region in one action and one undo', async ({ page }) => {
    await loadBanded(page)
    const panel = await wideScan(page)

    const undo = page.getByRole('button', { name: 'Undo' })
    await expect(undo).toBeDisabled()

    await panel.getByRole('button', { name: 'Tick all' }).click()
    await panel.getByRole('button', { name: /^Unblend/ }).click()
    // One undo step for the whole batch, not one per region.
    await expect(undo).toBeEnabled({ timeout: 60_000 })
    await undo.click()
    await expect(undo).toBeDisabled()
  })

  test('withdraws the list once the pixels have changed, and offers to measure again', async ({
    page,
  }) => {
    // The defect this whole panel was rebuilt around. The region list was free
    // state, written when a file was opened and when the wide scan ran, and by
    // nothing else — so after an unblend the boxes stayed drawn over pixels
    // that had already been recovered, the rows went on quoting the opacity of
    // an image that no longer existed, and the tick survived. One more click
    // inverted the same pixels a second time, which remove.ts puts at a hundred
    // levels of damage: worse than the mark was.
    await loadBanded(page)
    const panel = await wideScan(page)

    await panel.getByRole('button', { name: 'Tick all' }).click()
    await panel.getByRole('button', { name: /^Unblend/ }).click()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled({ timeout: 60_000 })

    // No rows, no outlines, and nothing left to press twice.
    await expect(panel).toContainText('measured before the last edit')
    await expect(panel.locator('input[type=checkbox]')).toHaveCount(0)
    await expect(page.locator('canvas ~ div[aria-hidden]')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /^Unblend/ })).toHaveCount(0)

    // And a way back: measure these pixels, rather than trust the old numbers.
    await panel.getByRole('button', { name: 'Scan again' }).click()
    await expect(panel).not.toContainText('measured before the last edit', { timeout: 60_000 })
  })

  test('undo makes the scan current again rather than merely plausible', async ({ page }) => {
    await loadBanded(page)
    const panel = await wideScan(page)

    const rows = await panel.locator('input[type=checkbox]').count()
    await panel.getByRole('button', { name: 'Tick all' }).click()
    await panel.getByRole('button', { name: /^Unblend/ }).click()

    const undo = page.getByRole('button', { name: 'Undo' })
    await expect(undo).toBeEnabled({ timeout: 60_000 })
    await undo.click()

    // Freshness is object identity, so undoing the edit restores the exact
    // pixels the scan was read from — the list is valid again with no rescan.
    await expect(panel).not.toContainText('measured before the last edit')
    await expect(panel.locator('input[type=checkbox]')).toHaveCount(rows)
  })
})

test.describe('the image download', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./#image')
  })

  const load = async (page: import('@playwright/test').Page) => {
    await page.setInputFiles('input[type=file]', {
      name: 'holiday.jpg',
      mimeType: 'image/jpeg',
      buffer: await makePhoto(page),
    })
    await expect(page.locator('canvas')).toBeVisible()
  }

  test('offers the original file back, not a re-encode, while the pixels are untouched', async ({
    page,
  }) => {
    await load(page)

    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Download' }) })
    await expect(panel).toBeVisible()

    // The default. A JPEG that only needed its metadata removed should not be
    // re-encoded at all, and the name it is offered under keeps its own suffix.
    await expect(panel.getByRole('radio', { name: 'Original file' })).toBeChecked()
    await expect(panel.getByText('not re-encoded')).toBeVisible()
    await expect(panel.getByText('holiday-unmarked.jpg')).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: 'Download' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('holiday-unmarked.jpg')
  })

  test('states what a PNG would cost, and what JPEG saves against it', async ({ page }) => {
    await load(page)
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Download' }) })

    await pick(panel, 'Re-encode')
    await pick(panel, 'PNG')

    // The chosen format's size only. The "PNG would be …" comparison beside it
    // is a separate element on purpose: it is populated from a cached
    // measurement and appears before the new format has finished encoding, so
    // reading the whole line would sample the old number and call it the new
    // one — which is exactly how the first version of this test passed while
    // comparing PNG against itself.
    const reading = panel.locator('output')
    const settled = /^[\d.]+ (B|kB|MB)$/

    await expect(reading).toHaveText(settled, { timeout: 30_000 })
    const asPng = parseSize(await reading.innerText())

    await pick(panel, 'JPEG')
    await expect(reading).not.toHaveText(String(asPng), { timeout: 30_000 })
    await expect(reading).toHaveText(settled, { timeout: 30_000 })
    const asJpeg = parseSize(await reading.innerText())
    await expect(panel.getByText('PNG would be')).toBeVisible()

    // The whole complaint, as a number: the lossless default is several times
    // the size of the format the picture arrived in.
    expect(asPng).toBeGreaterThan(asJpeg * 3)
  })

  test('writes the format it says it is writing', async ({ page }) => {
    await load(page)
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Download' }) })

    await pick(panel, 'Re-encode')
    await pick(panel, 'JPEG')
    await expect(panel.getByText('holiday-unmarked.jpg')).toBeVisible()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: 'Download' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('holiday-unmarked.jpg')

    const path = await download.path()
    const head = await import('node:fs/promises').then((fs) => fs.readFile(path))
    // SOI, and the marker that follows it. A PNG handed over under a .jpg name
    // would start 89 50 4E 47.
    expect([...head.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })

  test('never offers a format this browser cannot encode', async ({ page }) => {
    await load(page)
    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Download' }) })
    await pick(panel, 'Re-encode')

    // convertToBlob answers an unsupported type with a PNG rather than a
    // refusal, so an enabled WebP button on an engine that cannot write one
    // means a PNG delivered under a .webp name — bigger than the JPEG the
    // visitor was avoiding, and mislabelled. Whichever way this engine goes,
    // the offer and the capability have to agree.
    const webp = panel.getByRole('radio', { name: 'WebP', exact: true })
    const offered = await webp.isEnabled()
    const capable = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(1, 1)
      // Chromium throws from convertToBlob unless a context has been created,
      // which is the same trap the code under test fell into. Measured on this
      // machine: Chromium writes all three formats, WebKit answers a request
      // for WebP with an image/png blob and no error at all.
      canvas.getContext('2d')
      const blob = await canvas.convertToBlob({ type: 'image/webp' })
      return blob.type === 'image/webp'
    })
    expect(offered).toBe(capable)

    // PNG is the floor: it is what everything else degrades to, so it is always
    // offered.
    await expect(panel.getByRole('radio', { name: 'PNG', exact: true })).toBeEnabled()
  })
})
