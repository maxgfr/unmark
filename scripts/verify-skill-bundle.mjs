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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { crc32 } from 'node:zlib'

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

// Model-invocable, but only on request: the hosts may load it, and the
// description keeps the agent from reaching for it on its own.
if (/^disable-model-invocation:\s*true\s*$/m.test(frontmatter)) {
  failures.push('SKILL.md still sets disable-model-invocation: true')
}
if (!/Use only when the user explicitly asks for unmark/.test(frontmatter)) {
  failures.push('SKILL.md description no longer restricts the skill to explicit requests')
}
const codexPolicy = await readFile(
  join(ROOT, 'skills', 'unmark', 'agents', 'openai.yaml'),
  'utf8',
).catch(() => '')
if (
  !/^policy:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+allow_implicit_invocation:\s*true\s*$/m.test(codexPolicy)
) {
  failures.push('agents/openai.yaml does not allow implicit invocation')
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

/** A stored .docx: a heading, then one body paragraph per entry. */
function docx(paragraphs) {
  const para = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</w:t></w:r></w:p>`
  const body = [para('1. Introduction', 'Heading1'), ...paragraphs.map((p) => para(p))].join('')
  const parts = [
    ['[Content_Types].xml', '<Types/>'],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ]
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of parts) {
    const data = Buffer.from(content)
    const file = Buffer.from(name)
    const sum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(file.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(sum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(file.length, 28)
    entry.writeUInt32LE(offset, 42)
    chunks.push(local, file, data)
    central.push(entry, file)
    offset += 30 + file.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
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

  // inspect reports style, as SKILL.md says; audit still calls a styled draft clean.
  const styledDir = at('styled')
  await mkdir(styledDir)
  const styled = Array.from(
    { length: 9 },
    (_, i) =>
      `This rich tapestry is a testament to the ever-evolving landscape of case ${i}. It is not just robust, but seamless. The result is fast, cheap, and reliable, a pivotal and crucial moment.`,
  ).join(' ')
  await writeFile(join(styledDir, 'styled.txt'), styled)
  const styleInspect = unmark(['inspect', join(styledDir, 'styled.txt')])
  check('inspect', styleInspect.out.includes('Writing style'), 'should report the writing style')
  check('inspect', styleInspect.code === 0, 'style alone must not exit 1')
  const styleAudit = unmark(['audit', styledDir])
  check('audit', styleAudit.code === 0, 'must not count writing style as a mark')

  // detect: the structure of its answer, never a particular verdict — the
  // calibration is allowed to move, the contract is not.
  const french = [
    'Dans un monde en constante évolution, la transformation numérique joue un rôle crucial pour les entreprises. Plongeons au cœur de cette révolution qui redéfinit notre façon de travailler au quotidien, dans les bureaux comme sur le terrain.',
    "Que vous soyez dirigeant de PME ou responsable d'un grand groupe, il est essentiel de comprendre ces enjeux. Il ne s'agit pas seulement d'adopter de nouveaux outils, mais de repenser en profondeur l'organisation, les métiers et la culture de l'entreprise.",
    "Les solutions modernes permettent d'optimiser les processus en offrant une visibilité accrue, en permettant une collaboration fluide et en garantissant une sécurité renforcée. Par ailleurs, la formation des équipes constitue la pierre angulaire de toute transformation réussie, notamment pour les collaborateurs les moins familiers avec le numérique.",
    "En conclusion, à l'ère du numérique, l'avenir s'annonce prometteur pour les entreprises qui sauront saisir ces opportunités. N'hésitez pas à explorer ces pistes pour libérer tout le potentiel de votre organisation.",
    'Cordialement, [Votre nom]',
  ].join('\n\n')
  await writeFile(at('brouillon.md'), french)

  const detectJson = unmark(['detect', at('brouillon.md'), '--json'])
  let detected
  try {
    detected = JSON.parse(detectJson.out)
  } catch {
    failures.push('detect --json: output is not valid JSON')
  }
  if (detected) {
    check(
      'detect --json',
      ['likely_ai', 'uncertain', 'likely_human'].includes(detected.verdict),
      `should give a verdict on 150+ words, not "${detected.verdict}"`,
    )
    check(
      'detect --json',
      detected.findings.length > 0 && detected.findings.every((f) => f.line >= 1),
      'should locate every finding at a line',
    )
    check('detect --json', detected.disclaimer.startsWith('Not proof'), 'must carry the disclaimer')
    check(
      'detect --json',
      detected.findings.some((f) => f.patternId.startsWith('any.residue.')),
      'should name the unfilled placeholder as residue',
    )
    check('detect --json', [0, 1].includes(detectJson.code), 'should exit 0 or 1 on a verdict')
  }

  const markdown = unmark(['detect', '--format', 'md', at('brouillon.md')])
  check('detect --format md', markdown.out.includes('| Line |'), 'should render a passages table')

  await writeFile(at('court.txt'), french.split(/\s+/).slice(0, 40).join(' '))
  const short = unmark(['detect', at('court.txt')])
  check('detect', short.code === 3, 'should exit 3 on forty words')

  const german = unmark(['detect', at('brouillon.md'), '--lang', 'de'])
  check('detect --lang de', german.code === 2, 'should refuse an unsupported language with 2')

  // detect on a .docx, the way SKILL.md says it reads one: the body only, by
  // section, and the options the judge relies on.
  await writeFile(at('thesis.docx'), docx(french.split('\n\n')))
  const docxJson = unmark([
    'detect',
    at('thesis.docx'),
    '--json',
    '--register',
    'academic',
    '--top',
    '3',
  ])
  let fromDocx
  try {
    fromDocx = JSON.parse(docxJson.out)
  } catch {
    failures.push(`detect thesis.docx: output is not valid JSON (${docxJson.err.trim()})`)
  }
  if (fromDocx) {
    check('detect .docx', fromDocx.document?.container === 'DOCX', 'should read the .docx body')
    check('detect .docx', fromDocx.document?.skipped?.heading === 1, 'should leave the heading out')
    check(
      'detect .docx',
      fromDocx.spans.length === 3 &&
        fromDocx.spans.every((s) => s.location?.section === '1. Introduction'),
      'should list the top 3 sentences, each under its section',
    )
    check(
      'detect --register',
      fromDocx.coverage?.register === 'academic',
      'should read the register',
    )
  }

  // sweep: the worksheet, its table, its prompt and the gate on --apply.
  const sweepJson = unmark(['sweep', at('thesis.docx'), '--json'])
  let swept
  try {
    swept = JSON.parse(sweepJson.out)
  } catch {
    failures.push('sweep --json: output is not valid JSON')
  }
  if (swept) {
    check('sweep', swept.rows.length > 0, 'should list sentences carrying a habit')
    check(
      'sweep',
      swept.rows.every((row) => row.quote.found.length === row.quote.checked.length),
      'should find every quote word for word in the .docx',
    )
  }
  const sweepMd = unmark(['sweep', at('thesis.docx'), '--format', 'md'])
  check(
    'sweep --format md',
    sweepMd.out.includes('| Where | Current text | Replace with |'),
    'should render the table',
  )
  const sweepPrompt = unmark(['sweep', at('thesis.docx'), '--print-prompt'])
  check(
    'sweep --print-prompt',
    sweepPrompt.code === 0 && sweepPrompt.out.includes('"id"'),
    'should print the prompt',
  )
  if (swept?.rows[0]) {
    await writeFile(
      at('rewrites.json'),
      JSON.stringify([{ id: swept.rows[0].id, rewrite: 'Nothing.' }]),
    )
    const applied = unmark(['sweep', at('thesis.docx'), '--apply', at('rewrites.json'), '--json'])
    const row = JSON.parse(applied.out).rows.find((r) => r.id === swept.rows[0].id)
    check('sweep --apply', row?.rewrite?.source === 'agent', 'should attach the checked rewrite')
    check(
      'sweep --apply',
      applied.code === (row?.rewrite?.verified ? 0 : 1),
      'should exit 1 when a rewrite was rejected',
    )
  }

  // The rewrite commands read a document's prose, not its zip.
  const docBrief = unmark(['brief', at('thesis.docx')])
  check(
    'brief on a .docx',
    docBrief.code === 0 && JSON.parse(docBrief.out).words < 5000,
    'should brief the prose, not the zip bytes',
  )

  // Every option --help names is documented for the agent.
  const docs = [
    skillMd,
    ...(await Promise.all(
      ['authorship.md', 'formats.md', 'recipes.md', 'verdicts.md'].map((name) =>
        readFile(join(ROOT, 'skills', 'unmark', 'references', name), 'utf8').catch(() => ''),
      ),
    )),
  ].join('\n')
  const help = unmark(['--help']).out
  for (const flag of new Set(help.match(/--[a-z][a-z-]*/g) ?? [])) {
    check('docs', docs.includes(flag), `${flag} is in --help and in no skill document`)
  }
  check('docs', docs.includes('sweep'), 'the sweep command is not documented')
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
