#!/usr/bin/env node
// Keeps the published skill honest about which core it is running.
//
// skills/unmark/scripts/unmark.mjs is a build artifact that has to be committed,
// because `npx skills add maxgfr/unmark` installs the repo as-is — there is no
// install step to build it. A committed artifact is a stale artifact waiting to
// happen: someone fixes a preservation rule in src/core, ships it to the page,
// and the skill keeps quietly stripping the character it was taught to keep.
//
// `pnpm verify` runs build:skill immediately before this, so a bundle that
// differs from a fresh build is a bundle that was never rebuilt.

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'skills', 'unmark', 'scripts', 'unmark.mjs')
const RELATIVE = 'skills/unmark/scripts/unmark.mjs'

const failures = []

let source = ''
try {
  source = await readFile(BUNDLE, 'utf8')
} catch {
  console.error(`\n  ${RELATIVE} is missing. Run: pnpm build:skill\n`)
  process.exit(1)
}

// Zero dependencies is the promise `npx skills add` makes on our behalf. Any
// bare import that is not a Node builtin would be a package the user has to
// install for a skill that claims to need nothing.
const BARE_IMPORT = /^\s*(?:import|export)[\s\S]*?from\s*['"]([^'".][^'"]*)['"]/gm
for (const [, specifier] of source.matchAll(BARE_IMPORT)) {
  if (!specifier.startsWith('node:')) {
    failures.push(`bundle imports "${specifier}" — the skill must have zero dependencies`)
  }
}

if (!source.startsWith('#!/usr/bin/env node')) {
  failures.push('bundle is missing its shebang, so it cannot be executed directly')
}

// A frontmatter-less SKILL.md is invisible to every agent that would load it.
const skillMd = await readFile(join(ROOT, 'skills', 'unmark', 'SKILL.md'), 'utf8').catch(() => '')
const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
if (!/^name:\s*unmark\s*$/m.test(frontmatter)) failures.push('SKILL.md frontmatter has no name')
if (!/^description:\s*\S/m.test(frontmatter)) {
  failures.push('SKILL.md frontmatter has no description — agents match on it')
}

// Staleness. In CI the checkout is clean, so any diff here is a bundle that was
// not rebuilt from the core it claims to ship.
try {
  execFileSync('git', ['diff', '--exit-code', '--', RELATIVE], { cwd: ROOT, stdio: 'pipe' })
} catch (error) {
  if (error.status === 1) {
    failures.push(
      `${RELATIVE} differs from a fresh build of src/core — ` +
        'rebuild with `pnpm build:skill` and commit the result',
    )
  }
  // Not a git repo, or git is unavailable: the other checks still ran.
}

// It has to actually start. A bundle that throws on load is worse than a stale
// one, because the failure surfaces inside someone else's agent session.
try {
  execFileSync(process.execPath, [BUNDLE, '--version'], { stdio: 'pipe', timeout: 10_000 })
} catch (error) {
  failures.push(`bundle failed to run \`--version\`: ${error.message.split('\n')[0]}`)
}

if (failures.length > 0) {
  console.error(`\n  Skill bundle FAILED — ${failures.length} finding(s):\n`)
  for (const failure of failures) console.error(`   x ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(`  Skill bundle passed — zero dependencies, fresh from src/core, runs clean.`)
