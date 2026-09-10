import { expect, test } from '@playwright/test'
import {
  cacheScopeOf,
  MODEL_BASE,
  MODEL_FILES,
  RUNTIME_FILES,
} from '../../src/text-model/manifest.ts'

test.use({ serviceWorkers: 'block' })

test.beforeEach(async ({ page }) => {
  await page.goto('./#text')
})

test('one click cleans without touching the source, then undo restores the previous state', async ({
  page,
}) => {
  const source = 'In order to proceed\u200B we utilize the report.'
  const input = page.getByLabel('Text to inspect')
  await expect(page.getByRole('button', { name: 'Clean text', exact: true })).toBeDisabled()
  await input.fill(source)
  await expect(page.getByRole('button', { name: 'Copy cleaned text' })).toBeDisabled()
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('To proceed we use the report.')
  await expect(input).toHaveValue(source)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copy cleaned text' })).toBeDisabled()
  await expect(input).toHaveValue(source)
})

test('editing or changing options invalidates the result', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill('A report — ready.')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByText('Simplify typography', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copy cleaned text' })).toBeDisabled()
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await page.getByLabel('Text to inspect').fill('Another source.')
  await expect(page.getByRole('button', { name: 'Copy cleaned text' })).toBeDisabled()
})

test('empty output is a completed result, not an empty input', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill('\u200B')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('')
  await expect(page.getByText('All content was removed by the selected options.')).toBeVisible()
})

test('missing clipboard offers manual copying without throwing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }),
  )
  await page.getByLabel('Text to inspect').fill('Some text.')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await page.getByRole('button', { name: 'Copy cleaned text' }).click()
  await expect(page.getByRole('button', { name: 'Select text to copy' })).toBeVisible()
  expect(errors).toEqual([])
})

test('unsupported WebGPU leaves basic cleaning usable without downloading a model', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }),
  )
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/vendor/text/')) requests.push(request.url())
  })
  await page.getByLabel('Text to inspect').fill('In order to proceed.')
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('deep')
  await expect(page.getByText(/needs WebGPU with shader-f16/)).toBeVisible()
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('To proceed.')
  expect(requests).toEqual([])
})

