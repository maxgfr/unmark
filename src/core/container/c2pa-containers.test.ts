// The manifest is read wherever a container keeps one: a PNG chunk, JPEG APP11
// segments, a WebP chunk, an ISOBMFF box. Each test plants the same store and
// checks the finding says what it says, not only that it is there.

import { describe, expect, it } from 'vitest'
import { cleanPng } from './png.ts'
import { cleanJpeg } from './jpeg.ts'
import { cleanWebp } from './webp.ts'
import { cleanIsobmff } from './isobmff/index.ts'
import { c2paStore, CLAUDE_STORE, GENERATOR_STORE } from '../../test/c2pa.ts'
import { C2PA_BOX_UUID, heic, jpeg, png, webp } from '../../test/containers.ts'
import { concat, encode } from './types.ts'

const store = c2paStore(CLAUDE_STORE)

/** JPEG XT framing: `JP`, box instance, sequence number, then the box bytes. */
const app11 = (instance: number, sequence: number, payload: Uint8Array) =>
  concat([
    encode('JP'),
    new Uint8Array([instance >> 8, instance & 0xff, 0, 0, 0, sequence]),
    payload,
  ])

describe('C2PA in containers', () => {
  it('decodes a PNG caBX chunk', () => {
    const [finding] = cleanPng(png([{ type: 'caBX', data: store }])).findings
    expect(finding?.label).toContain(
      'caBX — C2PA provenance manifest: file passed through an AI tool',
    )
    expect(finding?.c2pa?.manifests[0]?.claimGenerator).toBe('Anthropic Files 1.0.0')
  })

  it('reassembles a JUMBF box split across JPEG APP11 segments', () => {
    // Every segment after the first repeats the box's length and type before
    // carrying on; concatenating the raw payloads would corrupt the store.
    const cut = 200
    const file = jpeg([
      { marker: 0xeb, data: app11(1, 1, store.subarray(0, cut)) },
      { marker: 0xeb, data: app11(1, 2, concat([store.subarray(0, 8), store.subarray(cut)])) },
    ])
    const { findings } = cleanJpeg(file)
    expect(findings).toHaveLength(2)
    expect(findings[0]?.c2pa?.origin).toBe('ai_tool')
    expect(findings[1]?.c2pa).toBeUndefined()
  })

  it('keeps two JPEG APP11 boxes with different instance numbers apart', () => {
    const generated = c2paStore(GENERATOR_STORE)
    const { findings } = cleanJpeg(
      jpeg([
        { marker: 0xeb, data: app11(1, 1, store) },
        { marker: 0xeb, data: app11(2, 1, generated) },
      ]),
    )
    expect(findings.map((finding) => finding.c2pa?.origin)).toEqual(['ai_tool', 'ai_generated'])
  })

  it('leaves an APP11 segment that is not JPEG XT framed as a plain finding', () => {
    const [finding] = cleanJpeg(jpeg([{ marker: 0xeb, data: 'not framed' }])).findings
    expect(finding).toMatchObject({ kind: 'c2pa', label: 'APP11 — JUMBF / C2PA provenance box' })
    expect(finding?.c2pa).toBeUndefined()
  })

  it('decodes a WebP C2PA chunk', () => {
    const [finding] = cleanWebp(webp([{ fourcc: 'C2PA', data: store }])).findings
    expect(finding?.c2pa?.origin).toBe('ai_tool')
  })

  it('decodes the C2PA uuid box of an ISOBMFF file, past its purpose and Merkle offset', async () => {
    const payload = concat([new Uint8Array(4), encode('manifest'), new Uint8Array(9), store])
    const { findings } = await cleanIsobmff(
      heic({ extra: [{ type: 'uuid', uuid: C2PA_BOX_UUID, data: payload }] }),
    )
    expect(findings.find((finding) => finding.kind === 'c2pa')?.c2pa?.origin).toBe('ai_tool')
  })

  it('decodes a top-level jumb box', async () => {
    const { findings } = await cleanIsobmff(
      heic({ extra: [{ type: 'jumb', data: store.subarray(8) }] }),
    )
    expect(findings.find((finding) => finding.kind === 'c2pa')?.c2pa?.origin).toBe('ai_tool')
  })

  it('tolerates a C2PA uuid box with no purpose terminator', async () => {
    const { findings } = await cleanIsobmff(
      heic({ extra: [{ type: 'uuid', uuid: C2PA_BOX_UUID, data: 'xxxx' }] }),
    )
    expect(findings.find((finding) => finding.kind === 'c2pa')?.c2pa?.origin).toBe('unread')
  })
})
