// oxlint-disable no-await-in-loop -- cold and cached passes must run sequentially
// Optional hardware check: run after pnpm assets && pnpm build.
// Keeps GPU/model work out of ordinary CI and records real cache behaviour.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { serveDist } from '../tests/e2e/server.mjs'
const mode = process.env['UNMARK_MODE'] ?? 'deep'
assert(['deep', 'ultra'].includes(mode), 'UNMARK_MODE must be deep or ultra')
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
    const source =
      pass === 'cold'
        ? 'The team completed the report. They sent it to the client.'
        : 'bonjour c cool'
    await page.getByLabel('Text to inspect').fill(source)
    await page.getByText('Advanced options', { exact: true }).click()
    await page.getByLabel('Cleaning mode').selectOption(mode)
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
    assert(
      status.includes(mode === 'ultra' ? 'Ultra complete.' : 'Rewritten locally.') ||
        status.includes('The model kept the text unchanged.'),
      status,
    )
    const output = (await page.locator('output').textContent()).trim()
    assert(output.length > 0)
    assert.equal(await page.getByLabel('Text to inspect').inputValue(), source)
    if (pass !== 'cold') {
      assert(
        /^bonjour[,.!]? c(?:'est)? cool[.!]?$/i.test(output),
        `Unexpected French rewrite: ${output}`,
      )
    }
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
