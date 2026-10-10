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
import { analyzeStyle, PLAIN, stylometryFindings } from '../core/text/index.ts'
import {
  ABSENCE_NOTE,
  coverageSentence,
  describeLocation,
  detectAuthorship,
  documentSentence,
  withoutFolio,
  fileMarksFrom,
  foundNothing,
  renderMarkdown,
  UNREACHABLE_NOTE,
  toJSON,
  verdictSentence,
  type AuthorshipReport,
  type AuthorshipVerdict,
  type DocumentSource,
  type Layout,
  type PageText,
} from '../core/text/authorship/index.ts'
import { buildBrief, verifyRewrite, type RewriteVerdict } from '../core/rewrite.ts'
import { askModel, runRewrite } from './rewrite.ts'
import {
  applyRewrites,
  HABIT_LABEL,
  renderSweep,
  sweep,
  sweepPrompt,
  type SweepRow,
} from '../core/text/authorship/sweep.ts'
import {
  collapseRuns,
  KIND_LABEL,
  outcomeOf,
  type Finding,
  type Outcome,
  type ReportMode,
  type Verdict,
} from '../core/report.ts'
import { decodeUtf8, type MediaEntry } from '../core/container/types.ts'
import { printedPages, readProse } from '../core/container/prose.ts'

const USAGE = `unmark ${VERSION} — find, decode and strip watermarks and provenance marks

USAGE
  unmark inspect <file|->        report every mark found, change nothing
  unmark clean   <file|->        strip what is removable, print the result
  unmark decode  <file|->        recover payloads hidden in invisible characters
  unmark audit   <dir>           walk a tree and report every marked file
  unmark detect  <file|->        assess whether the prose reads as AI-written,
                                 with every passage located. Not proof.
  unmark sweep   <file|->        every sentence carrying a habit, however isolated,
                                 with a checked rewrite: current text → replace with

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
  machine. The browser optionally rewrites locally with WebLLM; its policy
  pins connect-src to 'self', and that is not negotiable for a feature.

DETECT (French and English; an assessment of writing habits, never proof)
  --format <f>        text (default), md, or json
  --lang <l>          fr, en, or auto (default: per paragraph)
  --min-score <n>     list only passages scoring at least n, 0 to 1 (default
                      0.35). Filters the list; never changes the verdict.
  --pages <file.pdf>  the printed PDF of the same document: every passage is
                      placed on its page ("p. 29, §2.6.3")
  --source <file>     the .docx or PDF a text file was extracted from: its marks
                      (a C2PA manifest on an image…) are listed as file marks
  --top <n>           also list the n sentences scoring highest, below the bands
  --register academic also read the formulas of academic writing ("to our
                      knowledge", "c'est dans ce contexte que"), tier 3; alone,
                      they are listed as not evidence

  detect reads .txt, .md, .html, and the body of a .docx (tables, captions,
  contents and reference list left out) or a PDF, page by page. A document
  that changes language is assessed block by block.

  Exit codes: 0 few signals or uncertain · 1 likely AI-written ·
  2 usage error or unreadable input · 3 not enough text (under 150 words)

SWEEP (the judge's worksheet: every habit, located, quoted, with a fix)
  --pages, --register, --lang, --format text|md|json   as for detect
                      (the register defaults to academic when the text cites)
  --print-prompt      print the prompt for the rewrites an agent writes, as
                      [{"id": …, "rewrite": …}]; no network
  --apply <file.json> check those rewrites and put the ones that pass in the table
  --rewrite           ask the local model (Ollama on 127.0.0.1) for the rewrites;
                      with --model, a remote provider — the sentences LEAVE YOUR MACHINE
  Every rewrite must keep the sentence's numbers and reference calls; one that
  does not is marked rejected and never proposed. Every quote is checked against
  the source file (and the --pages PDF).

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
  removable: '33',
  kept: '32',
  available: '36',
  reported: '2',
}

const colourOutcome = (outcome: Outcome) => paint(OUTCOME_COLOR[outcome], outcome)

const pad = (text: string, width: number) => text.padEnd(width)

function renderFindings(all: readonly Finding[], out: string[], mode: ReportMode): void {
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
    const outcome = outcomeOf(finding, mode)
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
    for (const action of finding.c2pa?.manifests.at(-1)?.actions ?? []) {
      if (action.description)
        out.push(`  ${indent}${dim(`${action.action}: “${action.description}”`)}`)
    }
    if (finding.placement) out.push(`  ${indent}${dim(placementOf(finding.placement))}`)
    if (finding.preserved) out.push(`  ${indent}${dim(finding.preserved)}`)
    if (finding.noFix) out.push(`  ${indent}${dim(finding.noFix)}`)
  }
}

const placementOf = (placement: { paragraph?: number; caption?: string }): string =>
  [
    placement.paragraph === undefined ? 'not in the body' : `paragraph ${placement.paragraph}`,
    placement.caption,
  ]
    .filter(Boolean)
    .join(' — ')

/**
 * Every picture in a Word document with where it sits, marked or not.
 *
 * A finding on `word/media/image24.png` is half an answer: the author knows
 * their figures by number, not by part name. Listing the clean pictures too is
 * what lets "two of these carry a manifest" be read as "Figures 4 and 7 do".
 */
function renderMedia(media: readonly MediaEntry[], out: string[]): void {
  if (media.length === 0) return
  out.push('', `  ${bold('Pictures in the document')}`)
  const width = Math.max(...media.map((entry) => entry.part.length))
  const where = Math.min(60, Math.max(...media.map((entry) => placementOf(entry).length)))
  for (const entry of media) {
    const marks =
      entry.c2pa ??
      (entry.marks > 0 ? `${entry.marks} mark${entry.marks === 1 ? '' : 's'}` : 'no marks')
    out.push(
      `  ${pad(entry.part, width)} ${dim(pad(placementOf(entry), where))}${
        entry.marks > 0 ? `  ${paint('33', marks)}` : `  ${dim(marks)}`
      }`,
    )
  }
}

function summarise(findings: readonly Finding[], out: string[], mode: ReportMode): void {
  const counts: Record<Outcome, number> = {
    removed: 0,
    removable: 0,
    kept: 0,
    available: 0,
    reported: 0,
  }
  for (const finding of findings) counts[outcomeOf(finding, mode)] += 1

  const parts = [
    counts.removed > 0 ? `${counts.removed} removed` : '',
    counts.removable > 0
      ? `${counts.removable} removable — nothing was changed, \`unmark clean\` removes them`
      : '',
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
  format?: 'text' | 'md' | 'json'
  lang?: 'fr' | 'en' | 'auto'
  minScore?: number
  pages?: string
  source?: string
  top?: number
  register?: 'general' | 'academic'
  apply?: string
  rewrite?: boolean
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
  const { textual, ...report } = await inspectContainer(
    source.bytes,
    source.name,
    textOptions(options),
  )

  // Style is read here and not inside `inspectContainer`, because `audit` calls
  // that too and exits 1 on any finding it returns. Every draft in a tree would
  // then count as a marked file. Style is a reading, never a mark, and it is
  // never `confirmed`, so the exit code below cannot move because of it.
  const text = textual ? decodeUtf8(source.bytes) : undefined
  const style = text === undefined ? undefined : analyzeStyle(text)
  const stylometry = text === undefined ? [] : stylometryFindings(text)

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: source.name,
          ...report,
          ...(style ? { stylometryFindings: stylometry, style } : {}),
        },
        undefined,
        2,
      )}\n`,
    )
  } else {
    const out = [`${bold(source.name)} ${dim(`· ${report.format}`)}`, '']
    renderFindings([...report.findings, ...stylometry], out, 'inspect')
    renderMedia(report.media ?? [], out)
    if (report.coverage && report.coverage.length > 0) {
      out.push('', ...report.coverage.map((line) => dim(`  scanned: ${line}`)))
    }
    summarise([...report.findings, ...stylometry], out, 'inspect')
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
    renderFindings([...result.findings, ...result.preserved], out, 'clean')
    summarise([...result.findings, ...result.preserved], out, 'clean')
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
    renderFindings(entry.findings, out, 'inspect')
    out.push('')
  }
  out.push(dim(`  ${marked.length} file(s) carrying marks`))
  process.stdout.write(`${out.join('\n')}\n`)
  return 1
}

// ----------------------------------------------------------------- detect
//
// The one command whose answer is an assessment rather than a finding. It
// says how the prose reads, locates why, and says on the same screen that
// none of it is proof. Amber stays reserved for technical marks: a verdict
// about style is never painted in the colour that means "certain".

const EXIT_FOR: Record<AuthorshipVerdict, number> = {
  likely_human: 0,
  uncertain: 0,
  likely_ai: 1,
  insufficient_evidence: 3,
}

const LANGUAGE_NAME = { fr: 'French', en: 'English', und: 'language undetermined' } as const

/** "p. 29, §2.6.3" when the document's layout is known, "line 412" otherwise. */
const placeOf = (item: {
  line: number
  location?: AuthorshipReport['spans'][number]['location']
}) => describeLocation(item.location) ?? `line ${item.line}`

const BLOCK_LANGUAGE = { fr: 'French', en: 'English', other: 'other language' } as const

function renderAuthorship(
  name: string,
  report: AuthorshipReport,
  minScore: number,
  top?: number,
): string {
  const out = [
    `${bold(name)} ${dim(`· ${LANGUAGE_NAME[report.language.document]} · ${report.words} words`)}`,
    '',
    `  ${bold(verdictSentence(report))}${
      report.score === null
        ? ''
        : dim(`   score ${report.score.toFixed(2)} · confidence ${report.confidence}`)
    }`,
    `  ${dim(report.disclaimer)}`,
    ...(report.verdict === 'likely_human' || foundNothing(report)
      ? [`  ${dim(ABSENCE_NOTE)}`]
      : []),
    ...(report.thresholds.humanReachable ? [] : [`  ${dim(UNREACHABLE_NOTE)}`]),
    `  ${dim(
      `calibration ${report.calibration.id}${report.calibration.calibrated ? '' : ' (not yet calibrated: provisional thresholds)'}`,
    )}`,
    ...(report.document ? [`  ${dim(`read from ${documentSentence(report.document)}`)}`] : []),
    '',
  ]

  if (report.blocks.length > 1) {
    out.push(`  ${bold('Blocks')} ${dim('consecutive paragraphs in one language, each assessed')}`)
    for (const block of report.blocks) {
      const from = describeLocation(block.location) ?? `line ${block.line}`
      const to = describeLocation(block.endLocation) ?? `line ${block.endLine}`
      out.push(
        `  ${pad(BLOCK_LANGUAGE[block.lang], 15)} ${pad(`${block.words} words`, 12)} ${pad(verdictSentence(block), 44)} ${dim(
          `${block.score === null ? '' : `score ${block.score.toFixed(2)} · `}${from} → ${to}`,
        )}`,
      )
    }
    out.push('')
  }

  const listed = report.spans.filter((span) => span.score >= minScore)
  const width = Math.max(10, ...listed.map((span) => placeOf(span).length))
  if (listed.length > 0) {
    out.push(
      `  ${bold(top === undefined ? 'Passages' : `Top ${top}`)} ${dim(top === undefined ? `scoring ${minScore.toFixed(2)} or more` : 'the sentences scoring highest, whatever their band')}`,
    )
    for (const span of listed) {
      const own = report.findings.filter((f) => f.start >= span.start && f.start < span.end)
      out.push(
        `  ${pad(placeOf(span), width)} ${span.score.toFixed(2)}  ${span.excerpt}`,
        ...own
          .slice(0, 3)
          .map((f) => `  ${' '.repeat(width + 6)}${dim(`${f.patternId} — ${f.reason}`)}`),
      )
      const fix = own[0]?.fixHint
      if (fix) out.push(`  ${' '.repeat(width + 6)}${dim(`fix: ${fix}`)}`)
    }
    out.push('')
  } else if (report.verdict !== 'insufficient_evidence') {
    out.push(dim(`  No passage scored ${minScore.toFixed(2)} or more.`), '')
  }

  const loose = report.findings.filter(
    (f) =>
      (f.category === 'residue' || f.category === 'formatting') &&
      !listed.some((span) => f.start >= span.start && f.start < span.end),
  )
  for (const finding of loose) {
    out.push(`  ${pad(placeOf(finding), width)} ${finding.patternId}  ${finding.excerpt}`)
    out.push(`  ${' '.repeat(width + 6)}${dim(finding.reason)}`)
  }
  if (loose.length > 0) out.push('')

  if (report.technicalMarks.length > 0) {
    out.push(`  ${bold('Technical marks')} ${dim('in the text')}`)
    for (const mark of report.technicalMarks) {
      out.push(
        `  ${pad(placeOf(mark), width)} ${colourVerdict(mark.verdict)} ${KIND_LABEL[mark.kind]} ${dim(mark.label)}`,
      )
    }
    out.push('')
  }

  if (report.recaps.length > 0) {
    out.push(
      `  ${bold('Repeated formulas')} ${dim('the same phrase copied into several sections')}`,
    )
    for (const recap of report.recaps) {
      out.push(
        `  « ${recap.phrase} » ${dim(`×${recap.occurrences.length}${recap.summary ? ' · one copy in a summary, which restates by design' : ''}`)}`,
        `    ${dim(recap.occurrences.map((o) => describeLocation(o.location) ?? `line ${o.line}`).join(' · '))}`,
      )
    }
    out.push('')
  }

  const unweighted = report.findings.filter(
    (f) => f.category === 'hedging' || f.category === 'phrasing',
  )
  if (unweighted.length > 0) {
    out.push(
      `  ${bold('Hedging and wordy phrasing')} ${dim('reported, not scored until a refit has measured them')}`,
    )
    for (const finding of unweighted.slice(0, 15)) {
      out.push(`  ${pad(placeOf(finding), width)} ${finding.patternId}  ${finding.excerpt}`)
    }
    if (unweighted.length > 15) out.push(dim(`  … ${unweighted.length - 15} more in --json`))
    out.push('')
  }

  if (report.fileMarks.length > 0) {
    out.push(
      `  ${bold('File marks')} ${dim('in the file the text came from — about the file, not the prose')}`,
    )
    for (const mark of report.fileMarks) {
      out.push(
        `  ${colourVerdict(mark.verdict)} ${KIND_LABEL[mark.kind]} ${dim(`${mark.where ? `${mark.where} · ` : ''}${mark.label}`)}`,
      )
      if (mark.placement) out.push(`    ${dim(placementOf(mark.placement))}`)
    }
    out.push('')
  }

  if (report.language.unsupported.length > 0) {
    out.push(
      `  ${bold('Not assessed')} ${dim(`${Math.round(report.language.unsupportedShare * 100)} % of the words read as a language with no catalogue`)}`,
    )
    for (const segment of report.language.unsupported.slice(0, 12)) {
      out.push(
        `  ${pad(placeOf(segment), width)} ${pad(segment.lang, 3)} ${dim(`${segment.words} words`)}  ${segment.excerpt}`,
      )
    }
    if (report.language.unsupported.length > 12)
      out.push(dim(`  … ${report.language.unsupported.length - 12} more in --json`))
    out.push('')
  }

  out.push(dim(`  ${coverageSentence(report.coverage)}`))
  out.push(
    dim(
      `  Not evidence: ${report.notEvidence.map((line) => line.replace(/\.$/, '').toLowerCase()).join('; ')}.`,
    ),
    dim('  --format md for a report to share · --json for scripts'),
  )
  return `${out.join('\n')}\n`
}

interface LoadedProse {
  source: Source
  prose: NonNullable<Awaited<ReturnType<typeof readProse>>>
  layout: Layout | undefined
  document: DocumentSource | undefined
  pages: PageText[] | undefined
}

/** The prose of `target`, with its layout and its --pages, or an exit code. */
async function loadProse(
  target: string,
  options: Options,
  command: string,
): Promise<LoadedProse | number> {
  const source = await readSource(target)
  const prose = await readProse(source.bytes, source.name)
  if (!prose) {
    process.stderr.write(
      `unmark: ${source.name} has no prose ${command} can read. It reads text (.txt, .md, .html), .docx and PDF.\n`,
    )
    return 2
  }

  let layout = prose.layout
  let document: DocumentSource | undefined = prose.source
  let pages: PageText[] | undefined
  if (options.pages) {
    pages = await printedPages(new Uint8Array(await readFile(options.pages)))
    if (!pages) {
      process.stderr.write(`unmark: --pages needs a PDF, and ${options.pages} is not one\n`)
      return 2
    }
    // A plain text file has no paragraphs of its own: its blank lines are.
    layout = { paragraphs: layout?.paragraphs ?? paragraphsOf(prose.text), pages }
    document = {
      ...(document ?? { container: prose.format, paragraphs: layout.paragraphs.length }),
      pagesFrom: options.pages,
    }
  }
  return { source, prose, layout, document, pages }
}

/**
 * The n sentences scoring highest, in document order.
 *
 * Ties — most often at 0.00 on a careful text — are broken by how many habits
 * the sentence carries, counted or not, so a sentence with two stacked hedges
 * comes before one with nothing at all.
 */
function topSpans(report: AuthorshipReport, n: number): AuthorshipReport['spans'] {
  const habits = (span: AuthorshipReport['spans'][number]) =>
    report.findings.filter((f) => f.start >= span.start && f.start < span.end).length
  return [...report.spans]
    .sort((a, b) => b.score - a.score || habits(b) - habits(a) || a.start - b.start)
    .slice(0, n)
    .sort((a, b) => a.start - b.start)
}

async function commandDetect(target: string, options: Options): Promise<number> {
  const loaded = await loadProse(target, options, 'detect')
  if (typeof loaded === 'number') return loaded
  const { source, prose, layout, document } = loaded

  // The container's own marks: the input's when it is a .docx or a PDF, or
  // those of the file named by --source when the input was extracted from one.
  const containerBytes = options.source
    ? new Uint8Array(await readFile(options.source))
    : prose.source
      ? source.bytes
      : undefined
  const fileMarks = containerBytes
    ? fileMarksFrom(
        (await inspectContainer(containerBytes, options.source ?? source.name)).findings,
      )
    : []

  const report = detectAuthorship(prose.text, {
    format: prose.format,
    lang: options.lang ?? 'auto',
    ...(layout ? { layout } : {}),
    ...(document ? { document } : {}),
    ...(options.register ? { register: options.register } : {}),
    ...(options.top === undefined ? {} : { allSpans: true }),
    fileMarks,
  })
  const minScore = options.top === undefined ? (options.minScore ?? 0.35) : 0
  const shown =
    options.top === undefined ? report : { ...report, spans: topSpans(report, options.top) }

  const format = options.json ? 'json' : (options.format ?? 'text')
  if (format === 'json') {
    const listed = { ...shown, spans: shown.spans.filter((span) => span.score >= minScore) }
    process.stdout.write(`${toJSON(listed)}\n`)
  } else if (format === 'md') {
    process.stdout.write(
      renderMarkdown(shown, {
        minScore,
        ...(options.top === undefined ? {} : { top: options.top }),
      }),
    )
  } else {
    process.stdout.write(renderAuthorship(source.name, shown, minScore, options.top))
  }
  return EXIT_FOR[report.verdict]
}

// ----------------------------------------------------------------- sweep
//
// The judge's worksheet. Not a verdict: the sentences that carry a habit,
// whoever wrote them, with a rewrite that kept every number and every call.

const CONFIDENCE_COLOUR = { high: '33', medium: '37', low: '2' } as const

function renderSweepText(name: string, rows: readonly SweepRow[]): string {
  const out = [
    `${bold(name)} ${dim(`· ${rows.length} sentences carry a habit · not proof of anything`)}`,
    '',
  ]
  let section: string | undefined
  for (const row of rows) {
    const here = row.section
    if (here !== section) {
      section = here
      if (here) out.push(`  ${bold(here)}`)
    }
    const place = describeLocation(row.location) ?? `line ${row.line}`
    out.push(
      `  ${pad(place, 16)} ${paint(CONFIDENCE_COLOUR[row.confidence], pad(row.confidence, 6))} ${row.habits.map((h) => HABIT_LABEL[h.type]).join(', ')}${row.registerExplained ? dim(' · the register explains it') : ''}`,
      `  ${' '.repeat(17)}« ${row.text} »${row.quote.checked.length > 0 && row.quote.found.length < row.quote.checked.length ? paint('31', ' — not found in the source') : ''}`,
    )
    if (row.rewrite?.verified)
      out.push(
        `  ${' '.repeat(17)}${paint('32', '→')} ${row.rewrite.text || dim('delete the sentence')}`,
      )
    else if (row.rewrite)
      out.push(
        `  ${' '.repeat(17)}${dim(`rewrite rejected: ${row.rewrite.failures?.[0] ?? 'failed the gate'}`)}`,
      )
  }
  out.push(
    '',
    dim(
      '  --format md for the table "current text → replace with" · --print-prompt / --apply or --rewrite for rewrites',
    ),
  )
  return `${out.join('\n')}\n`
}

async function commandSweep(target: string, options: Options): Promise<number> {
  const loaded = await loadProse(target, options, 'sweep')
  if (typeof loaded === 'number') return loaded
  const { source, prose, layout, document, pages } = loaded

  const sources: Record<string, { text: string; loose?: boolean }> = {
    [source.name]: { text: prose.raw ?? prose.text, loose: prose.source?.container === 'PDF' },
    ...(pages && options.pages
      ? {
          [options.pages]: { text: pages.map((p) => withoutFolio(p.text)).join('\n'), loose: true },
        }
      : {}),
  }
  const result = sweep(prose.text, {
    format: prose.format,
    lang: options.lang ?? 'auto',
    ...(layout ? { layout } : {}),
    ...(document ? { document } : {}),
    ...(options.register ? { register: options.register } : {}),
    sources,
  })
  let rows = result.rows

  if (options.printPrompt) {
    process.stdout.write(`${sweepPrompt(rows)}\n`)
    return 0
  }
  if (options.apply) {
    let parsed: unknown
    try {
      parsed = JSON.parse(decodeUtf8(new Uint8Array(await readFile(options.apply))))
    } catch {
      process.stderr.write(`unmark: ${options.apply} is not JSON: [{"id": …, "rewrite": …}]\n`)
      return 2
    }
    rows = applyRewrites(rows, rewritesFrom(parsed), 'agent')
  }
  if (options.rewrite) {
    try {
      const answer = await askModel(sweepPrompt(rows), {
        ...(options.model ? { model: options.model } : {}),
        onNote: (note) => process.stderr.write(`${dim(note)}\n`),
      })
      rows = applyRewrites(rows, rewritesFrom(jsonIn(answer)), 'model')
    } catch (error) {
      process.stderr.write(
        `unmark: no rewrites — ${error instanceof Error ? error.message : String(error)}. Use --print-prompt and --apply instead.\n`,
      )
    }
  }

  const final = { ...result, rows }
  const format = options.json ? 'json' : (options.format ?? 'text')
  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: source.name,
          rows,
          counts: result.counts,
          verdict: result.report.verdict,
          score: result.report.score,
          coverage: result.report.coverage,
          ...(result.report.document ? { document: result.report.document } : {}),
          disclaimer: result.report.disclaimer,
        },
        undefined,
        2,
      )}\n`,
    )
  } else if (format === 'md') {
    process.stdout.write(renderSweep(final, describeLocation))
  } else {
    process.stdout.write(renderSweepText(source.name, rows))
  }
  return 0
}

