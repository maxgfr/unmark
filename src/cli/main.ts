// The terminal delivery of src/core, as a pure function of its arguments.
//
// Bundled by vite.skill.config.ts into one dependency-free file that ships as
// skills/unmark/scripts/unmark.mjs, so `npx skills add maxgfr/unmark` installs
// something that runs immediately. This file is the only place in the project
// allowed to import `node:` — the core underneath it stays environment-free,
// which is what lets the page and the terminal share one implementation.

import { chmod, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { VERSION } from '../core/index.ts'
import { cleanContainer, inspectContainer, type ContainerFormat } from '../core/container/index.ts'
import { decodeStego } from '../core/text/stego.ts'
import { PLAIN } from '../core/text/index.ts'
import { buildBrief, verifyRewrite, type RewriteVerdict } from '../core/rewrite.ts'
import { runRewrite } from './rewrite.ts'
import {
  collapseRuns,
  KIND_LABEL,
  outcomeOf,
  type Finding,
  type Outcome,
  type Verdict,
} from '../core/report.ts'
import { decodeUtf8 } from '../core/container/types.ts'

const USAGE = `unmark ${VERSION} — find, decode and strip watermarks and provenance marks

USAGE
  unmark inspect <file|->        report every mark found, change nothing
  unmark clean   <file|->        strip what is removable, print the result
  unmark decode  <file|->        recover payloads hidden in invisible characters
  unmark audit   <dir>           walk a tree and report every marked file

  unmark brief   <file|->        what a rewrite must fix and must not break (JSON)
  unmark rewrite <file|->        run the rewrite loop; local model by default
  unmark verify  <file|-> --against <original>
                                 did a rewrite clear the gates, or only read better

OPTIONS
  --json              machine-readable output
  --in-place          write the result back to the file (clean and rewrite)
  --force             clean a signed PDF anyway. The signature becomes void.
  --paranoid          also strip emoji glue and script joiners; CORRUPTS real text
  --confusables       map Cyrillic/Greek lookalikes back to Latin
  --typography        flatten em dashes, curly quotes and ellipses to ASCII
  --humanise          remove filler, chat pleasantries and signposting
  --plain             both of the above at once; changes how the prose reads,
                      and does NOT remove a statistical watermark
  --version, -V       print the version
  --help, -h          print this

REWRITE (the tells no regex reaches: word choice, and the shape of the argument)
  --print-prompt      emit the prompt and stop. No network, nothing spent.
  --model <id>        use a remote provider instead of a local one. The document
                      LEAVES YOUR MACHINE. Priced first when llm-models is present.
  --attempts <n>      how many tries before giving up and saying why (default 3)
  --against <file>    the original a rewrite is checked against (verify only)

  With no --model, rewrite talks to Ollama on 127.0.0.1 and nothing leaves the
  machine. The browser page has no rewrite at all: its Content-Security-Policy
  pins connect-src to 'self', and that is not negotiable for a feature.

FORMATS
  Text, Markdown, HTML, SVG, PNG, JPEG, WebP, GIF, HEIC, AVIF, MP4/MOV, PDF,
  DOCX, PPTX, XLSX, ODT, EPUB — sniffed from the bytes, not the extension

Visible watermarks in pixels — inpainting, generator badges — need a canvas and
a GPU, so they live in the browser: https://maxgfr.github.io/unmark/
Nothing is uploaded there either.
`

// ------------------------------------------------------------------ output

const tty = process.stdout.isTTY === true && !process.env['NO_COLOR']
const paint = (code: string, text: string) => (tty ? `[${code}m${text}[0m` : text)
const dim = (text: string) => paint('2', text)
const bold = (text: string) => paint('1', text)

const VERDICT_COLOR: Record<Verdict, string> = {
  confirmed: '33', // amber, the one signal colour
  probable: '37',
  informational: '2',
  likely_false_positive: '2',
}

const colourVerdict = (verdict: Verdict) => paint(VERDICT_COLOR[verdict], verdict)

// What was done, not how sure we are — the two are different questions, and a
// report that answers only the second leaves the reader guessing at the first.
const OUTCOME_COLOR: Record<Outcome, string> = {
  removed: '31',
  kept: '32',
  available: '36',
  reported: '2',
}

const colourOutcome = (outcome: Outcome) => paint(OUTCOME_COLOR[outcome], outcome)

const pad = (text: string, width: number) => text.padEnd(width)

function renderFindings(all: readonly Finding[], out: string[]): void {
  if (all.length === 0) {
    out.push(dim('  nothing found'))
    return
  }

  // An eleven-character payload is eighty-eight carriers. Listing each one
  // buries the single line that matters — the decoded payload — under near
  // identical rows, so crowds are folded into one summary each.
  const findings = collapseRuns(all)

  // Nine, not eight: `available` is the longest of the four and an eight-wide
  // column pushed every row carrying it one character right of the rest.
  const outcomeWidth = 9
  const positionWidth = 6
  const verdictWidth = Math.max(...findings.map((f) => f.verdict.length))
  const kindWidth = Math.max(...findings.map((f) => KIND_LABEL[f.kind].length))
  // Line up the continuation lines under the label column: two leading spaces,
  // then every column plus the single space that follows each of them.
  const indent = ' '.repeat(outcomeWidth + verdictWidth + kindWidth + positionWidth + 4)

  for (const finding of findings) {
    const outcome = outcomeOf(finding)
    // A byte offset into a zip is the same number for every part in it, so the
    // formats built on one say which part instead. `-` stays for the findings
    // that describe the whole document and have no position to give.
    const position =
      finding.scope === 'document' || finding.length === 0 ? '-' : String(finding.offset)

    out.push(
      `  ${pad(colourOutcome(outcome), outcomeWidth + (tty ? 9 : 0))} ` +
        `${pad(colourVerdict(finding.verdict), verdictWidth + (tty ? 9 : 0))} ` +
        `${pad(KIND_LABEL[finding.kind], kindWidth)} ${dim(pad(position, positionWidth))} ` +
        `${finding.where ? `${dim(finding.where)} ` : ''}${dim(finding.label)}`,
    )
    if (finding.evidence) out.push(`  ${indent}${dim('└')} ${finding.evidence}`)
    if (finding.preserved) out.push(`  ${indent}${dim(finding.preserved)}`)
    if (finding.noFix) out.push(`  ${indent}${dim(finding.noFix)}`)
  }
}

function summarise(findings: readonly Finding[], out: string[]): void {
  const counts: Record<Outcome, number> = { removed: 0, kept: 0, available: 0, reported: 0 }
  for (const finding of findings) counts[outcomeOf(finding)] += 1

  const parts = [
    counts.removed > 0 ? `${counts.removed} removed` : '',
    counts.kept > 0 ? `${counts.kept} kept as legitimate` : '',
    counts.available > 0 ? `${counts.available} available behind an option` : '',
    counts.reported > 0 ? `${counts.reported} reported only` : '',
  ].filter(Boolean)

  out.push('', dim(`  ${parts.length > 0 ? parts.join(', ') : 'nothing to do'}`))
}

// ------------------------------------------------------------------ input

interface Source {
  name: string
  bytes: Uint8Array
}

async function readSource(target: string): Promise<Source> {
  if (target === '-') {
    const chunks: Uint8Array[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array)
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return { name: 'stdin', bytes }
  }

  return { name: target, bytes: new Uint8Array(await readFile(target)) }
}

/**
 * Replace a file's contents without ever leaving it half written.
 *
 * `writeFile` opens with `'w'`, which truncates to zero before a single byte
 * goes in. `--in-place` is the only destructive thing this tool does, and it
 * did it that way: a full disk, a SIGINT or a lost battery partway through a
 * forty-megabyte PDF left the user's only copy empty or cut in half, with the
 * original already gone.
 *
 * So it writes a sibling and renames over the target, which is atomic on every
 * filesystem this runs on: the file is either the old one or the new one and
 * never neither. `realpath` first, so a symlink is followed rather than
 * replaced — the old behaviour, and the one that surprises nobody. The mode is
 * copied across, because a rename brings the temporary file's permissions with
 * it and a 0600 replacement for a 0644 document is a change nobody asked for.
 */
async function writeInPlace(target: string, bytes: Uint8Array | string): Promise<void> {
  const path = await realpath(target)
  const temporary = `${path}.unmark-${process.pid}`
  try {
    await writeFile(temporary, bytes)
    await chmod(temporary, (await stat(path)).mode)
    await rename(temporary, path)
  } catch (cause) {
    await rm(temporary, { force: true })
    throw cause
  }
}

// ------------------------------------------------------------------ commands

interface Options {
  json: boolean
  inPlace: boolean
  paranoid: boolean
  confusables: boolean
  typography: boolean
  humanise: boolean
  printPrompt: boolean
  force: boolean
  model?: string
  attempts?: number
  against?: string
}

const textOptions = (options: Options) => ({
  ...(options.force ? { force: true } : {}),
  ...(options.paranoid ? { paranoid: true } : {}),
  ...(options.confusables ? { confusables: true } : {}),
  ...(options.typography ? { typography: true } : {}),
  ...(options.humanise ? { humanise: true } : {}),
})

async function commandInspect(target: string, options: Options): Promise<number> {
  const source = await readSource(target)
  const report = await inspectContainer(source.bytes, source.name, textOptions(options))

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ file: source.name, ...report }, undefined, 2)}\n`)
  } else {
    const out = [`${bold(source.name)} ${dim(`· ${report.format}`)}`, '']
    renderFindings(report.findings, out)
    summarise(report.findings, out)
    process.stdout.write(`${out.join('\n')}\n`)
  }

  // Exit 1 when something confirmed is present, so this composes in a script.
  return report.findings.some((f) => f.verdict === 'confirmed') ? 1 : 0
}

async function commandClean(target: string, options: Options): Promise<number> {
  // Checked before reading, not after: readSource('-') blocks on stdin that is
  // never going to arrive, so validating afterwards means hanging instead of
  // reporting the mistake.
  if (options.inPlace && target === '-') {
    process.stderr.write('unmark: --in-place needs a file, not stdin\n')
    return 2
  }

  const source = await readSource(target)
  const result = await cleanContainer(source.bytes, source.name, textOptions(options))

  if (options.inPlace) {
    await writeInPlace(target, result.output)
    if (options.json) {
      // `--json` promises machine-readable output. Combined with `--in-place`
      // it used to emit nothing at all on either stream, so
      // `unmark clean f.docx --in-place --json | jq '.findings|length'` handed
      // jq an empty input while unmark exited 0 — and there was no way at all
      // to learn what an in-place clean had stripped.
      process.stdout.write(
        `${JSON.stringify(
          {
            file: source.name,
            format: result.format,
            writtenInPlace: true,
            findings: result.findings,
            preserved: result.preserved,
          },
          undefined,
          2,
        )}\n`,
      )
      return 0
    }

    const out = [`${bold(source.name)} ${dim(`· ${result.format} · written in place`)}`, '']
    renderFindings([...result.findings, ...result.preserved], out)
    summarise([...result.findings, ...result.preserved], out)
    process.stderr.write(`${out.join('\n')}\n`)
    return 0
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: source.name,
          format: result.format,
          findings: result.findings,
          preserved: result.preserved,
          output: result.textual ? decodeUtf8(result.output) : undefined,
        },
        undefined,
        2,
      )}\n`,
    )
    return 0
  }

  if (result.textual) {
    process.stdout.write(decodeUtf8(result.output))
    return 0
  }

  // Binary on stdout corrupts a terminal, so it is refused there rather than
  // announced and then done anyway — which is what this did: it printed the
  // warning and wrote the bytes on the next line, scrambling the terminal it
  // had just said it was protecting. Redirected, the bytes are the whole point,
  // so the same command into a file or a pipe is exactly as it was.
  // Asked here rather than through `tty`: that one is cached at import and also
  // folds in NO_COLOR, which answers "should this be coloured", not "is stdout
  // a terminal". They are the same value almost always and not the same
  // question, and this is the one place where being wrong writes a megabyte of
  // binary into somebody's shell.
  if (process.stdout.isTTY === true) {
    process.stderr.write(
      `unmark: ${result.format} is binary and stdout is a terminal — nothing was written.\n` +
        `        Use --in-place, or redirect: unmark clean ${target} > cleaned\n`,
    )
    return 2
  }
  process.stdout.write(result.output)
  return 0
}

