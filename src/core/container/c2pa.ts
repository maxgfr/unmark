// What a C2PA manifest actually says, rather than only that one is there.
//
// "C2PA provenance manifest — confirmed" is true and nearly useless. The same
// line covers a photograph signed by the camera that took it, a picture an
// image generator made from nothing, and a chart that went through a chat
// assistant's file store on its way into a thesis. The first is evidence of a
// lens, the second of a model, the third of a tool someone used. A reader who
// cannot tell them apart has to run `strings` on the file, which is what this
// replaces.
//
// The layers, outermost first: JUMBF boxes (ISO 19566-5) carry a manifest
// store; each manifest holds an assertion store, a claim and a COSE signature,
// all CBOR. The signer's name is in the X.509 certificate inside the COSE
// header, so a few dozen lines of DER reading close the loop.
//
// Nothing here verifies anything. The hashes are not recomputed and the
// signature is not checked: this reports what the manifest claims, which is
// what a reader needs to decide whether to care. Saying "signed by" a name
// from an unverified certificate is labelled as such in the evidence line.

import { decodeCbor, field, isCborMap, isTagged, list, text, type CborValue } from './cbor.ts'
import type { Finding } from '../report.ts'
import { decodeUtf8, readU32 } from './types.ts'

// ------------------------------------------------------------------ JUMBF

export interface JumbfBox {
  type: string
  /** From the description box: `c2pa`, `c2pa.assertions`, `c2pa.actions.v2`… */
  label?: string
  /** The description box's content-type UUID, as its first four characters. */
  contentType?: string
  /** Nested boxes when this is a `jumb` superbox. */
  children: JumbfBox[]
  /** The payload of a content box: `cbor`, `json` and the rest. */
  data?: Uint8Array
}

const MAX_JUMBF_DEPTH = 16

function readBoxes(bytes: Uint8Array, start: number, end: number, depth: number): JumbfBox[] {
  const boxes: JumbfBox[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = readU32(bytes, offset) >>> 0
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    let header = 8
    if (size === 1) {
      if (offset + 16 > end) break
      size = readU32(bytes, offset + 8) * 2 ** 32 + (readU32(bytes, offset + 12) >>> 0)
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break

    const body = bytes.subarray(offset + header, offset + size)
    if (type === 'jumb' && depth < MAX_JUMBF_DEPTH) {
      const inner = readBoxes(bytes, offset + header, offset + size, depth + 1)
      const description = inner[0]?.type === 'jumd' ? inner[0] : undefined
      boxes.push({
        type,
        ...(description?.label === undefined ? {} : { label: description.label }),
        ...(description?.contentType === undefined ? {} : { contentType: description.contentType }),
        children: description ? inner.slice(1) : inner,
      })
    } else if (type === 'jumd') {
      // 16-byte content-type UUID, a toggles byte, then the label when bit 1 is set.
      const contentType = body.length >= 4 ? String.fromCharCode(...body.subarray(0, 4)) : ''
      const toggles = body[16] ?? 0
      let label: string | undefined
      if (toggles & 0x02) {
        const nul = body.indexOf(0, 17)
        label = decodeUtf8(body.subarray(17, nul === -1 ? body.length : nul))
      }
      boxes.push({
        type,
        contentType,
        ...(label === undefined ? {} : { label }),
        children: [],
      })
    } else {
      boxes.push({ type, children: [], data: body })
    }
    offset += size
  }
  return boxes
}

/** Parse a run of JUMBF boxes. Never throws: a truncated tail is simply not returned. */
export const readJumbf = (bytes: Uint8Array): JumbfBox[] => readBoxes(bytes, 0, bytes.length, 0)

// ------------------------------------------------------------------ X.509

interface Tlv {
  tag: number
  start: number
  end: number
}

function tlv(bytes: Uint8Array, offset: number, limit: number): Tlv | undefined {
  if (offset + 2 > limit) return undefined
  const tag = bytes[offset] as number
  let length = bytes[offset + 1] as number
  let start = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 4 || start + count > limit) return undefined
    length = 0
    for (let index = 0; index < count; index += 1)
      length = length * 256 + (bytes[start + index] ?? 0)
    start += count
  }
  if (start + length > limit) return undefined
  return { tag, start, end: start + length }
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = []
  let offset = parent.start
  while (offset < parent.end) {
    const child = tlv(bytes, offset, parent.end)
    if (!child) break
    out.push(child)
    offset = child.end
  }
  return out
}

