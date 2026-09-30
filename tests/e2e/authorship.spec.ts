// The authorship section, driven in a real browser: paste, open, read, export.

import { expect, test } from '@playwright/test'

const GENERATED = `Dans un monde en constante évolution, la transformation numérique joue un rôle crucial pour les entreprises. Plongeons au cœur de cette révolution qui redéfinit notre façon de travailler.

Que vous soyez dirigeant de PME ou responsable d'un grand groupe, il est essentiel de comprendre ces enjeux. Il ne s'agit pas seulement d'adopter de nouveaux outils, mais de repenser en profondeur l'organisation. En outre, l'intelligence artificielle offre des opportunités fascinantes, notamment en matière d'automatisation.

Les solutions modernes permettent d'optimiser les processus en offrant une visibilité accrue, en permettant une collaboration fluide et en garantissant une sécurité renforcée. Force est de constater que les organisations agiles, innovantes et résilientes tirent leur épingle du jeu.

Par ailleurs, la formation des équipes constitue la pierre angulaire de toute transformation réussie. Il convient de noter que l'accompagnement humain reste essentiel, notamment pour les collaborateurs les moins familiers avec le numérique.

En conclusion, à l'ère du numérique, l'avenir s'annonce prometteur pour les entreprises qui sauront saisir ces opportunités. N'hésitez pas à explorer ces pistes pour libérer tout le potentiel de votre organisation.`

test.beforeEach(async ({ page }) => {
  await page.goto('./#text')
  await page.getByText('Inspection details', { exact: true }).click()
})

test('states a verdict as a sentence, with the disclaimer under it', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill(GENERATED)
  await page.getByText('Was this written by AI?', { exact: true }).click()

  const verdict = page.getByText(/^(Likely AI-written|Uncertain: the signals are mixed)$/)
  await expect(verdict).toBeVisible()
  await expect(page.getByText(/^Not proof\./)).toBeVisible()
  await expect(page.getByText(/calibration /).first()).toBeVisible()

  // Amber means a confirmed mark. A style verdict is never drawn in it.
  const colour = await verdict.evaluate((node) => getComputedStyle(node).color)
  expect(colour).not.toBe('rgb(255, 176, 32)')
})

test('shows why a passage was flagged when it is selected', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill(GENERATED)
  await page.getByText('Was this written by AI?', { exact: true }).click()

  await page.getByRole('button', { name: /line 3 .*Que vous soyez/ }).click()
  await expect(page.getByText('fr.struct.que_vous_soyez')).toBeVisible()
  await expect(page.getByText(/^Fix: /).first()).toBeVisible()
})

test('exports the report as Markdown', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill(GENERATED)
  await page.getByText('Was this written by AI?', { exact: true }).click()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export report (.md)' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('authorship-report.md')
  const stream = await download.createReadStream()
  let body = ''
  for await (const chunk of stream) body += chunk.toString()
  expect(body).toContain('# Authorship assessment')
  expect(body).toContain('Not proof.')
})

test('abstains on a short text instead of guessing', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill('Le conseil a voté le budget mardi soir.')
  await page.getByText('Was this written by AI?', { exact: true }).click()
  await expect(page.getByText(/^Not enough text to assess/)).toBeVisible()
})