/** `[{id, rewrite}]`, from a parsed JSON value, ignoring anything else. */
function rewritesFrom(value: unknown): { id: string; rewrite: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) =>
    item &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    typeof item.rewrite === 'string'
      ? [{ id: item.id as string, rewrite: item.rewrite as string }]
      : [],
  )
}

/** The JSON array in a model's answer, fenced or not. */
function jsonIn(answer: string): unknown {
  const start = answer.indexOf('[')
  const end = answer.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    return JSON.parse(answer.slice(start, end + 1))
  } catch {
    return []
  }
}

/** Paragraphs of a plain text, separated by blank lines, numbered from 1. */
function paragraphsOf(text: string): { start: number; end: number; index: number }[] {
  const out: { start: number; end: number; index: number }[] = []
  for (const match of text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]*)*/gu)) {
    if (!match[0].trim()) continue
    out.push({ start: match.index, end: match.index + match[0].length, index: out.length + 1 })
  }
  return out
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
    onNote: (note) => process.stderr.write(`${dim(note)}\n`),
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome, undefined, 2)}\n`)
    return outcome.kind === 'accepted' || outcome.kind === 'prompt' ? 0 : 1
  }

  if (outcome.kind === 'prompt') {
    process.stdout.write(`${outcome.text}\n`)
    return 0
  }

  // Progress notes were emitted before requests, including on JSON output.

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
  '--format',
  '--lang',
  '--min-score',
  '--pages',
  '--source',
  '--top',
  '--register',
  '--apply',
  '--rewrite',
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
  for (const name of [
    '--model',
    '--attempts',
    '--against',
    '--format',
    '--lang',
    '--min-score',
    '--pages',
    '--source',
    '--top',
    '--register',
    '--apply',
  ]) {
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

  // detect's three values, checked the same way: a wrong one is named and
  // nothing is read, rather than quietly falling back to a default. A flag
  // with no value at all is the same mistake: `--format` alone used to print
  // text, which is the one format the caller had not asked for.
  for (const name of [
    '--format',
    '--lang',
    '--min-score',
    '--pages',
    '--source',
    '--top',
    '--register',
    '--apply',
  ]) {
    if (flags.has(name) && value(name) === undefined) {
      process.stderr.write(`unmark: ${name} needs a value\n`)
      return 2
    }
  }
  const format = value('--format')
  if (format !== undefined && !['text', 'md', 'json'].includes(format)) {
    process.stderr.write(`unmark: --format takes text, md or json, not "${format}"\n`)
    return 2
  }
  const lang = value('--lang')
  if (lang !== undefined && !['fr', 'en', 'auto'].includes(lang)) {
    process.stderr.write(`unmark: --lang takes fr, en or auto, not "${lang}"\n`)
    return 2
  }
  const minScore = value('--min-score')
  if (
    minScore !== undefined &&
    (!/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(minScore) || Number(minScore) > 1)
  ) {
    process.stderr.write(`unmark: --min-score takes a number from 0 to 1, not "${minScore}"\n`)
    return 2
  }

  const top = value('--top')
  if (top !== undefined && !/^[1-9]\d*$/.test(top)) {
    process.stderr.write(`unmark: --top needs a whole number of sentences, not "${top}"\n`)
    return 2
  }
  const register = value('--register')
  if (register !== undefined && !['general', 'academic'].includes(register)) {
    process.stderr.write(`unmark: --register takes general or academic, not "${register}"\n`)
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
    ...(format ? { format: format as 'text' | 'md' | 'json' } : {}),
    ...(lang ? { lang: lang as 'fr' | 'en' | 'auto' } : {}),
    ...(minScore === undefined ? {} : { minScore: Number(minScore) }),
    ...(value('--pages') ? { pages: value('--pages') as string } : {}),
    ...(value('--source') ? { source: value('--source') as string } : {}),
    ...(top ? { top: Number(top) } : {}),
    ...(register ? { register: register as 'general' | 'academic' } : {}),
    ...(value('--apply') ? { apply: value('--apply') as string } : {}),
    rewrite: flags.has('--rewrite'),
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
      case 'detect': {
        return await commandDetect(target, options)
      }
      case 'sweep': {
        return await commandSweep(target, options)
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