const OID_NAMES: Record<string, string> = {
  '550403': 'CN',
  '55040a': 'O',
  '55040b': 'OU',
  '550406': 'C',
}

const hexOf = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** The attributes of an X.509 Name worth printing: CN, O, OU, C. */
function readName(bytes: Uint8Array, name: Tlv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const set of children(bytes, name)) {
    for (const pair of children(bytes, set)) {
      const [oid, value] = children(bytes, pair)
      if (!oid || !value || oid.tag !== 0x06) continue
      const key = OID_NAMES[hexOf(bytes.subarray(oid.start, oid.end))]
      if (!key || out[key]) continue
      const raw = bytes.subarray(value.start, value.end)
      out[key] = value.tag === 0x1e ? new TextDecoder('utf-16be').decode(raw) : decodeUtf8(raw)
    }
  }
  return out
}

export interface C2paSigner {
  commonName?: string
  organization?: string
  /** Who issued the signing certificate: its O, or its CN when it has no O. */
  issuer?: string
}

/** Subject and issuer of a DER certificate, or undefined if it does not parse. */
export function readCertificate(der: Uint8Array): C2paSigner | undefined {
  const certificate = tlv(der, 0, der.length)
  if (certificate?.tag !== 0x30) return undefined
  const tbs = children(der, certificate)[0]
  if (tbs?.tag !== 0x30) return undefined
  const fields = children(der, tbs)
  // The version is an explicit [0] and is absent for v1 certificates.
  const base = fields[0]?.tag === 0xa0 ? 1 : 0
  const issuer = fields[base + 2]
  const subject = fields[base + 4]
  if (issuer?.tag !== 0x30 || subject?.tag !== 0x30) return undefined
  const who = readName(der, subject)
  const by = readName(der, issuer)
  const signer: C2paSigner = {
    ...(who['CN'] ? { commonName: who['CN'] } : {}),
    ...(who['O'] ? { organization: who['O'] } : {}),
    ...((by['O'] ?? by['CN']) ? { issuer: (by['O'] ?? by['CN']) as string } : {}),
  }
  return Object.keys(signer).length > 0 ? signer : undefined
}

/**
 * The signer named by a COSE_Sign1 signature's certificate chain.
 *
 * `x5chain` is header label 33. C2PA 1.x also wrote it under the text key
 * `x5chain`, and either header — protected or not — may carry it, as one
 * certificate or as an array with the signer first.
 */
function readSigner(signature: CborValue): C2paSigner | undefined {
  const sign1 = isTagged(signature) ? signature.value : signature
  const [protectedBytes, unprotected] = list(sign1)
  let headers: CborValue[] = [unprotected]
  if (protectedBytes instanceof Uint8Array && protectedBytes.length > 0) {
    try {
      headers = [decodeCbor(protectedBytes), unprotected]
    } catch {
      // An unreadable protected header still leaves the unprotected one.
    }
  }
  for (const header of headers) {
    const chain = field(header, 33) ?? field(header, 'x5chain')
    const first = Array.isArray(chain) ? chain[0] : chain
    if (first instanceof Uint8Array) {
      const signer = readCertificate(first)
      if (signer) return signer
    }
  }
  return undefined
}

// ------------------------------------------------------------------ manifests

export interface C2paAction {
  action: string
  /** The tool that performed the action, as the manifest names it. */
  softwareAgent?: string
  /** The IPTC digital source type's last segment: `trainedAlgorithmicMedia`… */
  digitalSourceType?: string
  description?: string
  when?: string
}

