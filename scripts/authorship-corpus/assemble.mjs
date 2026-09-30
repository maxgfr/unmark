#!/usr/bin/env node
// Build fixtures/authorship/manifest.json from its parts, deterministically.
//
//   node --experimental-strip-types scripts/authorship-corpus/assemble.mjs
//
// The committed corpus has four kinds of document, and each arrives a
// different way:
//
//   human      collected from dated, openly licensed sources by
//              collect-human.mjs, which writes human-sources.json
//   ai         generated for this corpus — a twin of each human document, same
//              subject, genre, language and length — from the tasks in
//              twin-prompts.mjs, which carry the model and the exact prompt; plus a few texts from the
//              binoculars-eu corpus, so more than one model family is present
//   humanized  derived here: `clean --plain`, seeded typos, a model rewrite
//              through `unmark rewrite --print-prompt` (rewrite-sources.json),
//              and humanizer-tool outputs from binoculars-eu
//   mixed      derived here: a human document with one paragraph of its
//              generated twin spliced in, the splice recorded as `mixedSpans`
//
// Splits keep a document with its twin and everything derived from it, so no
// subject is seen in training and tested again under another label.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectTextDocument, PLAIN } from '../../src/core/text/index.ts'
import { mulberry32 } from '../../src/core/text/authorship/evaluate.ts'
import { CORPUS_DIR, PINNED } from '../fetch-authorship-corpus.mjs'
import { tasks } from './twin-prompts.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = join(ROOT, 'fixtures', 'authorship')

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const words = (text) => text.trim().split(/\s+/).filter(Boolean).length
const readJson = async (name) =>
  existsSync(join(FIXTURES, name))
    ? JSON.parse(await readFile(join(FIXTURES, name), 'utf8'))
    : { documents: [] }

async function put(path, text) {
  await mkdir(dirname(join(FIXTURES, path)), { recursive: true })
  await writeFile(join(FIXTURES, path), text)
  return { path, sha256: sha256(text), words: words(text) }
}

// ------------------------------------------------------------------ sources

const human = (await readJson('human-sources.json')).documents
const rewrites = (await readJson('rewrite-sources.json')).documents

/** When the twins were generated, recorded once rather than re-dated per run. */
const GENERATED = '2026-09-30'

// The twins, from the same task list that produced them: model and prompt are
// read from there, never retyped.
const ai = []
for (const task of await tasks()) {
  if (!existsSync(join(FIXTURES, task.path))) continue
  const body = await readFile(join(FIXTURES, task.path), 'utf8')
  ai.push({
    id: task.id,
    path: task.path,
    sha256: sha256(body),
    words: words(body),
    label: 'ai',
    lang: task.lang,
    genre: task.genre,
    source: 'generated for this corpus',
    date: GENERATED,
    license: 'CC0-1.0',
    model: task.model,
    prompt: task.prompt,
    twinOf: task.twinOf,
  })
}
const byId = new Map([...human, ...ai].map((doc) => [doc.id, doc]))
const text = async (doc) => readFile(join(FIXTURES, doc.path), 'utf8')

/**
 * binoculars-eu texts from other model families and from humanizer tools.
 *
 * The longest of each source, whether or not it reaches 150 words: the
 * evaluation scores every document, and GPT-4o and Claude would otherwise be
 * missing entirely. `ood2-hybrid` is left out — it alternates human and
 * generated sentences, so neither label would be true of it.
 */
const BINOCULARS = [
  { file: 'binoculars-eu-corpus-fr-v02-ood.jsonl', source: 'ood2-gpt-4o', label: 'ai', take: 2 },
  { file: 'binoculars-eu-corpus-fr-v02-ood.jsonl', source: 'ood2-claude', label: 'ai', take: 2 },
  {
    file: 'binoculars-eu-corpus-fr-v02-ood.jsonl',
    source: 'ood2-luciole-8b',
    label: 'ai',
    take: 2,
  },
  {
    file: 'binoculars-eu-corpus-fr-v02-ood-humanized.jsonl',
    source: 'humanized-writehuman-gpt-4o',
    label: 'humanized',
    take: 1,
  },
  {
    file: 'binoculars-eu-corpus-fr-v02-ood-humanized.jsonl',
    source: 'humanized-writehuman-claude',
    label: 'humanized',
    take: 1,
  },
  {
    file: 'binoculars-eu-corpus-fr-v02-ood-humanized.jsonl',
    source: 'humanized-undetectable-luciole-8b',
    label: 'humanized',
    take: 1,
  },
]

const entries = [...human, ...ai]

if (existsSync(join(CORPUS_DIR, 'binoculars-eu-corpus-fr-v02-ood.jsonl'))) {
  for (const pick of BINOCULARS) {
    const rows = (await readFile(join(CORPUS_DIR, pick.file), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.source === pick.source)
      .sort((a, b) => words(b.text) - words(a.text) || a.id.localeCompare(b.id))
      .slice(0, pick.take)
    for (const row of rows) {
      const id = `${pick.label}-fr-bin-${row.id}`.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-')
      const stored = await put(`${pick.label}/fr/${id}.md`, `${row.text.trim()}\n`)
      entries.push({
        id,
        ...stored,
        label: pick.label,
        lang: 'fr',
        genre: pick.label === 'ai' ? 'ood' : 'humanized',
        source: `binoculars-eu@${PINNED.commit.slice(0, 12)} ${row.id}`,
        url: `${PINNED.repository}/blob/${PINNED.commit}/calibration/corpus/${pick.file}`,
        license: 'Apache-2.0',
        ...(pick.label === 'ai'
          ? {
              model: row.meta?.generator ?? pick.source,
              prompt: row.meta?.prompt ?? '(not recorded)',
            }
          : {
              transform: `${row.meta?.humanizer ?? 'humanizer'} (${pick.source})`,
              derivedFrom: row.meta?.source_id,
            }),
      })
    }
  }
}

// ------------------------------------------------------------------ humanised

/** Swap two inner letters in about one word in twenty-five, from a fixed seed. */
function typos(input, seed) {
  const random = mulberry32(seed)
  return input.replaceAll(/\p{L}{5,}/gu, (word) => {
    if (random() >= 0.04) return word
    const at = 1 + Math.floor(random() * (word.length - 3))
    return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2)
  })
}

