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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

// Every reference file the skill sends an agent to has to exist. A skill that
// says "see references/formats.md" and ships no such file wastes a tool call
// and then makes the agent guess.
for (const [, path] of skillMd.matchAll(/`(references\/[\w.-]+)`/g)) {
  try {
    // oxlint-disable-next-line no-await-in-loop -- a handful of small reads
    await readFile(join(ROOT, 'skills', 'unmark', path), 'utf8')
  } catch {
    failures.push(`SKILL.md points at ${path}, which does not exist`)
  }
}

// ---------------------------------------------------------------------------
// The commands the documentation promises, run against real fixtures.
//
// The rest of this file checks that the bundle is fresh and dependency-free,
// which says nothing about whether it does what SKILL.md claims. A skill whose
// worked examples do not run is worse than no skill: an agent follows them,
// gets an error inside someone else's session, and improvises.

const work = await mkdtemp(join(tmpdir(), 'unmark-skill-'))
const at = (name) => join(work, name)

/** Run the bundle and return { code, out, err } without throwing. */
function unmark(args) {
  try {
    const out = execFileSync(process.execPath, [BUNDLE, ...args], {
      stdio: 'pipe',
      timeout: 30_000,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    })
    return { code: 0, out, err: '' }
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: error.stdout?.toString() ?? '',
      err: error.stderr?.toString() ?? '',
    }
  }
}

const check = (name, condition, detail) => {
  if (!condition) failures.push(`${name}: ${detail}`)
}

try {
  // A zero-width payload spelling `recipient-4417`, built the way stego.ts does.
  const bits = [...'recipient-4417']
    .map((c) => c.codePointAt(0).toString(2).padStart(8, '0'))
    .join('')
  const carriers = [...bits].map((b) => (b === '0' ? '​' : '‌')).join('')
  await writeFile(at('marked.txt'), `Quarterly results are attached.${carriers}`)

  const inspect = unmark(['inspect', at('marked.txt')])
  check('inspect', inspect.code === 1, 'should exit 1 when something confirmed is present')
  check('inspect', /Hidden payload|Zero-width/.test(inspect.out), 'should name what it found')

  const decode = unmark(['decode', at('marked.txt')])
  check('decode', decode.code === 0, 'should exit 0 when a payload is recovered')
  check('decode', decode.out.includes('recipient-4417'), 'should print the decoded payload')

  const clean = unmark(['clean', at('marked.txt')])
  check('clean', !/[​‌]/.test(clean.out), 'should leave no carriers behind')
  check('clean', clean.out.includes('Quarterly results'), 'should leave the words alone')

  // The load-bearing case the skill promises it will not break.
  await writeFile(at('family.txt'), 'The team \u{1F468}‍\u{1F469}‍\u{1F467} shipped it.')
  const family = unmark(['clean', at('family.txt')])
  check(
    'clean',
    family.out.includes('‍'),
    'must keep the joiner that holds an emoji family together',
  )

  // --plain, and the region guard that keeps it out of a code fence.
  const draft = [
    '# Strategic Negotiations And Global Partnerships',
    '',
    'In order to proceed we utilize the report. I hope this helps!',
    '',
    '```js',
    'const x = 1 // in order to keep this',
    '```',
  ].join('\n')
  await writeFile(at('draft.md'), draft)

  const plain = unmark(['clean', at('draft.md'), '--plain'])
  check(
    'clean --plain',
    plain.out.includes('To proceed we use the report.'),
    'should shorten filler',
  )
  check('clean --plain', !plain.out.includes('I hope this helps'), 'should drop chat pleasantries')
  check(
    'clean --plain',
    plain.out.includes('const x = 1 // in order to keep this'),
    'must not edit inside a fenced code block',
  )

  // The rewrite loop, end to end, including a rejection that must be rejected.
  const brief = unmark(['brief', at('draft.md')])
  check('brief', brief.code === 0, 'should exit 0')
  let parsed
  try {
    parsed = JSON.parse(brief.out)
  } catch {
    failures.push('brief: output is not valid JSON')
  }
  if (parsed) {
    check('brief', Array.isArray(parsed.tells), 'should list tells')
    check(
      'brief',
      parsed.protected?.some((span) => span.text.includes('const x = 1')),
      'should mark the code fence as protected',
    )
  }

  const prompt = unmark(['rewrite', at('draft.md'), '--print-prompt'])
  check('rewrite --print-prompt', prompt.code === 0, 'should exit 0 and contact nothing')
  check('rewrite --print-prompt', prompt.out.includes('PROTECTED SPANS'), 'should carry the brief')

  // A deliberately bad rewrite: pattern reintroduced, code fence edited.
  await writeFile(
    at('bad.md'),
    '# Strategic negotiations\n\nI hope this helps!\n\n```js\nconst x = 2\n```\n',
  )
  const verify = unmark(['verify', at('bad.md'), '--against', at('draft.md')])
  check('verify', verify.code === 1, 'must REJECT a rewrite that broke its constraints')
  check('verify', verify.out.includes('rejected'), 'should say it was rejected')
  check('verify', /protected/.test(verify.out), 'should name the edited code fence')

  const missing = unmark(['verify', at('bad.md')])
  check('verify', missing.code === 2, 'should exit 2 without --against')

  // audit over a tree.
  await writeFile(at('clean.txt'), 'Nothing hidden here at all.')
  const audit = unmark(['audit', work])
  check('audit', audit.code === 1, 'should exit 1 when a tree contains a marked file')
  check('audit', audit.out.includes('marked.txt'), 'should name the marked file')
  check('audit', !audit.out.includes('clean.txt'), 'should not list a clean file')
} finally {
  await rm(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n  Skill bundle FAILED — ${failures.length} finding(s):\n`)
  for (const failure of failures) console.error(`   x ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(`  Skill bundle passed — zero dependencies, fresh from src/core, runs clean.`)
