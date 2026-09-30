import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The committed evaluation corpus has to stay what the manifest says it is.
// A file edited without its hash, a document under a licence this repository
// cannot carry, a "human" text written after chat models were public: each of
// these would quietly change what the evaluation numbers mean.

const ROOT = join(import.meta.dirname, '..', '..', 'fixtures', 'authorship')

/** Licences the committed subset may carry. No NC, no ND, nothing unlicensed. */
const ALLOWED = new Set([
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-2.5',
  'CC0-1.0',
  'PD',
  'etalab-2.0',
  'OGL-UK-3.0',
  'Apache-2.0',
])

interface Entry {
  id: string
  path: string
  label: 'human' | 'ai' | 'humanized' | 'mixed'
  lang: 'fr' | 'en'
  genre: string
  split: 'train' | 'test'
  sha256: string
  words: number
  source: string
  url?: string
  date?: string
  license: string
  model?: string
  prompt?: string
  twinOf?: string
  derivedFrom?: string
  transform?: string
  mixedSpans?: { start: number; end: number }[]
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  documents: Entry[]
}
const documents = manifest.documents

describe('authorship corpus manifest', () => {
  it('lists documents of every label in both languages', () => {
    for (const label of ['human', 'ai', 'humanized', 'mixed']) {
      for (const lang of ['fr', 'en']) {
        expect(
          documents.some((d) => d.label === label && d.lang === lang),
          `${label}/${lang}`,
        ).toBe(true)
      }
    }
  })

  it('gives every document a unique id and an existing file with the recorded hash', () => {
    expect(new Set(documents.map((d) => d.id)).size).toBe(documents.length)
    for (const doc of documents) {
      const bytes = readFileSync(join(ROOT, doc.path))
      expect(createHash('sha256').update(bytes).digest('hex'), doc.id).toBe(doc.sha256)
    }
  })

  it('lists every text file under the corpus directories, and nothing else', () => {
    const listed = new Set(documents.map((d) => d.path))
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : [relative(ROOT, path)]
      })
    for (const label of ['human', 'ai', 'humanized', 'mixed']) {
      if (!existsSync(join(ROOT, label))) continue
      for (const file of walk(join(ROOT, label))) expect(listed.has(file), file).toBe(true)
    }
  })

  it('carries only licences this repository may redistribute', () => {
    for (const doc of documents) {
      expect(ALLOWED.has(doc.license), `${doc.id}: ${doc.license}`).toBe(true)
      expect(doc.license, doc.id).not.toMatch(/NC|ND/)
    }
  })

  it('dates every human text before chat models were public', () => {
    for (const doc of documents.filter((d) => d.label === 'human')) {
      expect(doc.date, doc.id).toBeDefined()
      expect((doc.date as string) < '2022-11-01', `${doc.id}: ${doc.date}`).toBe(true)
      expect(doc.url, doc.id).toMatch(/^https:\/\//)
    }
  })

  it('records the model and prompt behind every generated text', () => {
    for (const doc of documents.filter((d) => d.label === 'ai')) {
      expect(doc.model, doc.id).toBeTruthy()
      expect(doc.prompt, doc.id).toBeTruthy()
    }
    for (const doc of documents.filter((d) => d.label === 'humanized' || d.label === 'mixed')) {
      expect(doc.derivedFrom ?? doc.transform, doc.id).toBeTruthy()
    }
  })

  it('keeps each mixed span inside its file, and marks at least one', () => {
    for (const doc of documents.filter((d) => d.label === 'mixed')) {
      const length = readFileSync(join(ROOT, doc.path), 'utf8').length
      expect(doc.mixedSpans?.length, doc.id).toBeGreaterThan(0)
      for (const span of doc.mixedSpans ?? []) {
        expect(span.start).toBeGreaterThanOrEqual(0)
        expect(span.end).toBeLessThanOrEqual(length)
        expect(span.end).toBeGreaterThan(span.start)
      }
    }
  })

  it('splits into train and test, and keeps a twin with its original', () => {
    const byId = new Map(documents.map((d) => [d.id, d]))
    expect(documents.some((d) => d.split === 'train')).toBe(true)
    expect(documents.some((d) => d.split === 'test')).toBe(true)
    for (const doc of documents) {
      const origin = doc.twinOf ?? doc.derivedFrom
      const parent = origin ? byId.get(origin) : undefined
      if (parent) expect(doc.split, `${doc.id} vs ${parent.id}`).toBe(parent.split)
    }
  })
})
