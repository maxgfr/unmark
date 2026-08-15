// The APIs this app is built on, exercised in each engine rather than assumed.
//
// The previous round shipped with the note "OffscreenCanvas.convertToBlob and
// DecompressionStream('deflate-raw') are probably good everywhere, but
// 'probably' is not 'tested'". MDN says Safari 16.4 and Firefox 105/113, which
// answers the support question and not the useful one: whether *our* code paths
// run. These do that, and they run in Chromium, Firefox and WebKit.

import { expect, test } from '@playwright/test'

test.describe('platform support', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./')
    await expect(page.getByRole('heading', { name: 'unmark', exact: true })).toBeVisible()
  })

  test('the page loads with no console error and no failed request', async ({ page }) => {
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    page.on('requestfailed', (request) =>
      problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
    )

    await page.reload()
    await expect(page.getByRole('heading', { name: 'unmark', exact: true })).toBeVisible()
    await page.waitForTimeout(500)
    expect(problems).toEqual([])
  })

  test('DecompressionStream deflate-raw round-trips, which is how every zip is read', async ({
    page,
  }) => {
    const roundTripped = await page.evaluate(async () => {
      const source = new TextEncoder().encode('docProps/core.xml'.repeat(20))
      const deflated = new Response(
        new Blob([source]).stream().pipeThrough(new CompressionStream('deflate-raw')),
      )
      const inflated = new Response(
        (await deflated.blob()).stream().pipeThrough(new DecompressionStream('deflate-raw')),
      )
      return new TextDecoder().decode(await inflated.arrayBuffer())
    })
    expect(roundTripped).toBe('docProps/core.xml'.repeat(20))
  })

  test('OffscreenCanvas.convertToBlob produces a real PNG', async ({ page }) => {
    // The image tab's only way of handing a cleaned picture back.
    const header = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(8, 8)
      const context = canvas.getContext('2d')
      if (!context) return 'no 2d context'
      context.fillStyle = '#ffb020'
      context.fillRect(0, 0, 8, 8)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return bytes.slice(0, 4).join(',')
    })
    expect(header).toBe('137,80,78,71')
  })

  test('createImageBitmap decodes a blob', async ({ page }) => {
    const size = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(4, 6)
      const context = canvas.getContext('2d')
      context?.fillRect(0, 0, 4, 6)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const bitmap = await createImageBitmap(blob)
      const dimensions = `${bitmap.width}x${bitmap.height}`
      bitmap.close()
      return dimensions
    })
    expect(size).toBe('4x6')
  })

  test('module workers start, which is where the heavy image work runs', async ({ page }) => {
    const answer = await page.evaluate(async () => {
      const source = 'self.onmessage = (e) => self.postMessage(e.data * 2)'
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      try {
        const worker = new Worker(url, { type: 'module' })
        const result = await new Promise<number>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data as number)
          worker.onerror = () => reject(new Error('worker failed'))
          worker.postMessage(21)
        })
        worker.terminate()
        return result
      } finally {
        URL.revokeObjectURL(url)
      }
    })
    expect(answer).toBe(42)
  })
})

test.describe('layout', () => {
  for (const tab of ['text', 'files', 'image'] as const) {
    test(`the ${tab} tab never scrolls sideways`, async ({ page }) => {
      // Only the Text tab had ever been looked at below 1024px, and only in a
      // screenshot. Horizontal overflow on a phone is the failure that makes a
      // page feel broken before anything else is even tried.
      await page.goto(`./#${tab}`)
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }
})
