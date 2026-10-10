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

  const verdict = page.getByText(
    /^(Likely AI-written|Uncertain: not enough to call it either way)$/,
  )
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

test('reads pasted HTML as a page: no tag in a passage, script bodies ignored', async ({
  page,
}) => {
  const html = `<script>const note = "plongeons dans un monde où tout change"</script>${GENERATED.split(
    '\n\n',
  )
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join('')}`
  await page.getByLabel('Text to inspect').fill(html)
  await page.getByText('Was this written by AI?', { exact: true }).click()
  await expect(page.getByRole('button', { name: /line 1 .*Que vous soyez/ })).toBeVisible()
  const passages = await page.getByRole('button', { name: /^line \d+/ }).allTextContents()
  expect(passages.length).toBeGreaterThan(0)
  expect(passages.every((text) => !text.includes('<'))).toBe(true)
})

test('says the assessment is out of date while the text is being typed', async ({ page }) => {
  const input = page.getByLabel('Text to inspect')
  await input.fill(GENERATED)
  await page.getByText('Was this written by AI?', { exact: true }).click()
  await expect(
    page.getByText(/^(Likely AI-written|Uncertain: not enough to call it either way)$/),
  ).toBeVisible()

  await input.press('End')
  await input.pressSequentially(' Encore une phrase.', { delay: 20 })
  await expect(page.getByText(/assessment updates when you stop typing/)).toBeVisible()
  await expect(page.getByText(/assessment updates when you stop typing/)).toBeHidden()
})

test('abstains on a short text instead of guessing', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill('Le conseil a voté le budget mardi soir.')
  await page.getByText('Was this written by AI?', { exact: true }).click()
  await expect(page.getByText(/^Not enough text to assess/)).toBeVisible()
})

const ACADEMIC = `## Discussion

To our knowledge, this is the series with the longest follow-up [12]. These data cannot be directly extrapolated to the device, but they could support the plausibility of an infectious risk [32]. The result could potentially change with a larger series [4]. In the literature, the definition of exposure varies from one series to another, and the mode of search weighs as much as the duration of follow-up [19,26]. The anchors were covered in most eyes, and the conjunctiva separated the implant from the surface in nearly nine displaced anchors out of ten.

We reviewed the charts of every patient who had the lens fitted between March 2019 and June 2020. Two surgeons did all of the operations, in the same theatre, with the same instruments. Patients came back at one week, one month and three months, and then once a year. At the four-year visit, the examining doctor lifted the upper lid, looked at each anchor under the slit lamp and wrote down whether it was buried, visible under the conjunctiva or poking through it.

## Conclusion

The cover held in most eyes: in nearly nine displaced anchors out of ten the conjunctiva still separated the implant from the surface. Prospective follow-up comparing pockets with flaps is needed before published rates can be compared across series of different design and duration [20].`

test('reads the academic register, lists the top sentences and repeated formulas', async ({
  page,
}) => {
  await page.getByLabel('Text to inspect').fill(ACADEMIC)
  await page.getByText('Was this written by AI?', { exact: true }).click()
  await expect(page.getByText(/^Register: auto \(academic\)$/)).toBeVisible()
  await expect(
    page.getByText(/^Catalogue: \d+ patterns read, the academic register included/),
  ).toBeVisible()
  await page.getByText(/^Top 10 sentences/).click()
  await expect(page.getByText(/sentences scoring highest, whatever their band/)).toBeVisible()
  await page.getByText(/^Repeated formulas/).click()
  await expect(page.getByText(/« .*nearly nine displaced anchors out of ten/).first()).toBeVisible()
})

test('sweeps every sentence with a habit, with a checked rewrite', async ({ page }) => {
  await page.getByLabel('Text to inspect').fill(ACADEMIC)
  await page.getByText('Was this written by AI?', { exact: true }).click()
  await page.getByText('Every sentence with a habit (sweep)', { exact: true }).click()
  await expect(page.getByRole('columnheader', { name: 'Replace with' })).toBeVisible()
  await expect(page.getByText('The result could change with a larger series [4].')).toBeVisible()

  await page
    .getByLabel(/Rewrites from an agent/)
    .fill('[{"id": "S0", "rewrite": "nothing"}, {"id": "nope", "rewrite": "x"}]')
  await page.getByRole('button', { name: 'Check and apply' }).click()
  await expect(page.getByRole('button', { name: 'Copy prompt for rewrites' })).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export sweep (.md)' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('sweep.md')
})
