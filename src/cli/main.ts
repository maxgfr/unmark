// The terminal delivery of src/core, as a pure function of its arguments.
//
// Bundled by vite.skill.config.ts into one dependency-free file that ships as
// skills/unmark/scripts/unmark.mjs, so `npx skills add maxgfr/unmark` installs
// something that runs immediately. This file is the only place in the project
// allowed to import `node:` — the core underneath it stays environment-free,
// which is what lets the page and the terminal share one implementation.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { VERSION } from '../core/index.ts'
import { cleanContainer, inspectContainer, type ContainerFormat } from '../core/container/index.ts'
import { decodeStego } from '../core/text/stego.ts'
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

OPTIONS
  --json              machine-readable output
  --in-place          write the cleaned result back to the file (clean only)
  --paranoid          also strip emoji glue and script joiners; CORRUPTS real text
  --confusables       map Cyrillic/Greek lookalikes back to Latin
  --typography        flatten em dashes, curly quotes and ellipses to ASCII
  --humanise          remove filler, chat pleasantries and signposting
  --version, -V       print the version
  --help, -h          print this

FORMATS
  Text, Markdown, HTML, SVG, PNG, JPEG, WebP, GIF, PDF, DOCX, ODT

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

  const outcomeWidth = 8
  const positionWidth = 6
  const verdictWidth = Math.max(...findings.map((f) => f.verdict.length))
  const kindWidth = Math.max(...findings.map((f) => KIND_LABEL[f.kind].length))
  // Line up the continuation lines under the label column: two leading spaces,
  // then every column plus the single space that follows each of them.
  const indent = ' '.repeat(outcomeWidth + verdictWidth + kindWidth + positionWidth + 4)

  for (const finding of findings) {
    const outcome = outcomeOf(finding)
    const position = finding.length > 0 ? String(finding.offset) : '-'

    out.push(
      `  ${pad(colourOutcome(outcome), outcomeWidth + (tty ? 9 : 0))} ` +
        `${pad(colourVerdict(finding.verdict), verdictWidth + (tty ? 9 : 0))} ` +
        `${pad(KIND_LABEL[finding.kind], kindWidth)} ${dim(pad(position, positionWidth))} ${dim(finding.label)}`,
    )
    if (finding.evidence) out.push(`  ${indent}${dim('└')} ${finding.evidence}`)
    if (finding.preserved) out.push(`  ${indent}${dim(finding.preserved)}`)
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

// ------------------------------------------------------------------ commands

interface Options {
  json: boolean
  inPlace: boolean
  paranoid: boolean
  confusables: boolean
  typography: boolean
  humanise: boolean
}

const textOptions = (options: Options) => ({
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
    await writeFile(target, result.output)
    if (!options.json) {
      const out = [`${bold(source.name)} ${dim(`· ${result.format} · written in place`)}`, '']
      renderFindings([...result.findings, ...result.preserved], out)
      summarise([...result.findings, ...result.preserved], out)
      process.stderr.write(`${out.join('\n')}\n`)
    }
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
  } else {
    // Binary on stdout would corrupt a terminal. Say what to do instead.
    process.stderr.write(
      `unmark: ${result.format} is binary — use --in-place, or redirect stdout to a file\n`,
    )
    process.stdout.write(result.output)
  }
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

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

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

// ------------------------------------------------------------------ entry

export async function main(argv: readonly string[]): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith('-') && arg !== '-'))
  const positional = argv.filter((arg) => !arg.startsWith('-') || arg === '-')

  if (flags.has('--version') || flags.has('-V')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (positional.length === 0 || flags.has('--help') || flags.has('-h')) {
    process.stdout.write(USAGE)
    return 0
  }

  const options: Options = {
    json: flags.has('--json'),
    inPlace: flags.has('--in-place'),
    paranoid: flags.has('--paranoid'),
    confusables: flags.has('--confusables'),
    typography: flags.has('--typography'),
    humanise: flags.has('--humanise'),
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
