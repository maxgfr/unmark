// oxlint-disable no-await-in-loop -- cold and cached passes must run sequentially
// Optional hardware check: run after pnpm assets && pnpm build.
// Keeps GPU/model work out of ordinary CI and records real cache behaviour.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { serveDist } from '../tests/e2e/server.mjs'
const server = await serveDist(4186)
const browser = await chromium.launch({
  headless: process.env['UNMARK_HEADED'] !== '1',
  args: ['--enable-unsafe-webgpu'],
})
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const base = server.url.replace('localhost', '127.0.0.1')
  const requests = []
  const errors = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))
  page.on('pageerror', (error) => errors.push(error.message))
  for (const pass of ['cold', 'cached', 'offline']) {
    await page.goto(`${base}#text`)
    if (pass === 'offline') await context.setOffline(true)
    if (pass !== 'cold') await page.reload()
    assert(
      await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter())),
      'A real WebGPU adapter is required',
    )
    await page
      .getByLabel('Text to inspect')
      .fill('The team completed the report. They sent it to the client.')
    await page.getByText('Deep clean', { exact: true }).click()
    const start = requests.length
    await page.getByRole('button', { name: 'Clean text', exact: true }).click()
    let last = ''
    const timer = setInterval(async () => {
      const text = await page
        .locator('[aria-live]')
        .textContent()
        .catch(() => '')
      if (text !== last) {
        console.log(pass, text)
        last = text
      }
    }, 5000)
    try {
      await page
        .getByRole('button', { name: 'Clean text', exact: true })
        .waitFor({ timeout: 240000 })
    } finally {
      clearInterval(timer)
    }
    const status = await page.locator('[aria-live]').textContent()
    console.log(pass, status)
    assert(status.includes('Rewritten locally.'), status)
    assert((await page.locator('output').textContent()).trim().length > 0)
    const modelRequests = requests.slice(start).filter(({ url }) => url.includes('/vendor/text/'))
    if (pass !== 'cold') assert.deepEqual(modelRequests, [])
    console.log(pass, 'model asset requests:', modelRequests.length)
  }
  assert.deepEqual(errors, [])
  assert(
    requests.every(({ url, method }) => url.startsWith(new URL(base).origin) && method === 'GET'),
    'Unexpected outbound or non-GET request',
  )
  console.log('Real WebGPU rewrite, cached and offline reloads, and same-origin checks passed.')
} finally {
  await browser.close()
  await server.close()
}
