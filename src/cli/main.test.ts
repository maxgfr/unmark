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

  it('folds a crowd of carriers into one line', async () => {
    // The payload above is 88 carriers. A report that prints all of them buries
    // the one line worth reading.
    await main(['inspect', await file('marked.txt', MARKED)])
    expect(stdout().split('\n').length).toBeLessThan(12)
    expect(stdout()).toMatch(/\d+ × zwj_family/)
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