export interface C2paManifest {
  label: string
  /** The application that wrote the claim, with its version. */
  claimGenerator?: string
  title?: string
  format?: string
  actions: C2paAction[]
  /** The claim's ingredients: files this one was made from. */
  ingredients: number
  /** Read from the signing certificate. Not verified. */
  signer?: C2paSigner
}

/**
 * What the manifests, taken together, say about where the file came from.
 *
 * - `ai_generated`: an action declares a trained-model digital source type.
 *   This is the manifest saying the content was made by generative AI.
 * - `ai_tool`: an AI product handled the file — opened it, provided it,
 *   signed it — without declaring that it generated the content. Not the same
 *   claim, and reporting it as the first would be wrong.
 * - `edited`: actions are declared, none involving an AI tool.
 * - `unread`: a manifest is there and could not be decoded.
 */
export type C2paOrigin = 'ai_generated' | 'ai_tool' | 'edited' | 'declared' | 'unread'

export interface C2paSummary {
  origin: C2paOrigin
  /** One sentence, for the report line. */
  statement: string
  /** The active manifest is the last one in the store; the rest are its history. */
  manifests: C2paManifest[]
}

/** IPTC digital source types that mean a trained model produced the content. */
const GENERATED_SOURCES = new Set([
  'trainedAlgorithmicMedia',
  'compositeWithTrainedAlgorithmicMedia',
])

/**
 * Names of AI products and their makers, as they appear in manifests.
 *
 * Matched against software agents, claim generators, action names and the
 * signer — Anthropic signs as "Anthropic", OpenAI's actions sit under
 * `com.openai`. A list rather than a heuristic: a false match here would call
 * a camera an AI tool.
 */
const AI_TOOL =
  /\b(?:claude|anthropic|chatgpt|openai|gpt-?\d\w*|dall[\s·.-]?e|sora|midjourney|firefly|gemini|imagen|bard|copilot|bing image creator|stable[\s-]?diffusion|stability ai|runway(?:ml)?|ideogram|leonardo\.ai|grok|xai|meta ai|nano banana)\b/i

const sourceType = (value: CborValue): string | undefined => {
  const url = text(value)
  return url ? url.slice(url.lastIndexOf('/') + 1) : undefined
}

/** `{name, version}` maps and plain strings both name a tool. */
function toolName(value: CborValue): string | undefined {
  if (typeof value === 'string') return value
  const name = text(field(value, 'name'))
  if (!name) return undefined
  const version = text(field(value, 'version'))
  return version ? `${name} ${version}` : name
}

/** JSON-serialised assertions read as CBOR-shaped values, so one reader serves both. */
function fromJson(value: unknown): CborValue {
  if (Array.isArray(value)) return value.map(fromJson)
  if (value && typeof value === 'object') {
    return new Map(Object.entries(value).map(([key, item]) => [key, fromJson(item)]))
  }
  return value as CborValue
}

function content(box: JumbfBox): CborValue {
  for (const child of box.children) {
    if (!child.data) continue
    try {
      if (child.type === 'cbor') return decodeCbor(child.data)
      if (child.type === 'json') return fromJson(JSON.parse(decodeUtf8(child.data)))
    } catch {
      return undefined
    }
  }
  return undefined
}

const ACTIONS = /^c2pa\.actions(?:\.v\d+)?(?:__\d+)?$/
const INGREDIENT = /^c2pa\.ingredient(?:\.v\d+)?(?:__\d+)?$/

