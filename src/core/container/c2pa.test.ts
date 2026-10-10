import { describe, expect, it } from 'vitest'
import { c2paEvidence, findC2pa, readC2pa, readCertificate, readJumbf, withC2pa } from './c2pa.ts'
import {
  c2paStore,
  certificate,
  CLAUDE_STORE,
  EDITOR_STORE,
  GENERATOR_STORE,
  superbox,
} from '../../test/c2pa.ts'
import { concat, encode } from './types.ts'

describe('readJumbf', () => {
  it('reads labels and nesting from the description boxes', () => {
    const [store] = readJumbf(c2paStore(CLAUDE_STORE))
    expect(store).toMatchObject({ type: 'jumb', label: 'c2pa', contentType: 'c2pa' })
    expect(store?.children[0]).toMatchObject({ label: 'urn:c2pa:active', contentType: 'c2ma' })
  })

  it('stops at a truncated box rather than reading past the end', () => {
    const store = c2paStore(CLAUDE_STORE)
    expect(() => readJumbf(store.subarray(0, 40))).not.toThrow()
  })
})

describe('readC2pa', () => {
  it('tells a file an AI tool handled from one it generated', () => {
    // The distinction the plain "C2PA manifest present" line could not make:
    // Claude handing a chart back is not Claude drawing it.
    const handled = readC2pa(c2paStore(CLAUDE_STORE))
    expect(handled.origin).toBe('ai_tool')
    expect(handled.statement).toContain('file passed through an AI tool (Claude')
    expect(handled.statement).toContain('does not say the content was AI-generated')

    const generated = readC2pa(c2paStore(GENERATOR_STORE))
    expect(generated.origin).toBe('ai_generated')
    expect(generated.statement).toContain('trainedAlgorithmicMedia')
  })

  it('reads the generator, the actions with their agents, and the signer', () => {
    const [manifest] = readC2pa(c2paStore(CLAUDE_STORE)).manifests
    expect(manifest).toMatchObject({
      claimGenerator: 'Anthropic Files 1.0.0',
      ingredients: 1,
      signer: {
        commonName: 'Content Signing',
        organization: 'Example AI Lab',
        issuer: 'Example AI Lab',
      },
    })
    expect(manifest?.actions).toEqual([
      { action: 'c2pa.opened' },
      {
        action: 'com.anthropic.claude.provided',
        softwareAgent: 'Claude',
        description: 'Claude provided this file at the request of a user.',
      },
    ])
  })

  it('calls an edit with no AI involved an edit', () => {
    const summary = readC2pa(c2paStore(EDITOR_STORE))
    expect(summary.origin).toBe('edited')
    expect(summary.statement).toBe('edited with Photo Editor 9 — no AI involvement declared')
  })

  it('reports a manifest with no actions as declared, naming who signed it', () => {
    const summary = readC2pa(c2paStore({ generator: { name: 'Camera' } }))
    expect(summary).toMatchObject({
      origin: 'declared',
      statement: 'signed by Camera — no actions declared',
    })
  })

  it('reads C2PA 1.x: a generator string, a JSON assertion, the chain under its text key', () => {
    const summary = readC2pa(
      c2paStore({
        legacyGenerator: 'Old Tool/1.0',
        json: true,
        unprotectedChain: true,
        actions: [{ action: 'c2pa.edited', softwareAgent: 'Old Tool' }],
        signer: { subject: { CN: 'Signer' }, issuer: { CN: 'Root CA' } },
      }),
    )
    expect(summary.manifests[0]).toMatchObject({
      claimGenerator: 'Old Tool/1.0',
      title: 'chart.png',
      format: 'image/png',
      actions: [{ action: 'c2pa.edited', softwareAgent: 'Old Tool' }],
      signer: { commonName: 'Signer', issuer: 'Root CA' },
    })
  })

  it('reads every manifest in the store and judges on all of them', () => {
    // An AI-generated ingredient keeps its provenance after an innocent edit.
    const summary = readC2pa(c2paStore({ ...EDITOR_STORE, previous: GENERATOR_STORE }))
    expect(summary.manifests).toHaveLength(2)
    expect(summary.origin).toBe('ai_generated')
    expect(c2paEvidence(summary)).toContain('2 manifests')
  })

  it('says unread rather than absent when nothing decodes', () => {
    expect(readC2pa(encode('signed manifest bytes'))).toMatchObject({
      origin: 'unread',
      manifests: [],
    })
  })

  it('survives a claim that is not CBOR', () => {
    const broken = superbox(
      'c2pa',
      'c2pa',
      superbox(
        'c2ma',
        'urn:x',
        superbox(
          'c2cl',
          'c2pa.claim.v2',
          concat([new Uint8Array([0, 0, 0, 9]), encode('cbor'), new Uint8Array([0x62])]),
        ),
      ),
    )
    expect(readC2pa(broken).origin).toBe('declared')
  })
})

describe('readCertificate', () => {
  it('reads subject and issuer names from DER', () => {
    expect(readCertificate(certificate({ CN: 'A', O: 'B' }, { CN: 'C' }))).toEqual({
      commonName: 'A',
      organization: 'B',
      issuer: 'C',
    })
  })

  it('returns nothing for bytes that are not a certificate', () => {
    expect(readCertificate(encode('nope'))).toBeUndefined()
    expect(readCertificate(new Uint8Array([0x30, 0x82, 0xff, 0xff]))).toBeUndefined()
  })
})

describe('findC2pa', () => {
  it('finds a store embedded at an arbitrary offset', () => {
    const store = c2paStore(CLAUDE_STORE)
    const blob = concat([encode('jp2 header jumbo'), store, encode('tail')])
    expect(findC2pa(blob)).toEqual({ offset: 16, length: store.length })
  })

  it('ignores a jumb box that is not C2PA', () => {
    expect(findC2pa(superbox('json', 'other'))).toBeUndefined()
    expect(findC2pa(encode('jumbjumb'))).toBeUndefined()
  })
})

describe('withC2pa', () => {
  it('keeps the structural label and adds the classification and the evidence line', () => {
    const finding = withC2pa(
      {
        kind: 'c2pa',
        verdict: 'confirmed',
        offset: 0,
        length: 1,
        label: 'caBX — C2PA provenance manifest',
      },
      c2paStore(CLAUDE_STORE),
    )
    expect(finding.label).toMatch(
      /^caBX — C2PA provenance manifest: file passed through an AI tool/,
    )
    expect(finding.evidence).toBe(
      'Anthropic Files 1.0.0 · actions: c2pa.opened, com.anthropic.claude.provided by Claude · ' +
        'certificate: Content Signing, Example AI Lab (issued by Example AI Lab), not verified',
    )
    expect(finding.c2pa?.origin).toBe('ai_tool')
  })
})