for (const mode of ['deep', 'ultra'] as const) {
  for (const scenario of ['accepted', 'rejected', 'cancel', 'edit', 'error'] as const) {
    test(`Mode ${mode} ${scenario} with an isolated worker`, async ({ page }) => {
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
          configurable: true,
        }),
      )
      await page.context().route('**/assets/text.worker-*.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `
      self.onmessage = ({data}) => {
        self.postMessage({kind:'progress',text:'Test model running'});
        setTimeout(() => self.postMessage({id:data.id,kind:${JSON.stringify(scenario === 'error' ? 'error' : 'answer')},text:${JSON.stringify(scenario === 'rejected' ? 'Sales reached 999 units.' : scenario === 'error' ? 'Model unavailable.' : 'The team sold 10 units.')}}), ${scenario === 'cancel' || scenario === 'edit' ? 2000 : 40});
      }`,
        }),
      )
      await page.getByLabel('Text to inspect').fill('Sales reached 10 units.')
      await page.getByText('Advanced options', { exact: true }).click()
      await page.getByLabel('Cleaning mode').selectOption(mode)
      await page.getByRole('button', { name: 'Clean text', exact: true }).click()
      if (scenario === 'cancel' || scenario === 'edit') {
        await expect(page.locator('[aria-live]').getByText('Test model running')).toBeVisible()
        if (scenario === 'cancel') {
          await page.getByRole('button', { name: 'Cancel', exact: true }).click()
          await expect(page.locator('output')).toHaveText('Sales reached 10 units.')
        } else {
          await page.getByLabel('Text to inspect').fill('Another document.')
          await expect(page.getByRole('button', { name: 'Copy cleaned text' })).toBeDisabled()
        }
      } else {
        await expect(page.getByRole('button', { name: 'Clean text', exact: true })).toBeEnabled()
        await expect(page.locator('output')).toHaveText(
          scenario === 'accepted' ? 'The team sold 10 units.' : 'Sales reached 10 units.',
        )
        if (scenario !== 'accepted')
          await expect(page.getByText(/Basic cleaning is ready/)).toBeVisible()
        if (scenario === 'rejected')
          await expect(
            page.getByText(/number 10: present in the source, missing from the rewrite/),
          ).toBeVisible()
      }
      await expect(page.getByLabel('Text to inspect')).toHaveValue(
        scenario === 'edit' ? 'Another document.' : 'Sales reached 10 units.',
      )
    })
  }
}

test('advanced settings stay out of the default workflow and show when Deep is enabled', async ({
  page,
}) => {
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('deep')
  await page.getByText('Advanced options', { exact: true }).click()
  await expect(page.getByText('Deep clean on', { exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test('Deep does not rewrite or download a model when cleaning removes all content', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
      configurable: true,
    }),
  )
  const requests: string[] = []
  page.on('request', (request) => {
    if (/text\.worker-|\/vendor\/text\//.test(request.url())) requests.push(request.url())
  })
  await page.getByLabel('Text to inspect').fill('\u200B')
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('deep')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('')
  await expect(page.getByText('All content was removed by the selected options.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clean text', exact: true })).toBeEnabled()
  expect(requests).toEqual([])
})

test('copies cleaned multilingual text while preserving code, emoji and the source', async ({
  page,
}) => {
  const original =
    'Résumé\u200B 👨‍👩‍👧 — prêt. می\u200Cروم\n`const value = "—"`\nhttps://example.com/report?id=42&utm_source=chatgpt.com'
  const cleaned =
    'Résumé 👨‍👩‍👧 - prêt. می\u200Cروم\n`const value = "—"`\nhttps://example.com/report?id=42'
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset['copied'] = value
        },
      },
      configurable: true,
    }),
  )
  await page.getByLabel('Text to inspect').fill(original)
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText(cleaned)
  await page.getByRole('button', { name: 'Copy cleaned text' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-copied', cleaned)
  await expect(page.getByLabel('Text to inspect')).toHaveValue(original)
})

test('Ultra replaces custom settings with safe defaults and restores them when leaving', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true }),
  )
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByText('Simplify typography', { exact: true }).click()
  await page.getByText('Simplify wording', { exact: true }).click()
  await page.getByText('Paranoid mode', { exact: true }).click()
  await page.getByText('Normalise confusable letters', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('ultra')
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await page
    .getByLabel('Text to inspect')
    .fill('In order to proceed\u200B — 👨‍👩‍👧 می\u200Cروم Кириллица.')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('To proceed - 👨‍👩‍👧 می\u200Cروم Кириллица.')
  await expect(page.getByText(/Basic cleaning is ready/)).toBeVisible()
  await page.getByText('Advanced options', { exact: true }).click()
  await expect(page.getByText('Ultra on', { exact: true })).toBeVisible()
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('standard')
  await expect(page.getByRole('button', { name: 'Copy cleaned text' })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: /Simplify typography/ })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Simplify wording/ })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Paranoid mode/ })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /Normalise confusable/ })).toBeChecked()
})

test('Ultra removes marks reintroduced by a rewrite and retries altered numbers', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
      configurable: true,
    }),
  )
  await page.context().route('**/assets/text.worker-*.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
    let attempt = 0;
    self.onmessage = ({data}) => self.postMessage({id:data.id,kind:'answer',text: ++attempt < 3 ? 'Sales reached 99 units.' : 'The team sold\\u200B 10 units.'});
  `,
    }),
  )
  await page.getByLabel('Text to inspect').fill('Sales reached 10 units.')
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('ultra')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('The team sold 10 units.')
  await expect(page.getByText(/Ultra complete/)).toBeVisible()
})

for (const mode of ['deep', 'ultra'] as const) {
  for (const response of [
    'bonjour c cool',
    'The document should remain as is, without any changes or modifications.',
  ]) {
    test(`${mode} distinguishes unchanged text from model commentary: ${response}`, async ({
      page,
    }) => {
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
          configurable: true,
        }),
      )
      await page.context().route('**/assets/text.worker-*.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `self.onmessage = ({data}) => self.postMessage({id:data.id,kind:'answer',text:${JSON.stringify(response)}})`,
        }),
      )
      await page.getByLabel('Text to inspect').fill('bonjour c cool')
      await page.getByText('Advanced options', { exact: true }).click()
      await page.getByLabel('Cleaning mode').selectOption(mode)
      await page.getByRole('button', { name: 'Clean text', exact: true }).click()
      await expect(page.locator('output')).toHaveText('bonjour c cool')
      await expect(
        page.getByText(
          response === 'bonjour c cool'
            ? /returned your text unchanged/
            : /editing instructions or commentary: returned instead of just the edited text/,
        ),
      ).toBeVisible()
    })
  }
}