function readManifest(box: JumbfBox): C2paManifest {
  const manifest: C2paManifest = { label: box.label ?? '', actions: [], ingredients: 0 }

  for (const part of box.children) {
    const label = part.label ?? ''
    if (label === 'c2pa.assertions' || part.contentType === 'c2as') {
      for (const assertion of part.children) {
        const name = assertion.label ?? ''
        if (INGREDIENT.test(name)) manifest.ingredients += 1
        if (!ACTIONS.test(name)) continue
        for (const entry of list(field(content(assertion), 'actions'))) {
          const action = text(field(entry, 'action'))
          if (!action) continue
          const agent = toolName(field(entry, 'softwareAgent'))
          const source = sourceType(field(entry, 'digitalSourceType'))
          const description = text(field(entry, 'description'))
          const when = text(field(entry, 'when'))
          manifest.actions.push({
            action,
            ...(agent ? { softwareAgent: agent } : {}),
            ...(source ? { digitalSourceType: source } : {}),
            ...(description ? { description } : {}),
            ...(when ? { when } : {}),
          })
        }
      }
    } else if (label.startsWith('c2pa.claim') || part.contentType === 'c2cl') {
      const claim = content(part)
      if (!isCborMap(claim)) continue
      // v2 writes one `claim_generator_info` map; v1 a string plus an
      // optional array of the same maps. The map is the more precise of the two.
      const info = claim.get('claim_generator_info')
      const generator =
        toolName(Array.isArray(info) ? (info[0] as CborValue) : (info as CborValue)) ??
        text(claim.get('claim_generator'))
      if (generator) manifest.claimGenerator = generator
      const title = text(claim.get('dc:title'))
      if (title) manifest.title = title
      const format = text(claim.get('dc:format'))
      if (format) manifest.format = format
    } else if (label === 'c2pa.signature' || part.contentType === 'c2cs') {
      const signer = readSigner(content(part))
      if (signer) manifest.signer = signer
    }
  }
  return manifest
}

const isManifest = (box: JumbfBox) =>
  box.type === 'jumb' && (box.contentType === 'c2ma' || box.contentType === 'c2um')

/** Every C2PA manifest in a run of JUMBF boxes, wherever the store sits. */
function manifestsIn(boxes: readonly JumbfBox[]): C2paManifest[] {
  const out: C2paManifest[] = []
  for (const box of boxes) {
    if (isManifest(box)) out.push(readManifest(box))
    else if (box.type === 'jumb') out.push(...manifestsIn(box.children))
  }
  return out
}

const agentsOf = (manifests: readonly C2paManifest[]): string[] => [
  ...new Set(
    manifests.flatMap((manifest) =>
      manifest.actions.flatMap((action) => (action.softwareAgent ? [action.softwareAgent] : [])),
    ),
  ),
]

/** Classify, and say it in one sentence a reader can act on. */
export function summarise(manifests: C2paManifest[]): C2paSummary {
  if (manifests.length === 0) {
    return {
      origin: 'unread',
      statement: 'manifest present but could not be decoded',
      manifests,
    }
  }

  const actions = manifests.flatMap((manifest) => manifest.actions)
  const generated = actions.find(
    (action) => action.digitalSourceType && GENERATED_SOURCES.has(action.digitalSourceType),
  )
  if (generated) {
    const by = generated.softwareAgent ?? manifests.at(-1)?.claimGenerator
    return {
      origin: 'ai_generated',
      statement:
        `created by generative AI — ${generated.action} declares ${generated.digitalSourceType}` +
        (by ? ` (${by})` : ''),
      manifests,
    }
  }

  const named = (manifest: C2paManifest) =>
    [
      manifest.claimGenerator,
      manifest.signer?.organization,
      manifest.signer?.commonName,
      ...manifest.actions.flatMap((action) => [action.action, action.softwareAgent]),
    ].filter((value): value is string => Boolean(value))
  const tools = manifests.flatMap(named).filter((value) => AI_TOOL.test(value))
  if (tools.length > 0) {
    const agents = agentsOf(manifests).filter((agent) => AI_TOOL.test(agent))
    const who = (agents.length > 0 ? agents : [tools[0] as string]).join(', ')
    const verbs = [...new Set(actions.map((action) => action.action))].join(', ')
    return {
      origin: 'ai_tool',
      statement:
        `file passed through an AI tool (${who}${verbs ? `: ${verbs}` : ''}) — ` +
        'the manifest does not say the content was AI-generated',
      manifests,
    }
  }

  if (actions.length > 0) {
    const by = manifests.at(-1)?.claimGenerator
    return {
      origin: 'edited',
      statement: `edited${by ? ` with ${by}` : ''} — no AI involvement declared`,
      manifests,
    }
  }

  const by = manifests.at(-1)?.claimGenerator
  return {
    origin: 'declared',
    statement: `signed${by ? ` by ${by}` : ''} — no actions declared`,
    manifests,
  }
}

