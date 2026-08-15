// Whole journeys, not units.
//
// Every other test file here checks one function against one input. These run
// the paths a person actually takes — paste a paragraph, clean a document,
// forward a file — through `cleanContainer` and `inspectContainer`, which is
// what both the page and the CLI call.
//
// The value is in the seams. Each of the bugs this round fixed lived between
// two modules that were each correct on their own: a fold that dropped the
// outcome field, a whitespace tidy that ran after a deletion, a style rule that
// did not know it was inside a code fence. A unit test on either side of those
// seams passes.

import { describe, expect, it } from 'vitest'
import { cleanContainer, inspectContainer } from './container/index.ts'
import { collapseRuns, outcomeOf, summariseOutcomes } from './report.ts'
import { encode, decodeUtf8 } from './container/types.ts'
import { encodeStego } from './text/stego.ts'
import { buildBrief, verifyRewrite } from './rewrite.ts'
import { avif, exifSegment, heic, jpeg, mp4, png, textChunkData, zip } from '../test/containers.ts'
import { readZip } from './container/zip.ts'

const text = (value: string) => encode(value)

describe('a paragraph pasted out of a chat window', () => {
  const marked = `Quarterly results are attached.${encodeStego('recipient-4417', 'zero-width')} Please keep this internal.`

  it('names the payload, strips the carriers, keeps the words', async () => {
    const report = await inspectContainer(text(marked), 'paste.txt')
    const payload = report.findings.find((f) => f.kind === 'stego_payload')
    expect(payload?.evidence).toBe('recipient-4417')

    const cleaned = await cleanContainer(text(marked), 'paste.txt')
    expect(decodeUtf8(cleaned.output)).toBe(
      'Quarterly results are attached. Please keep this internal.',
    )
  })

  it('is idempotent — cleaning a clean paragraph changes nothing', async () => {
    const once = await cleanContainer(text(marked), 'paste.txt')
    const twice = await cleanContainer(once.output, 'paste.txt')
    expect(decodeUtf8(twice.output)).toBe(decodeUtf8(once.output))
  })

  it('says a plain paragraph is plain rather than inventing something', async () => {
    const plain = 'The mechanic said the bottom bracket was shot, which explains the noise.'
    const report = await inspectContainer(text(plain), 'note.txt')
    expect(report.findings.filter((f) => f.verdict === 'confirmed')).toEqual([])
  })
})