for (const mode of ['deep', 'ultra'] as const) {
  for (const recover of [false, true]) {
    test(`${mode} rejects translations${recover ? ' and accepts a French retry' : ''}`, async ({
      page,
    }) => {
      const source =
        'Le projet avance bien. Nous avons terminé la première étape et nous préparons la suite.'
      const translated =
        'The project is progressing well. We have completed the first stage and are preparing the next one.'
      const corrected =
        'Le projet progresse bien. Nous avons achevé la première étape et préparons la suivante.'
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
          configurable: true,
        }),
      )
      await page.context().route('**/assets/text.worker-*.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `let attempts = 0; self.onmessage = ({data}) => self.postMessage({id:data.id,kind:'answer',text: ++attempts > 1 && ${recover} ? ${JSON.stringify(corrected)} : ${JSON.stringify(translated)}})`,
        }),
      )
      await page.getByLabel('Text to inspect').fill(source)
      await page.getByText('Advanced options', { exact: true }).click()
      await page.getByLabel('Cleaning mode').selectOption(mode)
      await page.getByRole('button', { name: 'Clean text', exact: true }).click()
      await expect(page.locator('output')).toHaveText(recover ? corrected : source)
      if (!recover) await expect(page.getByText(/Keep French/)).toBeVisible()
      await expect(page.getByLabel('Text to inspect')).toHaveValue(source)
    })
  }
}

test('WebGPU without half precision keeps basic cleaning and never downloads the model', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ features: new Set() }) },
      configurable: true,
    }),
  )
  const requests: string[] = []
  page.on('request', (request) => {
    if (/text\.worker-|\/vendor\/text\//.test(request.url())) requests.push(request.url())
  })
  await page.getByLabel('Text to inspect').fill('bonjour\u200B c cool')
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByLabel('Cleaning mode').selectOption('ultra')
  await expect(page.getByText(/needs WebGPU with shader-f16/)).toBeVisible()
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('bonjour c cool')
  expect(requests).toEqual([])
})

// The reported failure: a short French line read as Polish by the detector,
// answered in Polish by the model, and waved through by a language gate that
// compared Polish against Polish. Caught now without asking what language
// either side is in.
for (const mode of ['deep', 'ultra'] as const) {
  test(`${mode} refuses a short rewrite that replaced the text instead of correcting it`, async ({
    page,
  }) => {
    const source = 'Hello ça dit quoi wsh ?'
    const replaced = 'Chy jest co wiesz wsh?'
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
        configurable: true,
      }),
    )
    await page.context().route('**/assets/text.worker-*.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `self.onmessage = ({data}) => self.postMessage({id:data.id,kind:'answer',text:${JSON.stringify(replaced)}})`,
      }),
    )
    await page.getByLabel('Text to inspect').fill(source)
    await page.getByText('Advanced options', { exact: true }).click()
    await page.getByLabel('Cleaning mode').selectOption(mode)
    await page.getByRole('button', { name: 'Clean text', exact: true }).click()
    await expect(page.locator('output')).toHaveText(source)
    await expect(page.getByText(/only 1 of 5 words from the source survived/)).toBeVisible()
    await expect(page.getByLabel('Text to inspect')).toHaveValue(source)
  })
}

// The local model panel under Advanced options: what is on this device, and
// the three things a visitor can do about it. The worker is mocked; the Cache
// API is real, which is the part worth testing.
const entriesFor = (files: readonly string[]) =>
  files.map((file) => ({
    scope: cacheScopeOf(file),
    url: new URL(`${MODEL_BASE}${file}`, 'http://localhost:4179/unmark/').href,
  }))

