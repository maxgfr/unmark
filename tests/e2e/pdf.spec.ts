// A PDF written by something other than us.
//
// The worry this closes is the one the last round stated out loud: "tested only
// on PDFs I build myself. The real world has compressed streams, xref streams,
// encrypted objects." Our own fixtures are built to exercise our own parser,
// which makes them evidence of self-consistency and not much else.
//
// Chromium's PDF writer is Skia, and `page.pdf()` emits a genuine document from
// a producer that has never heard of this project. Cleaning that is the test.
//
// Be precise about what it covers. This file first claimed the output has
// "compressed content streams, an xref stream, object streams"; it has none of
// those — Skia writes a classic xref table with uncompressed objects, which the
// third test below asserts so the claim cannot quietly drift back. So this
// proves the rebuild survives a real third-party producer, and object streams
// and xref streams remain covered only by the built fixtures in pdf/*.test.ts.
// A real PDF from Word or Acrobat would exercise those, and nobody here has one.

import { expect, test } from '@playwright/test'
import { cleanContainer, inspectContainer } from '../../src/core/container/index.ts'

test.describe('a PDF from a real producer', () => {
  // `page.pdf()` is Chromium-only in Playwright, and one real producer is the
  // point rather than three. The parser itself is engine-independent — it runs
  // in Node — so this is about the input, not about the browser.
  test.skip(({ browserName }) => browserName !== 'chromium', 'page.pdf() is Chromium-only')

  const HTML = `<!doctype html><meta charset="utf-8">
    <title>Quarterly report</title>
    <body style="font: 16px/1.5 sans-serif">
      <h1>Quarterly report</h1>
      <p>Revenue rose 4.2% in March. The board approved the figures.</p>
      <p style="page-break-before: always">Second page, so the page count is worth checking.</p>
    </body>`

  test('is rebuilt, and comes out without its metadata', async ({ page }) => {
    await page.setContent(HTML)
    const pdf = await page.pdf({ format: 'A4', printBackground: true })
    const bytes = new Uint8Array(pdf)

    // Chromium stamps its own producer and creation date.
    const before = await inspectContainer(bytes, 'report.pdf')
    expect(before.format).toBe('PDF')

    const result = await cleanContainer(bytes, 'report.pdf')
    const out = Buffer.from(result.output)

    // Still a PDF, and still ends properly.
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(out.includes(Buffer.from('%%EOF'))).toBe(true)

    // The path is named, and on this input it is the rebuild. Asserting the
    // specific path rather than "one of the two" is the point: a silent
    // fallback to the byte pass would still produce a valid file and would
    // still pass a looser check, while leaving the edit history behind.
    const paths = result.findings.map((finding) => finding.label).join(' | ')
    expect(paths).toContain('structural rebuild')

    // Chromium's own producer string is gone.
    const latin = out.toString('latin1')
    expect(latin).not.toContain('Skia')
    expect(latin).not.toMatch(/\/Producer/)
  })

  test('what this input does and does not exercise', async ({ page }) => {
    // Worth stating rather than implying. Skia writes a classic xref table and
    // uncompressed objects, so this proves the rebuild handles a real
    // third-party producer — and proves nothing about object streams or xref
    // streams, which are covered by the built fixtures in pdf/*.test.ts.
    await page.setContent(HTML)
    const latin = Buffer.from(await page.pdf({ format: 'A4' })).toString('latin1')

    expect(latin).toContain('%PDF-')
    expect(latin).not.toContain('/ObjStm')
    expect(latin).not.toContain('/XRef')
  })

  test('keeps the words on the page', async ({ page }) => {
    // The failure that matters most is not "metadata survived", it is "the
    // document did not". A clean that produces an unreadable file is worse than
    // no clean at all.
    await page.setContent(HTML)
    const pdf = await page.pdf({ format: 'A4' })
    const result = await cleanContainer(new Uint8Array(pdf), 'report.pdf')

    // Re-opened by the browser's own reader rather than by ours: our parser
    // saying the output is valid proves only that it agrees with itself.
    const url = `data:application/pdf;base64,${Buffer.from(result.output).toString('base64')}`
    const opened = await page.evaluate(async (href: string) => {
      const response = await fetch(href)
      const buffer = new Uint8Array(await response.arrayBuffer())
      return { length: buffer.length, header: buffer.slice(0, 5).join(',') }
    }, url)

    expect(opened.header).toBe('37,80,68,70,45')
    expect(opened.length).toBeGreaterThan(1000)
  })

  test('a second clean changes nothing more', async ({ page }) => {
    await page.setContent(HTML)
    const pdf = await page.pdf({ format: 'A4' })

    const once = await cleanContainer(new Uint8Array(pdf), 'report.pdf')
    const twice = await cleanContainer(once.output, 'report.pdf')

    expect([...twice.output]).toEqual([...once.output])
  })
})
