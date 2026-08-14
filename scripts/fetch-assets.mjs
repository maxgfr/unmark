#!/usr/bin/env node
// Pulls the large binaries the image pipeline needs, against pinned checksums.
//
// They are deliberately not in git: a clone stays small, and the deployed site
// still serves every one of them from its own origin, which is what lets the
// CSP keep `connect-src 'self'` for the whole image pipeline. A model fetched
// from someone else's CDN at runtime would be a request this app promises not
// to make.
//
// Pinning is not ceremony. These files are executed as WebAssembly and run over
// the user's images; a checksum is the difference between "we downloaded a
// model" and "we downloaded the model we reviewed".

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'public', 'vendor')

// Each entry: where it lands under public/vendor/, where it comes from, its
// SHA-256, and why the app needs it. Regenerate a checksum with:
//   curl -sL <url> | shasum -a 256
export const ASSETS = []

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function alreadyGood(path, expected) {
  try {
    return sha256(await readFile(path)) === expected
  } catch {
    return false
  }
}

let fetched = 0
let cached = 0

// Sequential on purpose. These are tens of megabytes each; downloading them in
// parallel turns a readable progress log into an unreadable one and makes a
// checksum failure land after everything else has already been written.
// oxlint-disable no-await-in-loop
for (const asset of ASSETS) {
  const path = join(VENDOR, asset.file)

  if (await alreadyGood(path, asset.sha256)) {
    cached += 1
    console.log(`  cached   ${asset.file}`)
    continue
  }

  console.log(`  fetching ${asset.file} — ${asset.why}`)
  const response = await fetch(asset.url)
  if (!response.ok) {
    console.error(`\n  Failed to fetch ${asset.url}: ${response.status} ${response.statusText}\n`)
    process.exit(1)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== asset.sha256) {
    console.error(
      `\n  Checksum mismatch for ${asset.file}\n` +
        `    expected ${asset.sha256}\n` +
        `    actual   ${actual}\n\n` +
        '  The upstream artifact changed. Review the new file before updating\n' +
        '  the pin — this is exactly the case the checksum exists to catch.\n',
    )
    process.exit(1)
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  fetched += 1
}

if (ASSETS.length === 0) {
  console.log('  No pinned assets yet — the image pipeline lands in a later milestone.')
} else {
  console.log(`  Assets ready — ${fetched} fetched, ${cached} already present and verified.`)
}