/** Decode a JUMBF manifest store. A store that does not decode comes back as `unread`. */
export function readC2pa(jumbf: Uint8Array): C2paSummary {
  let manifests: C2paManifest[] = []
  try {
    manifests = manifestsIn(readJumbf(jumbf))
  } catch {
    manifests = []
  }
  return summarise(manifests)
}

/**
 * Where a C2PA store starts inside bytes that are not a container we parse.
 *
 * A JPEG 2000 codestream, an embedded file, a format with no rule of its own:
 * the store is still a `jumb` superbox whose description box carries the
 * `c2pa` content type, and that run of twelve bytes is specific enough to
 * search for.
 */
export function findC2pa(bytes: Uint8Array): { offset: number; length: number } | undefined {
  for (
    let at = bytes.indexOf(0x6a);
    at !== -1 && at + 28 <= bytes.length;
    at = bytes.indexOf(0x6a, at + 1)
  ) {
    // `jumb` at `at`, then the description box: length, `jumd`, `c2pa`.
    if (
      bytes[at + 1] !== 0x75 ||
      bytes[at + 2] !== 0x6d ||
      bytes[at + 3] !== 0x62 ||
      String.fromCharCode(...bytes.subarray(at + 8, at + 16)) !== 'jumdc2pa' ||
      at < 4
    ) {
      continue
    }
    const start = at - 4
    const length = readU32(bytes, start) >>> 0
    if (length >= 16 && start + length <= bytes.length) return { offset: start, length }
  }
  return undefined
}

/**
 * The evidence line for a report: generator, actions with their agents, signer.
 *
 * One line, because a terminal table is one line per field. The structured
 * summary travels next to it on the finding for anything that wants more.
 */
export function c2paEvidence(summary: C2paSummary): string {
  const active = summary.manifests.at(-1)
  if (!active) return summary.statement
  const actions = summary.manifests
    .flatMap((manifest) => manifest.actions)
    .map(
      (action) =>
        `${action.action}${action.softwareAgent ? ` by ${action.softwareAgent}` : ''}${
          action.digitalSourceType ? ` [${action.digitalSourceType}]` : ''
        }`,
    )
  const signer = active.signer
  const signedBy = signer
    ? [
        signer.commonName,
        signer.organization && signer.organization !== signer.commonName
          ? signer.organization
          : undefined,
      ]
        .filter(Boolean)
        .join(', ')
    : ''
  return [
    active.claimGenerator,
    actions.length > 0 ? `actions: ${[...new Set(actions)].join(', ')}` : '',
    signedBy
      ? `certificate: ${signedBy}${signer?.issuer ? ` (issued by ${signer.issuer})` : ''}, not verified`
      : '',
    summary.manifests.length > 1 ? `${summary.manifests.length} manifests` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Decorate a C2PA finding with what its manifest says.
 *
 * The label keeps its structural part — `caBX — C2PA provenance manifest` —
 * and gains the classification, so a reader skimming one column still sees
 * the difference between "made by a model" and "went through a tool".
 */
export function withC2pa(finding: Finding, jumbf: Uint8Array): Finding {
  const c2pa = readC2pa(jumbf)
  return {
    ...finding,
    label: `${finding.label}: ${c2pa.statement}`,
    evidence: c2paEvidence(c2pa),
    c2pa,
  }
}