const twins = (lang) =>
  ai.filter((doc) => doc.lang === lang && doc.twinOf).sort((a, b) => a.id.localeCompare(b.id))
for (const lang of ['fr', 'en']) {
  const [first, second] = twins(lang)
  if (first) {
    const cleaned = inspectTextDocument(await text(first), PLAIN).cleaned.output
    const id = `humanized-${lang}-plain-${first.id.replace(/^ai-[a-z]{2}-/, '')}`
    entries.push({
      id,
      ...(await put(`humanized/${lang}/${id}.md`, cleaned)),
      label: 'humanized',
      lang,
      genre: first.genre,
      source: 'derived',
      license: first.license,
      derivedFrom: first.id,
      transform: 'unmark clean --plain',
    })
  }
  if (second) {
    const id = `humanized-${lang}-typos-${second.id.replace(/^ai-[a-z]{2}-/, '')}`
    entries.push({
      id,
      ...(await put(`humanized/${lang}/${id}.md`, typos(await text(second), 7))),
      label: 'humanized',
      lang,
      genre: second.genre,
      source: 'derived',
      license: second.license,
      derivedFrom: second.id,
      transform: 'seeded letter swaps, one word in twenty-five (mulberry32, seed 7)',
    })
  }
}
entries.push(...rewrites)

// ------------------------------------------------------------------ mixed

/** Human documents that get one generated paragraph spliced in, by genre. */
const MIXED_GENRES = ['news', 'encyclopedic']
for (const lang of ['fr', 'en']) {
  const hosts = human
    .filter((doc) => doc.lang === lang && MIXED_GENRES.includes(doc.genre))
    .filter((doc) => ai.some((twin) => twin.twinOf === doc.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 2)
  for (const host of hosts) {
    const twin = ai.find((doc) => doc.twinOf === host.id)
    const paragraphs = (await text(host)).trim().split(/\n\s*\n/)
    const inserted = (await text(twin)).trim().split(/\n\s*\n/)[0]
    const before = `${paragraphs.slice(0, 1).join('\n\n')}\n\n`
    const body = `${before}${inserted}\n\n${paragraphs.slice(1).join('\n\n')}\n`
    const id = `mixed-${lang}-${host.id.replace(/^human-[a-z]{2}-/, '')}`
    entries.push({
      id,
      ...(await put(`mixed/${lang}/${id}.md`, body)),
      label: 'mixed',
      lang,
      genre: host.genre,
      source: 'derived',
      license: host.license,
      derivedFrom: host.id,
      transform: `first paragraph of ${twin.id} inserted after the first paragraph`,
      mixedSpans: [{ start: before.length, end: before.length + inserted.length }],
    })
  }
}

// ------------------------------------------------------------------ splits

const rootOf = (doc) => {
  let current = doc
  for (let step = 0; step < 4; step += 1) {
    const parent = byId.get(current.twinOf ?? current.derivedFrom)
    if (!parent) break
    current = parent
  }
  return current
}

const strata = new Map()
for (const doc of entries) {
  const root = rootOf(doc)
  const key = `${root.label === 'human' ? 'twinned' : root.label}/${root.lang}/${root.genre}`
  const group = strata.get(key) ?? new Set()
  group.add(root.id)
  strata.set(key, group)
}
const splitOfRoot = new Map()
for (const group of strata.values()) {
  ;[...group].sort().forEach((id, index) => splitOfRoot.set(id, index % 2 === 0 ? 'test' : 'train'))
}

const documents = entries
  .map((doc) => ({ ...doc, split: splitOfRoot.get(rootOf(doc).id) }))
  .sort((a, b) => a.id.localeCompare(b.id))

await writeFile(
  join(FIXTURES, 'manifest.json'),
  `${JSON.stringify({ version: 1, documents }, undefined, 2)}\n`,
)

// ------------------------------------------------------------------ licences

const lines = [
  '# Licences of the authorship evaluation corpus',
  '',
  'This directory is not under the repository’s MIT licence. Each document keeps',
  'the licence of its source, listed below and in `manifest.json`. Only licences',
  'that allow redistribution are admitted: no NC, no ND. Generated texts were',
  'written for this corpus and are dedicated to the public domain (CC0-1.0);',
  'texts taken from binoculars-eu are Apache-2.0 (see ../../THIRD_PARTY.md).',
  '',
  '| Document | Licence | Source | Author |',
  '| --- | --- | --- | --- |',
  ...documents.map(
    (doc) =>
      `| \`${doc.id}\` | ${doc.license} | ${doc.url ? `[${doc.source}](${doc.url})` : doc.source} | ${doc.author ?? (doc.model ? `generated by ${doc.model}` : '—')} |`,
  ),
  '',
]
await writeFile(join(FIXTURES, 'LICENSES.md'), lines.join('\n'))

console.log(
  `  ${documents.length} documents: ${['human', 'ai', 'humanized', 'mixed']
    .map((label) => `${documents.filter((d) => d.label === label).length} ${label}`)
    .join(', ')}; ${documents.filter((d) => d.split === 'test').length} in test.`,
)
