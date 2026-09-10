// The language gate, tested where it is used: a rewrite comes back and either
// clears `verifyRewrite` or does not, and `ultraClean` either ships it or keeps
// the deterministic result. Nothing here asserts a detector score.

import { expect, it } from 'vitest'
import { buildBrief, verifyRewrite, type Failure } from './rewrite.ts'
import { ultraClean } from './ultra.ts'
import { proseLanguages } from './text/language.ts'

const french =
  'Le projet avance bien. Nous avons terminé la première étape et nous préparons la suite.'
const english =
  'The project is progressing well. We have completed the first stage and are preparing the next one.'

/** A mark the deterministic clean removes, so Ultra has a baseline distinct from the input. */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b)

const languageFailures = (source: string, candidate: string): Failure[] =>
  verifyRewrite(source, candidate, buildBrief(source)).failures.filter(
    (failure) => failure.kind === 'language',
  )

it.each([
  ['French to English', french, english, 'Keep French; the rewrite was detected as English'],
  ['English to French', english, french, 'Keep English; the rewrite was detected as French'],
  [
    'a short informal French line to English',
    'bonjour c cool',
    'Hello, this is cool.',
    'Keep French; the rewrite was detected as English',
  ],
  [
    'a technical French paragraph to English, numbers and paths intact',
    "Le service renvoie une erreur 500 quand le token expire. Le refresh token doit être régénéré via l'endpoint /auth/refresh.",
    'The service returns a 500 error when the token expires. The refresh token must be regenerated via the /auth/refresh endpoint.',
    'Keep French; the rewrite was detected as English',
  ],
  [
    'a French list to English',
    "- Vérifier les logs\n- Redémarrer le service\n- Prévenir l'équipe",
    '- Check the logs\n- Restart the service\n- Notify the team',
    'Keep French; the rewrite was detected as English',
  ],
])(
  'rejects a translation even when every extracted fact survives: %s',
  (_, source, candidate, reason) => {
    const verdict = verifyRewrite(source, candidate, buildBrief(source))
    expect(verdict.ok).toBe(false)
    const language = verdict.failures.filter((failure) => failure.kind === 'language')
    expect(language).toHaveLength(1)
    expect(language[0]?.detail).toBe(reason)
  },
)

it('keeps the cleaned French source when every Ultra candidate switches language', async () => {
  const prompts: string[] = []
  const outcome = await ultraClean(french + ZERO_WIDTH_SPACE, async (prompt) => {
    prompts.push(prompt)
    return english
  })
  expect(outcome.kind).toBe('rejected')
  expect(outcome.text).toBe(french)
  expect(outcome.notes.join(' ')).toContain('Keep French')
  // The refusal is aimed: every retry is told which language to write in.
  expect(prompts).toHaveLength(3)
  for (const retry of prompts.slice(1)) expect(retry).toContain('Keep French')
})

it('ships an Ultra rewrite that stays in French', async () => {
  const rewritten =
    'Le projet avance bien. La première étape est terminée et nous préparons déjà la suite.'
  const outcome = await ultraClean(french + ZERO_WIDTH_SPACE, async () => rewritten)
  expect(outcome.kind).toBe('accepted')
  expect(outcome.text).toBe(rewritten)
})

it.each([
  ['a numeric sentence', 'Sales reached 10 units.', 'Sales hit 10 units.'],
  ['a sentence that is mostly code', 'Run `a()` twice.', 'Call `a()` twice.'],
  ['a short French line rewritten in French', 'bonjour c cool', "Salut, c'est cool."],
  ['a short French line whose rewrite is too short to read', 'bonjour c cool', 'Salut, cool.'],
  [
    'a French sentence the detector reads as Portuguese, rewritten in French',
    'Merci pour votre retour. Nous corrigeons le bug et livrons un correctif demain.',
    'Merci de votre retour. Nous corrigeons le bug et un correctif sera livré demain.',
  ],
])('does not reject %s', (_, source, candidate) => {
  expect(languageFailures(source, candidate)).toEqual([])
})

it('still rejects the translation of a sentence the detector misreads', () => {
  const source = 'Merci pour votre retour. Nous corrigeons le bug et livrons un correctif demain.'
  const candidate = 'Thanks for your feedback. We are fixing the bug and shipping a patch tomorrow.'
  expect(languageFailures(source, candidate)).toHaveLength(1)
})

it('leaves the verdict to the other gates when the source is too short to identify', () => {
  // Nothing to require: the check must not invent a language for two words.
  expect(languageFailures('Sales reached 10 units.', 'Les ventes ont atteint 10 unités.')).toEqual(
    [],
  )
})

it('accepts a French edit while preserving an English quotation and code', () => {
  const quote = '"The report is ready for review and the team will deliver it tomorrow."'
  const fence =
    '```js\n// Build the report and send it to the reviewers before the deadline.\nbuild()\n```'
  const blockquote = '> The previous version shipped late because nobody reviewed the numbers.'
  const source = `Le rapport est prêt pour demain. Il confirme : ${quote}\n\n${fence}\n\n${blockquote}\n\nVoir \`const message = "hello world"\` dans le code.`
  const candidate = `Le rapport sera prêt demain. Il confirme : ${quote}\n\n${fence}\n\n${blockquote}\n\nVoir \`const message = "hello world"\` dans le code.`
  expect(verifyRewrite(source, candidate, buildBrief(source)).ok).toBe(true)
})

it('does not let protected English regions excuse a translated body', () => {
  const fence =
    '```js\n// Build the report and send it to the reviewers before the deadline.\nbuild()\n```'
  const source = `${french}\n\n${fence}`
  const candidate = `${english}\n\n${fence}`
  expect(languageFailures(source, candidate)).toHaveLength(1)
})

it('keeps both languages of a bilingual document', () => {
  const source = `${french}\n\n${english}`
  expect(languageFailures(source, source)).toEqual([])
  // Each half may be rephrased, in its own language.
  expect(
    languageFailures(
      source,
      `Le projet progresse bien. La première étape est faite et la suite se prépare.\n\nThe project is going well. The first stage is done and the next is being prepared.`,
    ),
  ).toEqual([])

  const halfTranslated = languageFailures(source, `${french}\n\n${french}`)
  expect(halfTranslated).toHaveLength(1)
  expect(halfTranslated[0]?.detail).toBe(
    'Keep French and English; the rewrite was detected as French',
  )
  expect(languageFailures(source, `${english}\n\n${english}`)).toHaveLength(1)
})

it('names every plausible language of an ambiguous passage, so a prompt never insists on the wrong one', () => {
  expect(proseLanguages(french)).toEqual(['fr'])
  expect(proseLanguages(`${french}\n\n${english}`)).toEqual(['fr', 'en'])
  // TinyLD reads this French sentence as Portuguese with French second.
  const misread = 'Merci pour votre retour. Nous corrigeons le bug et livrons un correctif demain.'
  expect(proseLanguages(misread)).toContain('fr')
  expect(proseLanguages(misread).length).toBeGreaterThan(1)
  expect(proseLanguages('Sales reached 10 units.')).toEqual([])
})

it('rejects a monolingual document that comes back with one paragraph translated', () => {
  const source = `${french}\n\n${french}`
  expect(languageFailures(source, `${french}\n\n${english}`)).toHaveLength(1)
})
