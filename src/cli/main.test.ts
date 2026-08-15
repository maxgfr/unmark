import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { main } from './main.ts'
import { png, textChunkData } from '../test/containers.ts'
import { encodeStego } from '../core/text/stego.ts'

let dir = ''
let out: string[] = []
let err: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'unmark-cli-'))
  out = []
  err = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

const stdout = () => out.join('')
const stderr = () => err.join('')

const file = async (name: string, content: string | Uint8Array) => {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

const MARKED = `Quarterly results.${encodeStego('leaker-4417', 'zero-width')}`

describe('argument handling', () => {
  it('prints the version', async () => {
    expect(await main(['--version'])).toBe(0)
    expect(stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('prints usage with no arguments', async () => {
    expect(await main([])).toBe(0)
    expect(stdout()).toContain('USAGE')
  })

  it('rejects an unknown command without pretending to work', async () => {
    expect(await main(['sanitise', 'x.txt'])).toBe(2)
    expect(stderr()).toContain('unknown command')
  })

  it('reports a missing file rather than throwing', async () => {
    expect(await main(['inspect', join(dir, 'nope.txt')])).toBe(2)
    expect(stderr()).toContain('unmark:')
  })
})

describe('inspect', () => {
  it('exits 1 when something confirmed is present, so scripts can branch on it', async () => {
    expect(await main(['inspect', await file('marked.txt', MARKED)])).toBe(1)
  })

  it('exits 0 on a clean file', async () => {
    expect(await main(['inspect', await file('clean.txt', 'Nothing here.\n')])).toBe(0)
    expect(stdout()).toContain('nothing found')
  })

  it('changes nothing on disk', async () => {
    const path = await file('marked.txt', MARKED)
    await main(['inspect', path])
    expect(await readFile(path, 'utf8')).toBe(MARKED)
  })

  it('folds a crowd of carriers into a line per codepoint', async () => {
    // The payload above is 88 carriers. A report that prints all of them buries
    // the one line worth reading.
    //
    // A line per codepoint rather than one for the lot: the fold keys on the
    // label, so a binary alphabet comes back as its two symbols. That is the
    // scheme rather than a detail — "88 zero-width characters" does not say
    // whether they are one symbol or four.
    await main(['inspect', await file('marked.txt', MARKED)])
    expect(stdout().split('\n').length).toBeLessThan(14)
    expect(stdout()).toMatch(/\d+ × zero-width character/)
  })

  it('emits parseable JSON', async () => {
    await main(['inspect', await file('marked.txt', MARKED), '--json'])
    const report = JSON.parse(stdout())
    expect(report.format).toBe('Text')
    expect(report.findings.length).toBeGreaterThan(0)
  })
})

describe('decode', () => {
  it('recovers the payload rather than only reporting that one exists', async () => {
    expect(await main(['decode', await file('marked.txt', MARKED)])).toBe(0)
    expect(stdout()).toContain('leaker-4417')
  })

  it('exits 1 when there is nothing hidden', async () => {
    expect(await main(['decode', await file('clean.txt', 'Nothing.')])).toBe(1)
  })
})

describe('clean', () => {
  it('writes the stripped text to stdout and leaves the file alone', async () => {
    const path = await file('marked.txt', MARKED)
    expect(await main(['clean', path])).toBe(0)
    expect(stdout()).toBe('Quarterly results.')
    expect(await readFile(path, 'utf8')).toBe(MARKED)
  })

  it('rewrites the file with --in-place', async () => {
    const path = await file('marked.txt', MARKED)
    expect(await main(['clean', path, '--in-place'])).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('Quarterly results.')
  })

  it('refuses --in-place on stdin instead of guessing what to write', async () => {
    expect(await main(['clean', '-', '--in-place'])).toBe(2)
    expect(stderr()).toContain('needs a file')
  })

  it('strips a PNG in place and leaves it re-inspectable as clean', async () => {
    const marked = png([
      { type: 'tEXt', data: textChunkData('Software', 'SomeGenerator 3.1') },
      { type: 'caBX', data: 'signed manifest' },
    ])
    const path = await file('marked.png', marked)

    await main(['clean', path, '--in-place'])
    const after = new Uint8Array(await readFile(path))
    expect(after.length).toBeLessThan(marked.length)

    out = []
    expect(await main(['inspect', path])).toBe(0)
    expect(stdout()).toContain('nothing found')
  })

  it('keeps a load-bearing carrier that a naive strip would delete', async () => {
    const family = `${String.fromCodePoint(0x1f468)}${String.fromCodePoint(0x200d)}${String.fromCodePoint(0x1f469)}`
    const path = await file('emoji.txt', family)
    await main(['clean', path, '--in-place'])
    expect(await readFile(path, 'utf8')).toBe(family)
  })

  it('strips it anyway under --paranoid', async () => {
    const family = `${String.fromCodePoint(0x1f468)}${String.fromCodePoint(0x200d)}${String.fromCodePoint(0x1f469)}`
    const path = await file('emoji.txt', family)
    await main(['clean', path, '--in-place', '--paranoid'])
    expect(await readFile(path, 'utf8')).not.toBe(family)
  })
})

describe('audit', () => {
  it('walks a tree and lists only the files carrying marks', async () => {
    await file('marked.txt', MARKED)
    await file('clean.txt', 'Nothing here.')
    await file('page.html', '<html><meta name="generator" content="X"></html>')

    expect(await main(['audit', dir])).toBe(1)
    expect(stdout()).toContain('marked.txt')
    expect(stdout()).toContain('page.html')
    expect(stdout()).not.toContain('clean.txt')
  })

  it('exits 0 when a tree is clean', async () => {
    await file('a.txt', 'Nothing.')
    expect(await main(['audit', dir])).toBe(0)
  })
})

describe('the rewrite loop', () => {
  const SLOP = [
    '# Strategic Negotiations And Global Partnerships',
    '',
    'In order to understand the landscape, let us delve into this tapestry.',
    'Revenue rose 4.2% in March 2024.',
    '',
    '```js',
    'const utilize = 1 // in order to keep this',
    '```',
    '',
    'I hope this helps!',
  ].join('\n')

  it('briefs what must be fixed and what must survive', async () => {
    await file('slop.md', SLOP)
    expect(await main(['brief', join(dir, 'slop.md')])).toBe(0)

    const brief = JSON.parse(stdout()) as {
      facts: { numbers: string[]; names: string[] }
      protected: { why: string; text: string }[]
    }
    expect(brief.facts.numbers).toContain('4.2%')
    expect(brief.protected.some((span) => span.text.includes('const utilize = 1'))).toBe(true)
    // The heading's words are not names, or the sentence-case fix would be
    // rejected as having lost them.
    expect(brief.facts.names).not.toContain('Partnerships')
  })

  it('prints the prompt and contacts nothing', async () => {
    await file('slop.md', SLOP)
    expect(await main(['rewrite', join(dir, 'slop.md'), '--print-prompt'])).toBe(0)
    expect(stdout()).toContain('PROTECTED SPANS')
    expect(stdout()).toContain('const utilize = 1')
  })

  it('rejects a rewrite that lost a fact, reintroduced a pattern or edited code', async () => {
    await file('slop.md', SLOP)
    await file(
      'bad.md',
      '# Strategic negotiations\n\nLet us delve into this tapestry.\n\n```js\nconst utilize = 2\n```\n\nI hope this helps!',
    )

    expect(await main(['verify', join(dir, 'bad.md'), '--against', join(dir, 'slop.md')])).toBe(1)
    const report = stdout()
    expect(report).toContain('rejected')
    expect(report).toContain('4.2%')
    expect(report).toContain('protected')
  })

  it('refuses to verify without an original to compare against', async () => {
    await file('bad.md', 'anything')
    expect(await main(['verify', join(dir, 'bad.md')])).toBe(2)
    expect(stderr()).toContain('--against')
  })

  it('does not mistake a flag value for the file to read', async () => {
    // `--model x` used to leave `x` looking like a positional argument, so the
    // command would try to read a file named after the model.
    await file('slop.md', SLOP)
    expect(
      await main(['rewrite', join(dir, 'slop.md'), '--model', 'some/model', '--print-prompt']),
    ).toBe(0)
    expect(stdout()).toContain('DOCUMENT')
  })
})

describe('--plain', () => {
  it('is the same preset as the two flags together', async () => {
    const text = 'In order to proceed we utilize the report. I hope this helps!'
    await file('a.md', text)
    await main(['clean', join(dir, 'a.md'), '--plain'])
    const withPreset = stdout()

    out = []
    await main(['clean', join(dir, 'a.md'), '--typography', '--humanise'])
    expect(stdout()).toBe(withPreset)
    expect(withPreset).toContain('To proceed we use the report.')
  })
})

describe('argument parsing', () => {
  it('does not lose the target when it equals a flag value', async () => {
    // `verify x.md --against x.md` used to consume flag values by string, which
    // deleted the positional too. The target fell back to `-`, and the command
    // blocked on stdin that was never coming — a silent hang on the most
    // natural first thing anyone tries.
    await file('same.md', 'The report arrived. In order to proceed we utilize it.')
    const path = join(dir, 'same.md')

    const code = await main(['verify', path, '--against', path])
    expect(code).toBe(1)
    expect(stdout()).toContain('same.md against')
  })

  it('reads the file named after a --model, not the model', async () => {
    await file('draft.md', 'Some prose here.')
    expect(
      await main(['rewrite', join(dir, 'draft.md'), '--model', 'vendor/model', '--print-prompt']),
    ).toBe(0)
    expect(stdout()).toContain('Some prose here.')
  })

  it('accepts --force, which the documentation promises', async () => {
    // The flag was documented in the skill's format reference and parsed
    // nowhere, and unknown flags are silently ignored — so following the docs
    // produced the refusal anyway with no signal that the flag did nothing.
    await file('plain.txt', 'Nothing hidden.')
    expect(await main(['clean', join(dir, 'plain.txt'), '--force'])).toBe(0)
  })
})