test('the model panel reports the model, device, storage and memory, then downloads on demand', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
      configurable: true,
    }),
  )
  await page.context().route('**/assets/text.worker-*.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
      self.onmessage = ({data}) => {
        self.postMessage({kind:'progress',text:'Fetching param cache[3/18]'});
        setTimeout(() => self.postMessage({id:data.id,kind:data.kind === 'prepare' ? 'ready' : 'answer',text:''}), 300);
      }`,
    }),
  )
  await page.getByText('Advanced options', { exact: true }).click()
  const status = page.getByLabel('Local model status')
  await expect(status).toContainText('Qwen3.5 0.8B')
  await expect(status).toContainText('443 MB · 15 files')
  await expect(status).toContainText('WebLLM 0.2.85')
  await expect(status).toContainText('WebGPU with shader-f16 available')
  await expect(status).toContainText('Not downloaded')
  await expect(status).toContainText('Not loaded')
  await expect(status).toContainText('4,096 token context')
  await expect(page.getByRole('button', { name: 'Delete downloaded files' })).toHaveCount(0)

  await page.getByLabel('Text to inspect').fill('Some text.')
  await page.getByRole('button', { name: 'Download model', exact: true }).click()
  await expect(status).toContainText('Fetching param cache[3/18]')
  // The worker is busy with the download; a rewrite cannot start under it.
  await expect(page.getByRole('button', { name: 'Clean text', exact: true })).toBeDisabled()
  await expect(status).toContainText('Loaded · ready to rewrite')
  await expect(page.getByText(/The model is downloaded and loaded/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clean text', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Download model', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Release model memory', exact: true }).click()
  await expect(status).toContainText('Not loaded')
  await expect(page.getByText(/Model released from memory/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download model', exact: true })).toBeEnabled()
})

test('a download can be cancelled from the panel and leaves the tab usable', async ({ page }) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
      configurable: true,
    }),
  )
  await page.context().route('**/assets/text.worker-*.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `self.onmessage = () => self.postMessage({kind:'progress',text:'Fetching param cache[1/18]'})`,
    }),
  )
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByRole('button', { name: 'Download model', exact: true }).click()
  await expect(page.getByLabel('Local model status')).toContainText('Fetching param cache[1/18]')
  await page.getByRole('button', { name: 'Cancel download', exact: true }).click()
  await expect(page.getByLabel('Local model status')).toContainText('Not loaded')
  await expect(page.getByText(/Download cancelled/)).toBeVisible()
  await page.getByLabel('Text to inspect').fill('Some text.')
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('Some text.')
})

test('the panel counts cached model files and deletes them from every WebLLM store', async ({
  page,
}) => {
  const entries = entriesFor(RUNTIME_FILES)
  const seed = async (count: number) =>
    page.evaluate(
      (items) =>
        Promise.all(
          items.map(async ({ scope, url }) =>
            (await caches.open(scope)).put(url, new Response('x')),
          ),
        ),
      entries.slice(0, count),
    )
  // Seeded in the same document: Playwright's WebKit keeps no Cache API
  // entries across a navigation, and the panel re-reads the disk on disclosure.
  await seed(2)
  await page.getByText('Advanced options', { exact: true }).click()
  await expect(page.getByLabel('Local model status')).toContainText('Partial · 2 of 15 files')
  await page.getByText('Advanced options', { exact: true }).click()

  // Everything the runtime fetches, plus the three served files an older
  // runtime could have cached: deleting must clear all of them.
  await seed(entries.length)
  await page.evaluate(
    (items) =>
      Promise.all(
        items.map(async ({ scope, url }) => (await caches.open(scope)).put(url, new Response('x'))),
      ),
    entriesFor(MODEL_FILES.filter((file) => !RUNTIME_FILES.includes(file))),
  )
  await page.getByText('Advanced options', { exact: true }).click()
  await expect(page.getByLabel('Local model status')).toContainText(
    'Downloaded · 443 MB cached for offline use',
  )
  await page.getByRole('button', { name: 'Delete downloaded files', exact: true }).click()
  await expect(page.getByLabel('Local model status')).toContainText('Not downloaded')
  await expect(page.getByText(/Deleted 18 cached files/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete downloaded files' })).toHaveCount(0)
  const left = await page.evaluate(async (items) => {
    const found = await Promise.all(
      items.map(
        async ({ scope, url }) => (await (await caches.open(scope)).match(url)) !== undefined,
      ),
    )
    return found.filter(Boolean).length
  }, entriesFor(MODEL_FILES))
  expect(left).toBe(0)
})

test('the panel names the missing GPU feature and keeps its actions off without one', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => ({ features: new Set() }) },
      configurable: true,
    }),
  )
  await page.getByText('Advanced options', { exact: true }).click()
  await expect(page.getByText(/needs WebGPU with shader-f16/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download model', exact: true })).toBeDisabled()
})