describe('a draft someone wants to stop reading as generated', () => {
  const draft = [
    '---',
    'generator: gpt-4',
    '---',
    '',
    '# Strategic Negotiations And Global Partnerships',
    '',
    'Let us delve into this tapestry. In order to proceed, read the appendix. I hope this helps!',
    'Revenue rose 4.2% in March 2024. See https://example.com/q1?utm_source=chatgpt.com',
    '',
    '```js',
    'const utilize = 1 // in order to keep this',
    '```',
    '',
    '> They wrote: "let us dive into the numbers".',
  ].join('\n')

  it('strips the marks without being asked, and leaves the style alone', async () => {
    const result = await cleanContainer(text(draft), 'draft.md')
    const out = decodeUtf8(result.output)

    // Marks: the frontmatter generator key and the tracking parameter.
    expect(out).not.toContain('gpt-4')
    expect(out).toContain('https://example.com/q1')
    expect(out).not.toContain('utm_source')

    // Style: untouched, because nothing asked for it.
    expect(out).toContain('In order to proceed, read the appendix.')
    expect(out).toContain('I hope this helps!')
  })

  it('reports what the style passes would do before either is on', async () => {
    // The rule the whole tool follows: say what is there before touching it.
    const report = await inspectContainer(text(draft), 'draft.md')
    const waiting = report.findings.filter((f) => outcomeOf(f) === 'available')
    expect(waiting.length).toBeGreaterThan(0)
    expect(summariseOutcomes(report.findings)).toContain('available')
  })

  it('a folded crowd of style findings still reports as available, not removed', async () => {
    // The honesty bug: `collapseRuns` copied `preserved` and dropped
    // `available`, so a crowd of findings waiting on a toggle folded into one
    // row that read `removed` while the document still contained every one.
    const many = `${'A sentence with an em dash — right here. '.repeat(30)}`
    const report = await inspectContainer(text(many), 'many.md')
    for (const finding of collapseRuns(report.findings)) {
      if (finding.kind !== 'typography') continue
      expect(outcomeOf(finding)).toBe('available')
    }
  })

  it('with --plain, edits the prose and nothing else', async () => {
    const result = await cleanContainer(text(draft), 'draft.md', {
      typography: true,
      humanise: true,
    })
    const out = decodeUtf8(result.output)

    expect(out).toContain('# Strategic negotiations and global partnerships')
    // The filler phrase is shortened where it stands.
    expect(out).toContain('To proceed, read the appendix.')
    // Whole sentences of signposting and chat residue go, rather than being
    // trimmed: there is no shorter form of either that belongs in a document.
    expect(out).not.toContain('delve into this tapestry')
    expect(out).not.toContain('I hope this helps')

    // Sealed regions come through untouched.
    expect(out).toContain('const utilize = 1 // in order to keep this')
    expect(out).toContain('> They wrote: "let us dive into the numbers".')
  })

  it('hands a rewrite loop something it can check', async () => {
    const brief = buildBrief(draft)
    expect(brief.protected.some((span) => span.text.includes('const utilize = 1'))).toBe(true)
    expect(brief.facts.numbers).toContain('4.2%')

    // A rewrite that reads better and lost the figure is rejected.
    const lost = draft.replace('Revenue rose 4.2% in March 2024. ', 'Revenue rose. ')
    expect(verifyRewrite(draft, lost, brief).ok).toBe(false)
  })
})

describe('a document about to be forwarded', () => {
  const docx = (extra: { name: string; content: string | Uint8Array }[] = []) =>
    zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: '_rels/.rels', content: '<Relationships/>' },
      {
        name: 'docProps/core.xml',
        content:
          '<cp:coreProperties><dc:creator>Jane Q. Smith</dc:creator><cp:lastModifiedBy>Jane Q. Smith</cp:lastModifiedBy></cp:coreProperties>',
      },
      {
        name: 'word/document.xml',
        content:
          '<w:document><w:ins w:author="Jane Q. Smith" w:date="2024-03-01T10:00:00Z"><w:t>Confidential figures</w:t></w:ins><w:rsids><w:rsid w:val="00A1B2C3"/></w:rsids></w:document>',
      },
      ...extra,
    ])

  it('removes the author from the properties and from every tracked change', async () => {
    const result = await cleanContainer(docx(), 'report.docx')
    const entries = await readZip(result.output)
    const all = entries.map((entry) => decodeUtf8(entry.data)).join('\n')

    expect(all).not.toContain('Jane Q. Smith')
    expect(all).not.toContain('00A1B2C3')
    // And the content survives, which is the whole point.
    expect(all).toContain('Confidential figures')
  })

  it('cleans the EXIF out of a photograph pasted into it', async () => {
    // A leak every XML-reading pass walks straight past, so the file could be
    // reported clean while carrying the coordinates of where a picture in it
    // was taken.
    const photo = jpeg([{ marker: 0xe1, data: exifSegment('GPSLatitude=48.8566 Make=Canon') }])
    const result = await cleanContainer(docx([{ name: 'word/media/1.jpeg', content: photo }]))

    const entries = await readZip(result.output)
    const cleaned = entries.find((entry) => entry.name === 'word/media/1.jpeg')
    expect(decodeUtf8(cleaned!.data)).not.toContain('GPSLatitude')
  })

  it('still opens: every part that was there is still there', async () => {
    // Parts are emptied, never deleted. A relationship pointing at a part that
    // is gone is how you get "the file is corrupt and cannot be opened".
    const before = (await readZip(docx())).map((entry) => entry.name).sort()
    const after = (await readZip((await cleanContainer(docx())).output))
      .map((entry) => entry.name)
      .sort()
    expect(after).toEqual(before)
  })
})

