// C2PA manifest stores built in code: JUMBF boxes, CBOR, a COSE signature
// and an X.509 certificate, each as small as the reader needs.
//
// Real stores are kilobytes of hashes and certificate chains. What the reader
// is tested on is the shape — which box holds the claim, where the signer's
// name sits in the certificate — so the builder plants exactly that and
// nothing a test would have to scroll past.

import { concat, encode } from '../core/container/types.ts'

// ------------------------------------------------------------------- CBOR

export type CborInput =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CborInput[]
  | Map<string | number, CborInput>
  | { [key: string]: CborInput }
  | { tag: number; value: CborInput }

const head = (major: number, value: number): Uint8Array => {
  if (value < 24) return new Uint8Array([(major << 5) | value])
  if (value < 0x100) return new Uint8Array([(major << 5) | 24, value])
  if (value < 0x10000) return new Uint8Array([(major << 5) | 25, value >> 8, value & 0xff])
  return new Uint8Array([
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

const isTag = (value: object): value is { tag: number; value: CborInput } =>
  'tag' in value && 'value' in value && Object.keys(value).length === 2

/** Definite-length CBOR for the values a manifest uses. */
export function cbor(value: CborInput): Uint8Array {
  if (value === null) return new Uint8Array([0xf6])
  if (value === true) return new Uint8Array([0xf5])
  if (value === false) return new Uint8Array([0xf4])
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = encode(value)
    return concat([head(3, bytes.length), bytes])
  }
  if (value instanceof Uint8Array) return concat([head(2, value.length), value])
  if (Array.isArray(value)) return concat([head(4, value.length), ...value.map(cbor)])
  if (value instanceof Map) {
    return concat([
      head(5, value.size),
      ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
    ])
  }
  if (isTag(value)) return concat([head(6, value.tag), cbor(value.value)])
  const entries = Object.entries(value)
  return concat([
    head(5, entries.length),
    ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ])
}

// -------------------------------------------------------------------- DER

const derLength = (length: number): Uint8Array =>
  length < 0x80
    ? new Uint8Array([length])
    : length < 0x100
      ? new Uint8Array([0x81, length])
      : new Uint8Array([0x82, length >> 8, length & 0xff])

const der = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(content)
  return concat([new Uint8Array([tag]), derLength(body.length), body])
}

const OIDS = { CN: [0x55, 0x04, 0x03], O: [0x55, 0x04, 0x0a] } as const

const name = (attributes: { CN?: string; O?: string }): Uint8Array =>
  der(
    0x30,
    ...Object.entries(attributes).map(([key, value]) =>
      der(
        0x31,
        der(0x30, der(0x06, new Uint8Array(OIDS[key as 'CN' | 'O'])), der(0x0c, encode(value))),
      ),
    ),
  )

/** A certificate with a real structure and nothing behind it: no key, no signature. */
export function certificate(
  subject: { CN?: string; O?: string },
  issuer: { CN?: string; O?: string },
) {
  const algorithm = der(
    0x30,
    der(0x06, new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03])),
  )
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, new Uint8Array([2]))),
    der(0x02, new Uint8Array([0x40, 0xe5])),
    algorithm,
    name(issuer),
    der(0x30, der(0x17, encode('260101000000Z')), der(0x17, encode('270101000000Z'))),
    name(subject),
  )
  return der(0x30, tbs, algorithm, der(0x03, new Uint8Array([0])))
}

// ------------------------------------------------------------------- JUMBF

const u32 = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])

const jbox = (type: string, body: Uint8Array): Uint8Array =>
  concat([u32(8 + body.length), encode(type), body])

/** C2PA content-type UUIDs share a tail after the four-character code. */
const C2PA_UUID_TAIL = new Uint8Array([
  0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
])

/** A labelled JUMBF superbox: description box first, then the children. */
export const superbox = (contentType: string, label: string, ...children: Uint8Array[]) =>
  jbox(
    'jumb',
    concat([
      jbox(
        'jumd',
        concat([
          encode(contentType),
          C2PA_UUID_TAIL,
          new Uint8Array([0x03]),
          encode(label),
          new Uint8Array([0]),
        ]),
      ),
      ...children,
    ]),
  )

export interface ActionSpec {
  action: string
  softwareAgent?: string | { name: string; version?: string }
  digitalSourceType?: string
  description?: string
}

