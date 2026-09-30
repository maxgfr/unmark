#!/usr/bin/env node
// The full French evaluation corpus, fetched against pinned checksums.
//
// The committed subset in fixtures/authorship/ is small on purpose: it has to
// be licence-clean to live in this repository, and it has to run inside the
// test suite. A detector judged on sixty documents is judged on sixty
// documents, though, so the evaluation can also read the corpus published by
// binoculars-eu (Apache-2.0, https://github.com/linagora/binoculars-eu):
// 1,306 French texts, human and generated, with out-of-distribution and
// humanised sets.
//
// It is never committed. Some of its human texts are press articles and blog
// posts whose own licences the corpus does not state, and redistributing them
// here would be taking a licence on someone else's behalf. It lands in .cache/,
// which git ignores, and every file is checked against the SHA-256 below — a
// corpus that changed under the evaluation would make its numbers meaningless.
//
//   node scripts/fetch-authorship-corpus.mjs          fetch once, verify
//   node scripts/fetch-authorship-corpus.mjs --force  fetch again

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CORPUS_DIR = join(ROOT, '.cache', 'authorship-corpus', 'binoculars-eu')

/** The commit read, and what each file must hash to. */
export const PINNED = {
  repository: 'https://github.com/linagora/binoculars-eu',
  commit: '575c9fcd22d905b6cd3765769aec2b4fc40f6c66',
  license: 'Apache-2.0',
  files: {
    'binoculars-eu-corpus-fr-v1.1.jsonl':
      '922e6f60ef98e422f950a8fdf6f9876d13ca6d36b0c29d7c4be3c5a2035b779d',
    'binoculars-eu-corpus-fr-v01-ood.jsonl':
      '39b42fb8f2696d1d86492b9ef1f42c6ae68fbda85667289223c2bf2d833d69b9',
    'binoculars-eu-corpus-fr-v02-ood.jsonl':
      '2dbe78b777ff331c1c2c5c5501155e0500286fdd09e5f976494a7b851e663aca',
    'binoculars-eu-corpus-fr-v02-ood-humanized.jsonl':
      '52ae5a2fc96ec1ce06e9de110280fb570d41958e019627fdb1a2907bac1a0f54',
  },
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * The regular files in a tar archive, by path.
 *
 * Hand-rolled because it is forty lines and the alternative is a dependency.
 * GitHub's archives use pax headers for long names, so those are honoured.
 */
function untar(archive) {
  const files = new Map()
  let offset = 0
  let longName
  const text = (start, length) =>
    new TextDecoder().decode(archive.subarray(start, start + length)).replace(/\0.*$/s, '')

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = text(offset + 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100))
    const body = archive.subarray(offset + 512, offset + 512 + size)
    longName = undefined

    if (type === 'x') {
      const path = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body))?.[1]
      if (path) longName = path
    } else if (type === '0' || type === '\0') {
      files.set(name, body)
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function present() {
  try {
    for (const [name, hash] of Object.entries(PINNED.files)) {
      // oxlint-disable-next-line no-await-in-loop -- four small files
      if (sha256(await readFile(join(CORPUS_DIR, name))) !== hash) return false
    }
    return true
  } catch {
    return false
  }
}

export async function fetchCorpus({ force = false } = {}) {
  if (!force && (await present())) return CORPUS_DIR

  const url = `https://codeload.github.com/linagora/binoculars-eu/tar.gz/${PINNED.commit}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const files = untar(gunzipSync(new Uint8Array(await response.arrayBuffer())))

  await mkdir(CORPUS_DIR, { recursive: true })
  const prefix = `binoculars-eu-${PINNED.commit}/`
  for (const [name, hash] of Object.entries(PINNED.files)) {
    const bytes = files.get(`${prefix}calibration/corpus/${name}`)
    if (!bytes) throw new Error(`${name} is not in the archive of ${PINNED.commit}`)
    const actual = sha256(bytes)
    if (actual !== hash) throw new Error(`${name}: sha256 ${actual}, expected ${hash}`)
    // oxlint-disable-next-line no-await-in-loop -- four small files
    await writeFile(join(CORPUS_DIR, name), bytes)
  }

  const license = files.get(`${prefix}LICENSE`)
  if (license) await writeFile(join(CORPUS_DIR, 'LICENSE'), license)
  await writeFile(
    join(CORPUS_DIR, 'NOTICE'),
    `Evaluation corpus from ${PINNED.repository} at ${PINNED.commit},\n` +
      `distributed under ${PINNED.license} (see LICENSE). Fetched by\n` +
      'scripts/fetch-authorship-corpus.mjs; never committed to unmark.\n',
  )
  return CORPUS_DIR
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const dir = await fetchCorpus({ force: process.argv.includes('--force') })
    console.log(
      `  Corpus ready at ${dir} — ${Object.keys(PINNED.files).length} files, checksums verified.`,
    )
  } catch (error) {
    console.error(`\n  Could not fetch the corpus: ${error.message}\n`)
    process.exit(1)
  }
}
