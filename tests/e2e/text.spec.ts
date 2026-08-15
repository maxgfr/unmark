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
