// The text tab, driven the way someone actually uses it: paste, read, copy.

import { expect, test } from '@playwright/test'

/** A zero-width payload spelling `recipient-4417`, built the way stego.ts does. */
const marked = (() => {
  const bits = [...'recipient-4417']
    .map((character) => character.codePointAt(0)!.toString(2).padStart(8, '0'))
    .join('')
  const carriers = [...bits].map((bit) => (bit === '0' ? '\u200B' : '\u200C')).join('')
  return `Quarterly results are attached.${carriers} Please keep this internal.`
})()

test.beforeEach(async ({ page }) => {
  await page.goto('./#text')
})

test('decodes a zero-width payload out of a pasted paragraph', async ({ page }) => {
  const input = page.getByLabel('Text to inspect')
  await input.fill(marked)

  // Twice on purpose: once in the payload panel, once as the evidence on the
  // finding that produced it. `.first()` rather than narrowing the selector,
  // because both appearances are correct and either would do.
  await expect(page.getByText('recipient-4417').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recovered payload' })).toBeVisible()
})

test('strips the carriers and leaves the words', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill(marked)

  const cleaned = await page.evaluate(() => {
    const output = document.querySelector('output')
    return output?.textContent ?? ''
  })

  expect(cleaned).toContain('Quarterly results are attached.')
  expect(cleaned).toContain('Please keep this internal.')
  // Membership rather than a character class: a class containing U+200D is
  // ambiguous about whether it means the joiner or a joined sequence, and the
  // linter is right to say so.
  const CARRIERS = '\u200B\u200C\u200D\u2060\uFEFF'
  expect([...cleaned].some((character) => CARRIERS.includes(character))).toBe(false)
})

test('keeps an emoji joiner, because it is holding a family together', async ({ page }) => {
  // The tool's own promise: a zero-width joiner between two emoji is not a
  // watermark, and removing it would turn one family into three people.
  await page.getByLabel('Text to inspect').fill('The team 👨‍👩‍👧 shipped it.')

  const cleaned = await page.evaluate(() => document.querySelector('output')?.textContent ?? '')
  expect(cleaned).toContain('👨‍👩‍👧')
})

test('the plain preset turns on both style passes together', async ({ page }) => {
  await page
    .getByLabel('Text to inspect')
    .fill('In order to proceed we utilize the report. I hope this helps!')

  await page.getByRole('button', { name: 'Make it plain' }).click()

  const cleaned = await page.evaluate(() => document.querySelector('output')?.textContent ?? '')
  expect(cleaned).toContain('To proceed we use the report.')
  expect(cleaned).not.toContain('I hope this helps')
})

test('strips a ChatGPT tracking parameter without being asked', async ({ page }) => {
  // A mark, not a style choice, so it comes off with no toggle involved.
  await page
    .getByLabel('Text to inspect')
    .fill('Source: https://example.com/report?utm_source=chatgpt.com')

  const cleaned = await page.evaluate(() => document.querySelector('output')?.textContent ?? '')
  expect(cleaned).toBe('Source: https://example.com/report')
})

test('says nothing about style until there is enough text to measure', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill('A short line — with one dash in it.')
  await expect(page.getByText(/needs 120 words to measure/)).toBeVisible()
})

/**
 * A paragraph carrying one of everything, so the offsets have to survive the
 * whole pipeline.
 *
 * The em dash sits after 112 carriers on purpose: it is the case where an
 * offset taken from a later pass used to be 112 characters out, which is
 * invisible in a printed report and lands on the wrong word in a selection.
 */
const LAYERED = `Quarterly results are attached.${marked.slice(marked.indexOf('​'), marked.lastIndexOf('​') + 1)} Please keep this — internal, in order to avoid confusion.`

test('clicking a finding selects exactly that span in the textarea', async ({ page }) => {
  const input = page.getByLabel('Text to inspect')
  await input.fill(LAYERED)

  const row = page.locator('li.finding-row').filter({ hasText: 'Typography' }).first()
  await row.locator('div[role="button"]').click()

  const selected = await input.evaluate((element) => {
    const area = element as HTMLTextAreaElement
    return area.value.slice(area.selectionStart, area.selectionEnd)
  })
  expect(selected).toBe('—')
})

test('the source view draws the carriers the textarea cannot show', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill(LAYERED)

  await expect(page.getByRole('heading', { name: 'Source' })).toBeVisible()
  // The chip names the codepoint. A highlight around a zero-width character
  // would be a zero-pixel-wide box, which is the whole reason this view exists.
  await expect(page.getByRole('button', { name: 'U+200B ZERO WIDTH SPACE' }).first()).toBeVisible()
})

test('applying one finding changes that one and nothing else, and undoes', async ({ page }) => {
  const input = page.getByLabel('Text to inspect')
  await input.fill(LAYERED)

  const row = page.locator('li.finding-row').filter({ hasText: 'Typography' }).first()
  await row.getByRole('button', { name: /^Apply/ }).click()

  const applied = await input.inputValue()
  expect(applied).not.toContain('—')
  expect(applied).toContain('-')
  // The carriers are a different finding and were not asked about. A per-row
  // apply that also ran the carrier pass would be the document-wide toggle
  // wearing a smaller button.
  expect(applied).toContain('​')
  expect(applied).toContain('in order to')

  await page.getByRole('button', { name: 'Undo' }).click()
  expect(await input.inputValue()).toBe(LAYERED)
})

test('a style tell says it describes the document rather than a place in it', async ({ page }) => {
  // `offset: 0, length: everything` reads exactly like a position. Offering to
  // select it would highlight the whole document as though every character of
  // it were the tell.
  await page
    .getByLabel('Text to inspect')
    .fill(`${'A sentence with an em dash — right here. '.repeat(40)}`)

  const style = page.locator('li.finding-row').filter({ hasText: 'Writing style' }).first()
  await expect(style).toContainText('whole document')
  await expect(style.getByRole('button', { name: /^Apply/ })).toHaveCount(0)
})