export interface StoreSpec {
  generator?: { name: string; version?: string }
  /** C2PA 1.x: a plain `claim_generator` string instead of the info map. */
  legacyGenerator?: string
  actions?: ActionSpec[]
  /** Write the actions assertion as JSON rather than CBOR. */
  json?: boolean
  signer?: { subject: { CN?: string; O?: string }; issuer: { CN?: string; O?: string } }
  /** Put the certificate in the unprotected header under the 1.x text key. */
  unprotectedChain?: boolean
  /** A second manifest before the active one, for the history case. */
  previous?: StoreSpec
}

function manifest(spec: StoreSpec, label: string): Uint8Array {
  const actions = {
    actions: (spec.actions ?? []).map((action) => {
      const entry: Record<string, unknown> = { action: action.action }
      if (action.softwareAgent) entry['softwareAgent'] = action.softwareAgent
      if (action.digitalSourceType) {
        entry['digitalSourceType'] =
          `http://cv.iptc.org/newscodes/digitalsourcetype/${action.digitalSourceType}`
      }
      if (action.description) entry['description'] = action.description
      return entry
    }),
  }
  const assertion = spec.json
    ? superbox('json', 'c2pa.actions', jbox('json', encode(JSON.stringify(actions))))
    : superbox('cbor', 'c2pa.actions.v2', jbox('cbor', cbor(actions as CborInput)))
  const ingredient = superbox(
    'cbor',
    'c2pa.ingredient.v3',
    jbox('cbor', cbor({ 'dc:format': 'image/png', relationship: 'parentOf' })),
  )

  const claim = spec.legacyGenerator
    ? { claim_generator: spec.legacyGenerator, 'dc:format': 'image/png', 'dc:title': 'chart.png' }
    : {
        alg: 'sha256',
        ...(spec.generator ? { claim_generator_info: spec.generator } : {}),
        'dc:format': 'image/png',
      }

  const chain = spec.signer ? certificate(spec.signer.subject, spec.signer.issuer) : undefined
  const protectedHeader =
    chain && !spec.unprotectedChain
      ? cbor(
          new Map<number, CborInput>([
            [1, -7],
            [33, chain],
          ]),
        )
      : cbor(new Map([[1, -7]]))
  const unprotected: CborInput = chain && spec.unprotectedChain ? { x5chain: [chain] } : {}
  const signature = cbor({
    tag: 18,
    value: [protectedHeader, unprotected, null, new Uint8Array(64)],
  })

  return superbox(
    'c2ma',
    label,
    superbox('c2as', 'c2pa.assertions', ingredient, assertion),
    superbox('c2cl', 'c2pa.claim.v2', jbox('cbor', cbor(claim as CborInput))),
    superbox('c2cs', 'c2pa.signature', jbox('cbor', signature)),
  )
}

/** A whole manifest store: the bytes a PNG `caBX` chunk or a WebP `C2PA` chunk holds. */
export function c2paStore(spec: StoreSpec): Uint8Array {
  const manifests = [
    ...(spec.previous ? [manifest(spec.previous, 'urn:c2pa:previous')] : []),
    manifest(spec, 'urn:c2pa:active'),
  ]
  return superbox('c2pa', 'c2pa', ...manifests)
}

/** What Anthropic's file tool stamps on a picture it hands back. */
export const CLAUDE_STORE: StoreSpec = {
  generator: { name: 'Anthropic Files', version: '1.0.0' },
  actions: [
    { action: 'c2pa.opened' },
    {
      action: 'com.anthropic.claude.provided',
      softwareAgent: { name: 'Claude' },
      description: 'Claude provided this file at the request of a user.',
    },
  ],
  signer: {
    subject: { CN: 'Content Signing', O: 'Example AI Lab' },
    issuer: { O: 'Example AI Lab' },
  },
}

/** What an image generator stamps on a picture it made from nothing. */
export const GENERATOR_STORE: StoreSpec = {
  generator: { name: 'Image Studio', version: '2.1' },
  actions: [
    {
      action: 'c2pa.created',
      softwareAgent: 'Image Studio 2.1',
      digitalSourceType: 'trainedAlgorithmicMedia',
    },
  ],
}

/** What a photo editor writes after a crop. */
export const EDITOR_STORE: StoreSpec = {
  generator: { name: 'Photo Editor', version: '9' },
  actions: [{ action: 'c2pa.cropped', softwareAgent: 'Photo Editor 9' }],
}
