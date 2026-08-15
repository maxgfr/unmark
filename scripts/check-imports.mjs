#!/usr/bin/env node
// The boundary that lets the page keep its promise.
//
// `src/cli/rewrite.ts` calls a model. It has `fetch` in it, it spawns a process,
// and both are correct there: a terminal is a place where a network is expected
// and where the user opted in by typing the command. The browser page is not.
//
// Its promise is stronger than "we do not upload": it is that nothing *can* be
// uploaded, enforced by a Content-Security-Policy pinned to `connect-src 'self'`
// and by `check-network.mjs` walking the built bundle. This gate is the third
// line, and the cheapest one: it follows the import graph from the page's entry
// point and fails if it ever reaches `src/cli`.
//
// A build-time check rather than a convention, because a convention is one
// careless import away from being untrue, and the failure would be silent.

import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'

const ENTRY = 'src/main.tsx'

/** Paths the page's import graph must never reach, and why. */
const FORBIDDEN = [
  ['src/cli/', 'the CLI opens sockets and spawns processes; the page must not be able to'],
  ['node:', 'a Node builtin in the page means the core stopped being environment-free'],
]

// Import clauses span lines. Prettier folds any import with a few names onto
// several of them, which is the default formatting of this very codebase — so a
// pattern using `[^'"\n]*` could not see `import {\n  runRewrite,\n} from
// '../cli/rewrite.ts'`, the exact violation this gate exists to catch. It was
// also already missing real edges in the current graph, which made the
// "boundary holds: N modules" line a count of an incomplete walk.
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[\s\S]{0,4000}?from\s*['"]([^'"]+)['"]/g
/** A side-effect import has no `from` at all. */
const SIDE_EFFECT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Node builtins are also builtins without the `node:` prefix.
 *
 * `import fs from 'fs'` is the same import as `import fs from 'node:fs'` and
 * means the same thing in the page: the core stopped being environment-free.
 */
const BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
])

const seen = new Set()
const problems = []

/** Walk the graph depth first, recording the path that reached each file. */
async function visit(file, trail) {
  if (seen.has(file)) return
  seen.add(file)

  let source
  try {
    source = await readFile(file, 'utf8')
  } catch {
    return // a .css or an asset; nothing to follow
  }

  const specifiers = [
    ...[...source.matchAll(IMPORT)].map((match) => match[1]),
    ...[...source.matchAll(SIDE_EFFECT)].map((match) => match[1]),
    ...[...source.matchAll(DYNAMIC)].map((match) => match[1]),
  ]

  for (const specifier of specifiers) {
    // A builtin without the prefix is the same builtin: `import fs from 'fs'`
    // means the core stopped being environment-free just as much as 'node:fs'.
    const builtin = specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0])

    for (const [prefix, why] of FORBIDDEN) {
      const hit = builtin
        ? prefix === 'node:'
        : prefix !== 'node:' &&
          resolve(dirname(file), specifier).includes(join(process.cwd(), prefix))
      if (hit) {
        problems.push({ specifier, why, trail: [...trail, file].map((p) => relative('.', p)) })
      }
    }

    if (!specifier.startsWith('.')) continue
    // A `?worker` or `?inline` suffix is a bundler instruction, not part of the
    // path. Dropping it keeps the subtree behind it inside the walk.
    const path = resolve(dirname(file), specifier.split('?')[0])
    // oxlint-disable-next-line no-await-in-loop -- a depth-first walk is sequential
    await visit(path, [...trail, file])
  }
}

await visit(resolve(ENTRY), [])

if (problems.length > 0) {
  process.stderr.write('\nThe page can reach code it must not:\n\n')
  for (const problem of problems) {
    process.stderr.write(`  ${problem.specifier}\n    ${problem.why}\n`)
    process.stderr.write(`    via ${problem.trail.join(' -> ')}\n\n`)
  }
  process.stderr.write(
    'The page promises that nothing can be uploaded, not merely that nothing is.\n' +
      'Keep model calls and node builtins in src/cli, which the page never imports.\n',
  )
  process.exitCode = 1
} else {
  process.stdout.write(`import boundary holds: ${seen.size} modules reachable from ${ENTRY}\n`)
}