async function commandDecode(target: string, options: Options): Promise<number> {
  const source = await readSource(target)
  const decodings = decodeStego(decodeUtf8(source.bytes))

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ file: source.name, decodings }, undefined, 2)}\n`)
    return decodings.length > 0 ? 0 : 1
  }

  if (decodings.length === 0) {
    process.stdout.write(`${bold(source.name)}\n${dim('  no hidden payload found')}\n`)
    return 1
  }

  const out = [bold(source.name), '']
  for (const decoding of decodings) {
    out.push(
      `  ${paint('33', decoding.payload)}`,
      `  ${dim(`${decoding.scheme} · offset ${decoding.offset} · ${decoding.detail}`)}`,
      '',
    )
  }
  process.stdout.write(`${out.join('\n')}\n`)
  return 0
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'build'])

/**
 * Every file under a tree, symlinks included, one unreadable directory at a
 * time rather than none at all.
 *
 * Two things this had wrong, and both of them ended an audit early and quietly.
 *
 * A `readdir` that throws — a directory the user cannot read, which is ordinary
 * in a home folder — threw out of the generator, past the per-file catch below,
 * into main's handler: exit 2, no partial results, nothing said about which
 * directory. Per-file failures were already handled; per-directory ones were
 * the same problem one level up.
 *
 * And `Dirent.isFile()` is false for a symlink, so a symlinked file or
 * directory was dropped with no note. In a repo where `docs/` is a link,
 * `unmark audit .` answered "nothing marked" and exit 0. `seen` is what keeps a
 * link that points back up the tree from walking forever.
 */
// A tree is walked in order, so the report reads in order and a large tree
// starts producing rows before it has finished. Resolving every entry up front
// would reorder the output and hold the whole listing in memory to do it.
// oxlint-disable no-await-in-loop
async function* walk(dir: string, seen = new Set<string>()): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    process.stderr.write(`unmark: skipped ${dir} — ${why}\n`)
    return
  }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)

    let resolved = path
    if (entry.isSymbolicLink()) {
      try {
        resolved = await realpath(path)
      } catch {
        continue // A broken link points at nothing to audit.
      }
      if (seen.has(resolved)) continue
      seen.add(resolved)
    }

    let info
    try {
      info = await stat(resolved)
    } catch {
      continue
    }
    if (info.isDirectory()) yield* walk(path, seen)
    else if (info.isFile()) yield path
  }
}
// oxlint-enable no-await-in-loop

async function commandAudit(target: string, options: Options): Promise<number> {
  const isDirectory = (await stat(target)).isDirectory()
  const root = isDirectory ? target : '.'
  const marked: { file: string; format: ContainerFormat; findings: Finding[] }[] = []

  const paths = isDirectory ? walk(target) : [target]
  for await (const path of paths) {
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path))
    } catch {
      continue // unreadable is not a finding
    }
    // Skip files too large to be worth scanning as metadata containers.
    if (bytes.length > 64 * 1024 * 1024) continue

    const report = await inspectContainer(bytes, path, textOptions(options))
    const real = report.findings.filter((f) => f.verdict !== 'likely_false_positive')
    if (real.length > 0) {
      marked.push({ file: relative(root, path), format: report.format, findings: real })
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ root, files: marked }, undefined, 2)}\n`)
    return marked.length > 0 ? 1 : 0
  }

  if (marked.length === 0) {
    process.stdout.write(dim(`  nothing marked under ${root}\n`))
    return 0
  }

  const out: string[] = []
  for (const entry of marked) {
    out.push(`${bold(entry.file)} ${dim(`· ${entry.format}`)}`)
    renderFindings(entry.findings, out)
    out.push('')
  }
  out.push(dim(`  ${marked.length} file(s) carrying marks`))
  process.stdout.write(`${out.join('\n')}\n`)
  return 1
}

