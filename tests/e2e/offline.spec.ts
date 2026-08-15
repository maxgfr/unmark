// The PWA, which until now was a config block with nothing behind it.
//
// `vite-plugin-pwa` was set to `injectRegister: null`, meaning the plugin
// deliberately emits no registration code and the app is expected to do it.
// Nothing did. So `sw.js` and the manifest were built on every deploy, the
// browser installed neither, and "offline" was a claim nobody had made out loud
// and nobody could have kept.
//
// The icon test is separate and just as concrete: `index.html` and the manifest
// between them referenced six files that did not exist in `public/`.

// oxlint-disable no-await-in-loop -- a reload has to finish before the next
// one starts, and the whole point of the loop is that it is sequential.

import { expect, test } from '@playwright/test'

test('every icon the page references actually exists', async ({ page, request }) => {
  await page.goto('./')

  const referenced = [
    'favicon.svg',
    'apple-touch-icon-180x180.png',
    'pwa-64x64.png',
    'pwa-192x192.png',
    'pwa-512x512.png',
    'maskable-icon-512x512.png',
  ]

  for (const name of referenced) {
    const response = await request.get(`./${name}`)
    expect(response.status(), `${name} should be served, not 404`).toBe(200)
    expect(Number(response.headers()['content-length'] ?? '1')).toBeGreaterThan(0)
  }
})

test('the web manifest is served and names the icons it ships', async ({ request }) => {
  const response = await request.get('./manifest.webmanifest')
  expect(response.status()).toBe(200)

  const manifest = (await response.json()) as {
    icons: { src: string }[]
    start_url: string
    scope: string
  }
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4)
  expect(manifest.scope).toBe('/unmark/')
})

/**
 * Reload, online, until the worker is actually controlling the page.
 *
 * A loop rather than one reload, because the engines genuinely differ: Firefox
 * is controlled after the first, Chromium and WebKit after the second. Neither
 * is wrong — `clientsClaim` is deliberately false, so a newly installed worker
 * never seizes a page that is already open, and somebody with a 28 MB model in
 * memory and a mask half drawn does not get their tab taken over. The
 * consequence is that offline starts working on a later visit rather than the
 * first, and this loop is that visit.
 */
async function takeControl(page: import('@playwright/test').Page): Promise<boolean> {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'unmark', exact: true })).toBeVisible()

  await page.waitForFunction(
    async () => Boolean((await navigator.serviceWorker.getRegistration())?.active),
    undefined,
    { timeout: 30_000 },
  )

  for (let visit = 0; visit < 4; visit += 1) {
    await page.reload()
    const controlled = await page
      .waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, {
        timeout: 5000,
      })
      .then(() => true)
      .catch(() => false)
    if (controlled) return true
  }
  return false
}

test('the service worker installs and takes control, in every engine', async ({ page }) => {
  // Asserted everywhere, including WebKit. The offline reload below cannot run
  // there, and letting that skip the registration check too would leave the
  // engine with no coverage of the thing that was actually broken: the worker
  // was built and shipped on every deploy and never installed once.
  expect(await takeControl(page), 'the service worker never took control').toBe(true)
})

test.describe('offline', () => {
  // The reload itself, not the worker. Playwright's WebKit raises "WebKit
  // encountered an internal error" on any reload while `setOffline` is on —
  // a harness limitation, not ours, and the test above proves the worker is
  // installed and controlling in WebKit all the same.
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    "Playwright's WebKit errors internally on reload while offline",
  )

  test('still boots and still cleans text with the network cut', async ({ page, context }) => {
    expect(await takeControl(page)).toBe(true)

    await context.setOffline(true)
    await page.reload()

    await expect(page.getByRole('heading', { name: 'unmark', exact: true })).toBeVisible()

    // Booting is not the claim. Working is.
    await page.getByLabel('Text to inspect').fill('Attached\u200B\u200B\u200Bresults.')
    const cleaned = await page.evaluate(() => document.querySelector('output')?.textContent ?? '')
    expect(cleaned).toContain('Attached')
    expect(cleaned).not.toContain('\u200B')

    await context.setOffline(false)
  })
})
