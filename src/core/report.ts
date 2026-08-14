// What a finding is, and how sure we are about it.
//
// The vocabulary is deliberately borrowed from guillaumemeyer/watermarks-remover:
// a tool that reports "watermark detected" for every non-breaking space trains
// people to ignore it. Separating what we *know* from what we *suspect* is the
// difference between a report and an alarm.

/** How confident the engine is that a finding is a real, deliberate mark. */
export type Verdict =
  /** Structurally certain: a C2PA manifest, a tag-char run decoding to ASCII. */
  | 'confirmed'
  /** Consistent with a mark, but a human could have produced it. */
  | 'probable'
  /** Worth surfacing, not evidence of anything: EXIF from a camera. */
  | 'informational'
  /** Matched a pattern, but context says it is legitimate: emoji ZWJ glue. */
  | 'likely_false_positive'

/** The class of mark, following the reference's taxonomy. */
export type FindingKind =
  // Text, layer A — edit-based marks.
  | 'zwj_family'
  | 'bidi'
  | 'tag_chars'
  | 'variation_selector'
  | 'space'
  | 'confusable'
  // Text, decoded payload.
  | 'stego_payload'
  // Text, statistical tells. Never removed, only reported.
  | 'stylometry'
  // Containers — provenance that lives in the file, not the content.
  | 'c2pa'
  | 'exif'
  | 'xmp'
  | 'iptc'
  | 'text_chunk'
  | 'doc_property'
  | 'generator_tag'

export interface Finding {
  kind: FindingKind
  verdict: Verdict
  /** Byte offset for containers, UTF-16 code-unit offset for text. */
  offset: number
  /** Length in the same unit as `offset`. */
  length: number
  /** One line, human-first: "U+200B ZERO WIDTH SPACE between two ASCII words". */
  label: string
  /** What was actually found, safe to render: a codepoint list, a chunk name. */
  evidence?: string
  /** Why a removable finding was kept, when it was. */
  preserved?: string
}

export interface CleanResult<T> {
  output: T
  findings: Finding[]
  /** Findings matched but deliberately left in place. */
  preserved: Finding[]
}

/** Findings a `clean` pass would act on, as opposed to ones it only reports. */
export const isRemovable = (finding: Finding): boolean =>
  finding.kind !== 'stylometry' &&
  finding.kind !== 'stego_payload' &&
  finding.verdict !== 'likely_false_positive'

/** Stable ordering for display and for snapshot tests: by position, then kind. */
export const byPosition = (a: Finding, b: Finding): number =>
  a.offset - b.offset || a.kind.localeCompare(b.kind)

const RANK: Record<Verdict, number> = {
  confirmed: 0,
  probable: 1,
  informational: 2,
  likely_false_positive: 3,
}

/** The strongest verdict in a set — what a summary line should report. */
export const worstVerdict = (findings: readonly Finding[]): Verdict | undefined =>
  findings.length === 0
    ? undefined
    : findings.reduce(
        (worst, f) => (RANK[f.verdict] < RANK[worst] ? f.verdict : worst),
        'likely_false_positive' as Verdict,
      )