// ----------------------------------------------------------------- rewrite
//
// The deterministic half of the tool stops at word choice and at the shape of
// an argument. These three commands cross that line, and they are built so the
// model is bracketed rather than trusted: `brief` says what is wrong and what
// must survive, `verify` checks the answer against both, `rewrite` runs the
// loop between them.

async function commandBrief(target: string): Promise<number> {
  // Always JSON. This had a `if (json || printPrompt === false)` branch whose
  // two arms printed the same thing, which reads as though the flags do
  // something here. They do not: a brief is for a machine to act on.
  const source = await readSource(target)
  process.stdout.write(`${JSON.stringify(buildBrief(decodeUtf8(source.bytes)), undefined, 2)}\n`)
  return 0
}

function renderVerdict(verdict: RewriteVerdict, out: string[]): void {
  if (verdict.ok) {
    out.push(paint('32', '  passed'), dim('  every gate cleared: patterns, facts, protected spans'))
    return
  }
  out.push(paint('31', `  rejected — ${verdict.failures.length} problem(s)`), '')
  for (const failure of verdict.failures) {
    out.push(`  ${paint('33', failure.kind.padEnd(9))} ${failure.what}`)
    out.push(`  ${' '.repeat(9)} ${dim(failure.detail)}`)
  }
}

