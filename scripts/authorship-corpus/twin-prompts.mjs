#!/usr/bin/env node
// The generation tasks for the corpus's AI half: one twin per human document.
//
//   node scripts/authorship-corpus/twin-prompts.mjs > tasks.json
//
// Same subject (the human document's title), same genre, same language, about
// the same length. Only the title reaches the model — never the human text —
// so a twin cannot paraphrase its original. The prompt is the whole
// instruction and is recorded verbatim beside every generated file, and the
// models rotate across the sorted list so no genre belongs to one model.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
]

const PROMPTS = {
  fr: {
    admin: (t, n) =>
      `Rédige une fiche pratique d'environ ${n} mots pour un site d'information administrative, sur le sujet : « ${t} ». Réponds uniquement par le texte, sans titre.`,
    academic: (t, n) =>
      `Rédige le résumé d'un article scientifique d'environ ${n} mots intitulé « ${t} ». Réponds uniquement par le résumé, en un seul bloc, sans titre.`,
    encyclopedic: (t, n) =>
      `Rédige un texte encyclopédique neutre d'environ ${n} mots sur : ${t}. Réponds uniquement par le texte, en paragraphes, sans titre ni liste.`,
    news: (t, n) =>
      `Rédige un article de presse d'environ ${n} mots sur le sujet suivant : ${t}. Réponds uniquement par l'article, en paragraphes, sans titre.`,
    fiction: (t, n) =>
      `Écris un passage de fiction d'environ ${n} mots, dans le style d'une nouvelle française du XIXe siècle, sur le thème suivant : ${t}. Réponds uniquement par le passage, en paragraphes, sans titre.`,
  },
  en: {
    admin: (t, n) =>
      `Write a government information page of about ${n} words on the following subject: "${t}". Reply with the text only, no title.`,
    academic: (t, n) =>
      `Write the abstract of a scientific paper of about ${n} words titled "${t}". Reply with the abstract only, as a single block, no title.`,
    encyclopedic: (t, n) =>
      `Write a neutral encyclopedic text of about ${n} words about: ${t}. Reply with the text only, in paragraphs, no title or lists.`,
    news: (t, n) =>
      `Write a news article of about ${n} words on the following story: ${t}. Reply with the article only, in paragraphs, no headline.`,
    fiction: (t, n) =>
      `Write a passage of fiction of about ${n} words, in the style of a nineteenth-century English novel, on the following theme: ${t}. Reply with the passage only, in paragraphs, no title.`,
  },
}

export async function tasks() {
  const human = JSON.parse(
    await readFile(join(ROOT, 'fixtures', 'authorship', 'human-sources.json'), 'utf8'),
  ).documents.sort((a, b) => a.id.localeCompare(b.id))
  return human.map((doc, index) => {
    const length = Math.round(doc.words / 10) * 10
    const id = doc.id.replace(/^human-/, 'ai-')
    return {
      id,
      path: `ai/${doc.lang}/${id}.md`,
      twinOf: doc.id,
      lang: doc.lang,
      genre: doc.genre,
      model: MODELS[index % MODELS.length],
      prompt: PROMPTS[doc.lang][doc.genre](doc.title, length),
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await tasks(), undefined, 2))
}
