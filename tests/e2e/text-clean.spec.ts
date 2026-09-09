import { expect, test } from '@playwright/test'

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
  await page.getByText('Deep clean', { exact: true }).click()
  await expect(page.getByText(/WebGPU is unavailable/)).toBeVisible()
  await page.getByRole('button', { name: 'Clean text', exact: true }).click()
  await expect(page.locator('output')).toHaveText('To proceed.')
  expect(requests).toEqual([])
})

for (const scenario of ['accepted', 'rejected', 'cancel', 'edit', 'error'] as const) {
  test(`Deep clean ${scenario} with an isolated worker`, async ({ page }) => {
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'gpu', {
        value: { requestAdapter: async () => ({}) },
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
    await page.getByText('Deep clean', { exact: true }).click()
    await page.getByRole('button', { name: 'Clean text', exact: true }).click()
    if (scenario === 'cancel' || scenario === 'edit') {
      await expect(page.getByText('Test model running')).toBeVisible()
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
    }
    await expect(page.getByLabel('Text to inspect')).toHaveValue(
      scenario === 'edit' ? 'Another document.' : 'Sales reached 10 units.',
    )
  })
}