async function commandVerify(target: string, options: Options): Promise<number> {
  if (!options.against) {
    process.stderr.write('unmark: verify needs --against <the original file>\n')
    return 2
  }

  const original = decodeUtf8((await readSource(options.against)).bytes)
  const rewritten = decodeUtf8((await readSource(target)).bytes)
  const verdict = verifyRewrite(original, rewritten, buildBrief(original))

  if (options.json) {
    process.stdout.write(`${JSON.stringify(verdict, undefined, 2)}\n`)
    return verdict.ok ? 0 : 1
  }

  const out = [bold(`${target} against ${options.against}`), '']
  renderVerdict(verdict, out)
  process.stdout.write(`${out.join('\n')}\n`)
  return verdict.ok ? 0 : 1
}

async function commandRewrite(target: string, options: Options): Promise<number> {
  const source = await readSource(target)
  const text = decodeUtf8(source.bytes)
  const brief = buildBrief(text)

  const outcome = await runRewrite(text, brief, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.attempts ? { attempts: options.attempts } : {}),
    printPrompt: options.printPrompt,
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome, undefined, 2)}\n`)
    return outcome.kind === 'accepted' || outcome.kind === 'prompt' ? 0 : 1
  }

  if (outcome.kind === 'prompt') {
    process.stdout.write(`${outcome.text}\n`)
    return 0
  }

  for (const note of outcome.notes) process.stderr.write(`${dim(note)}\n`)

  if (outcome.kind === 'unavailable') return 1

  if (outcome.kind === 'accepted') {
    if (options.inPlace && target !== '-') await writeInPlace(target, outcome.text)
    else process.stdout.write(`${outcome.text}\n`)
    process.stderr.write(dim(`  accepted after ${outcome.attempts} attempt(s)\n`))
    return 0
  }

  // Rejected. The rewrite is still printed to stderr-adjacent stdout only when
  // asked for, because handing back a document that failed its own check as if
  // it had passed is the failure this whole loop exists to prevent.
  const out = [bold('the rewrite did not clear the gates'), '']
  if (outcome.verdict) renderVerdict(outcome.verdict, out)
  out.push(
    '',
    dim(`  ${outcome.attempts} attempt(s). The document is unchanged.`),
    dim('  A finding that keeps coming back is a sentence that needs a person.'),
  )
  process.stderr.write(`${out.join('\n')}\n`)
  return 1
}

// ------------------------------------------------------------------ entry

/**
 * Every flag this tool answers to.
 *
 * Kept as data and checked, because the alternative is what was here: any
 * argument beginning with a dash went into a set nobody validated, so a typo
 * was indistinguishable from silence. `unmark clean report.docx --in-plce`
 * exited 0 having written nothing, and a CI step reading `unmark clean x
 * --in-place || fail` passed while the file sat untouched. main.test.ts named
 * this hazard and patched the one case that had bitten; this closes the class.
 */
const KNOWN_FLAGS = new Set([
  '--json',
  '--in-place',
  '--paranoid',
  '--confusables',
  '--typography',
  '--humanise',
  '--plain',
  '--force',
  '--print-prompt',
  '--model',
  '--attempts',
  '--against',
  '--version',
  '-V',
  '--help',
  '-h',
])

export async function main(argv: readonly string[]): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('-') && arg !== '-'))

  // `--model=x` carries its value in the same token, so the name is what is
  // checked. A bare `--` is the conventional end-of-options marker and is not
  // a flag this tool has anything to say about.
  const unknown = [...flags]
    .map((flag) => flag.split('=')[0] as string)
    .filter((flag) => flag !== '--' && !KNOWN_FLAGS.has(flag))
  if (unknown.length > 0) {
    process.stderr.write(
      `unmark: unknown option${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}\n\n` +
        'Run `unmark --help` for the list. Nothing was read and nothing was written.\n',
    )
    return 2
  }

  /** `--model gpt-x` and `--model=gpt-x` both work; a missing value is undefined. */
  const value = (name: string): string | undefined => {
    const inline = argv.find((arg) => arg.startsWith(`${name}=`))
    if (inline) return inline.slice(name.length + 1)
    const at = argv.indexOf(name)
    const next = at === -1 ? undefined : argv[at + 1]
    return next && !next.startsWith('-') ? next : undefined
  }

  // A flag's value is not a positional argument — consumed by INDEX, not by
  // value. Consuming by value deleted the file argument whenever it happened to
  // equal a flag's value, so `unmark verify x.md --against x.md` lost its
  // target, fell back to reading stdin, and hung forever with no output.
  // Verifying a file against itself is the first thing anyone tries.
  const consumed = new Set<number>()
  for (const name of ['--model', '--attempts', '--against']) {
    const at = argv.indexOf(name)
    const next = at === -1 ? undefined : argv[at + 1]
    if (at !== -1 && next && !next.startsWith('-')) consumed.add(at + 1)
  }
  const positional = argv.filter(
    (arg, at) => (!arg.startsWith('-') || arg === '-') && !consumed.has(at),
  )

  if (flags.has('--version') || flags.has('-V')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (positional.length === 0 || flags.has('--help') || flags.has('-h')) {
    process.stdout.write(USAGE)
    return 0
  }

  // A flag whose value is not a number is a mistake, and it used to be an
  // expensive silent one: `Number('abc')` is NaN, `--attempts 0` is 0, both are
  // falsy, both were dropped by the spread below, and both came out as the
  // default of 3. Someone writing `--attempts 0` to mean "just check, spend
  // nothing" got three paid calls.
  const attempts = value('--attempts')
  if (attempts !== undefined && !/^[1-9]\d*$/.test(attempts)) {
    process.stderr.write(`unmark: --attempts needs a whole number of tries, not "${attempts}"\n`)
    return 2
  }

  const options: Options = {
    json: flags.has('--json'),
    inPlace: flags.has('--in-place'),
    paranoid: flags.has('--paranoid'),
    confusables: flags.has('--confusables'),
    printPrompt: flags.has('--print-prompt'),
    force: flags.has('--force'),
    ...(value('--model') ? { model: value('--model') as string } : {}),
    ...(attempts ? { attempts: Number(attempts) } : {}),
    ...(value('--against') ? { against: value('--against') as string } : {}),
    // --plain is one name for the pair, defined once in the core so the page's
    // button and this flag cannot drift into two different presets.
    typography: flags.has('--typography') || (flags.has('--plain') && PLAIN.typography === true),
    humanise: flags.has('--humanise') || (flags.has('--plain') && PLAIN.humanise === true),
  }

  const [command, target = '-'] = positional

  try {
    switch (command) {
      case 'inspect': {
        return await commandInspect(target, options)
      }
      case 'clean': {
        return await commandClean(target, options)
      }
      case 'decode': {
        return await commandDecode(target, options)
      }
      case 'brief': {
        return await commandBrief(target)
      }
      case 'verify': {
        return await commandVerify(target, options)
      }
      case 'rewrite': {
        return await commandRewrite(target, options)
      }
      case 'audit': {
        return await commandAudit(target === '-' ? '.' : target, options)
      }
      default: {
        process.stderr.write(`unmark: unknown command "${command}"\n\nRun \`unmark --help\`.\n`)
        return 2
      }
    }
  } catch (error) {
    process.stderr.write(`unmark: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
