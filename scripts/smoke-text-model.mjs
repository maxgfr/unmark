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
  // The first pass downloads through the settings panel, not through Clean
  // text: it checks the panel's own download, its storage count and that the
  // cold rewrite which follows needs no further model requests.
  await page.goto(`${base}#text`)
  await page.getByText('Advanced options', { exact: true }).click()
  const status = page.getByLabel('Local model status')
  // The device row starts as "Checking WebGPU…"; the adapter query is async.
  await status.getByText('WebGPU with shader-f16 available').waitFor({ timeout: 30000 })
  const downloadStart = requests.length
  await page.getByRole('button', { name: /Download model|Load model/ }).click()
  await page.getByRole('button', { name: 'Release model memory', exact: true }).waitFor({
    timeout: 600000,
  })
  assert.match(await status.textContent(), /Loaded · ready to rewrite/)
  assert.match(await status.textContent(), /Downloaded · \d+ MB cached for offline use/)
  console.log(
    'download model asset requests:',
    requests.slice(downloadStart).filter(({ url }) => url.includes('/vendor/text/')).length,
  )
  for (const pass of ['cold', 'french', 'spanish', 'german', 'cached', 'offline']) {
    await page.goto(`${base}#text`)
    if (pass === 'offline') await context.setOffline(true)
    await page.reload()
    assert(
      await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter())),
      'A real WebGPU adapter is required',
    )
    const source = {
      cold: 'The team completed the report. They sent it to the client.',
      french:
        'Nous avons préparer le dossier et nous sommes prêt à partir. Le client attend notre réponse demain.',
      spanish:
        'El equipo ha terminado el informe. Necesitamos revisar los resultados antes de enviar el documento al cliente.',
      german:
        'Wir haben den Bericht fertiggestellt. Morgen besprechen wir die Ergebnisse mit dem gesamten Team.',
      cached: 'bonjour c cool',
      offline: 'bonjour c cool',
    }[pass]
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
        status.includes('returned your text unchanged'),
      status,
    )
    const output = (await page.locator('output').textContent()).trim()
    assert(output.length > 0)
    assert.equal(await page.getByLabel('Text to inspect').inputValue(), source)
    if (pass === 'cached' || pass === 'offline') {
      assert(
        /^bonjour[,.!]? c(?:'est)? cool[.!]?$/i.test(output),
        `Unexpected French rewrite: ${output}`,
      )
    }
    if (pass === 'french') {
      assert.match(output, /Nous avons préparé le dossier/)
      assert.match(output, /nous sommes prêts à partir/)
      assert.match(output, /Le client attend notre réponse demain/)
    }
    if (pass === 'spanish') assert.match(output, /El equipo|el informe/)
    if (pass === 'german') assert.match(output, /Wir haben|die Ergebnisse/)
    const modelRequests = requests.slice(start).filter(({ url }) => url.includes('/vendor/text/'))
    assert.deepEqual(modelRequests, [], `${pass}: the panel download should have cached every file`)
    console.log(pass, 'model asset requests:', modelRequests.length)
  }
  assert.deepEqual(errors, [])
  assert(
    requests.every(({ url, method }) => url.startsWith(new URL(base).origin) && method === 'GET'),
    'Unexpected outbound or non-GET request',
  )
  console.log(
    'Panel download, real WebGPU rewrites, cached and offline reloads, and same-origin checks passed.',
  )
} finally {
  await browser.close()
  await server.close()
}