describe('an image with a generator tag', () => {
  const marked = png([
    { type: 'tEXt', data: textChunkData('Software', 'Made by SomeGenerator 2.0') },
    { type: 'caBX', data: encode('jumb fake c2pa manifest') },
  ])

  it('names the C2PA manifest as confirmed and the generator tag as evidence', async () => {
    const report = await inspectContainer(marked, 'shot.png')
    const c2pa = report.findings.find((f) => f.kind === 'c2pa')
    expect(c2pa?.verdict).toBe('confirmed')
    expect(report.findings.some((f) => f.evidence?.includes('SomeGenerator 2.0'))).toBe(true)
  })

  it('leaves an image carrying nothing byte-identical', async () => {
    // The most important negative in the container half: a clean file must come
    // back exactly as it went in, or "nothing was found" is not trustworthy.
    const plain = png()
    const result = await cleanContainer(plain, 'plain.png')
    expect([...result.output]).toEqual([...plain])
  })
})

describe('exit-code shaped questions', () => {
  it('a marked file has something confirmed in it', async () => {
    const report = await inspectContainer(text(`x${encodeStego('id-9', 'tag')}`), 'marked.txt')
    expect(report.findings.some((f) => f.verdict === 'confirmed')).toBe(true)
  })

  it('an unmarked file has nothing confirmed in it', async () => {
    const report = await inspectContainer(text('An ordinary sentence.'), 'plain.txt')
    expect(report.findings.some((f) => f.verdict === 'confirmed')).toBe(false)
  })
})

describe('every format reaches its handler', () => {
  // The cheapest failure in a dispatch table is a format that falls through to
  // `unknown` and has its bytes handed back untouched, with no finding and no
  // error — which reads exactly like a clean file.
  const cases: [string, Uint8Array][] = [
    ['PNG', png()],
    ['JPEG', jpeg()],
    ['HEIC', heic()],
    ['AVIF', avif()],
    ['MP4', mp4()],
    [
      'PPTX',
      zip([
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: 'ppt/presentation.xml', content: '<p:presentation/>' },
      ]),
    ],
    [
      'XLSX',
      zip([
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: 'xl/workbook.xml', content: '<workbook/>' },
      ]),
    ],
    [
      'EPUB',
      zip([
        { name: 'mimetype', content: 'application/epub+zip' },
        { name: 'META-INF/container.xml', content: '<container/>' },
        { name: 'OEBPS/content.opf', content: '<package><metadata/></package>' },
      ]),
    ],
  ]

  it.each(cases)('recognises %s from its bytes, not its name', async (format, bytes) => {
    // Deliberately given the wrong extension: sniffing has to win.
    const result = await cleanContainer(bytes, 'file.wrong')
    expect(result.format).toBe(format)
  })

  it('hands back an unrecognised binary file exactly as it arrived', async () => {
    // The text path decodes UTF-8, edits a string and encodes it back. That is
    // lossless for text and destructive for anything else: every invalid byte
    // returns as U+FFFD, three bytes wide. An unrecognised format used to fall
    // straight into it, so `clean --in-place` corrupted the file and reported
    // zero findings — damage done while saying nothing was found.
    const nonsense = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x41, 0x42, 0x9c, 0xed, 0xa0, 0x80])
    const result = await cleanContainer(nonsense, 'mystery.bin')
    expect(result.format).toBe('unknown')
    expect([...result.output]).toEqual([...nonsense])
  })

  it('still treats a plain UTF-8 file as text', async () => {
    // The false-positive row. A guard that called everything binary would make
    // the whole text half unreachable, and every paste would come back
    // untouched with nothing found.
    const result = await cleanContainer(
      encode('Une réunion à Paris — le 3 mai. 日本語も。'),
      'note.txt',
    )
    expect(result.format).toBe('Text')
  })
})
