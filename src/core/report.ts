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
  // A located habit of generated prose, from the authorship assessment. Never
  // removed either: there is no substitution for it, only a rewrite.
  | 'ai_style'
  // Punctuation and boilerplate phrasing. Removable, but a style choice rather
  // than a mark — which is why both are opt-in.
  | 'typography'
  | 'ai_phrase'
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
  /**
   * The option that would act on this, when one is off.
   *
   * Distinct from `preserved`: an emoji joiner is kept because removing it
   * would be wrong, whereas an em dash is merely waiting for a toggle. Calling
   * both "kept" told the reader the second was legitimate.
   */
  available?: string
  /**
   * What the span becomes when this one finding is applied on its own.
   *
   * An empty string is a real value — a zero-width carrier is deleted — so the
   * field being *present* is what says the engine has an answer, and its
   * absence says it has none. A caller must never be left to tell those two
   * apart by falsiness, which is also why every producer sets it with an
   * `!== undefined` guard rather than the truthiness spread used elsewhere in
   * this codebase.
   *
   * It is what the pass would write for this span, not what the pass's whole
   * output would look like: `humanise` tidies the seam after a deletion, so
   * applying one sentence removal alone can leave a doubled space that the full
   * pass would have closed up. The report re-runs after every apply and a
   * doubled space is not a mark, so nothing is misreported — but it is a real
   * difference and belongs here rather than in someone's head.
   */
  replacement?: string
  /**
   * Why there is no `replacement`, when a reader would expect one.
   *
   * The third of the sentence-carrying fields, and it answers the question the
   * other two do not: `preserved` says why something removable was left,
   * `available` says which toggle is waiting, and this says that no toggle and
   * no edit will ever do it. "Delve" has no correct substitution; rewriting the
   * sentence is the fix, and that takes a writer.
   */
  noFix?: string
  /**
   * What `offset` and `length` address.
   *
   * A style tell sets both to span the whole text, which reads exactly like a
   * position and is not one. A printed column of numbers skims past that; an
   * interface that selects the span does not, and there is nothing in the two
   * numbers to tell the cases apart. Absent means a real span — the common
   * case, and a field repeated on every one of them to say the obvious is a
   * field that gets forgotten once and then means nothing.
   */
  scope?: 'document'
  /**
   * A location that is not an offset: the ZIP entry a document property lives in.
   *
   * The formats built on a zip have no meaningful byte offset into the file —
   * the part is what identifies the finding, and printing `at 0` for all of
   * them says nothing eleven times.
   */
  where?: string
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
  finding.kind !== 'ai_style' &&
  finding.kind !== 'stego_payload' &&
  finding.verdict !== 'likely_false_positive'

/**
 * What actually happened to a finding.
 *
 * The column a report most needs and the easiest one to leave out. A table of
 * marks that does not say which were removed leaves the reader to infer it from
 * the verdict, which answers a different question: a `confirmed` emoji joiner
 * is kept, a merely `probable` XMP packet is removed.
 */
export type Outcome = 'removed' | 'kept' | 'available' | 'reported'

export const outcomeOf = (finding: Finding): Outcome =>
  finding.available
    ? 'available'
    : finding.preserved
      ? 'kept'
      : isRemovable(finding)
        ? 'removed'
        : 'reported'

/** What each machine-readable kind is called in a sentence. */
export const KIND_LABEL: Record<FindingKind, string> = {
  zwj_family: 'Zero-width character',
  bidi: 'Bidirectional control',
  tag_chars: 'Tag character',
  variation_selector: 'Variation selector',
  space: 'Space character',
  confusable: 'Lookalike letter',
  stego_payload: 'Hidden payload',
  stylometry: 'Writing style',
  ai_style: 'AI-writing pattern',
  typography: 'Typography',
  ai_phrase: 'Generated-prose boilerplate',
  c2pa: 'C2PA provenance',
  exif: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC',
  text_chunk: 'Embedded text',
  doc_property: 'Document property',
  generator_tag: 'Generator tag',
}

/** Stable ordering for display and for snapshot tests: by position, then kind. */
export const byPosition = (a: Finding, b: Finding): number =>
  a.offset - b.offset || a.kind.localeCompare(b.kind)

const RANK: Record<Verdict, number> = {
  confirmed: 0,
  probable: 1,
  informational: 2,
  likely_false_positive: 3,
}

/**
 * Most serious first, document order within a verdict.
 *
 * Pure document order buries the point: an EXIF timestamp at offset 20 sits
 * above a signed C2PA manifest at offset 900, and the reader has to scan the
 * whole table to learn whether anything mattered. Grouping by verdict puts the
 * answer in the first row and keeps positions readable inside each group.
 */
export const bySeverity = (a: Finding, b: Finding): number =>
  RANK[a.verdict] - RANK[b.verdict] || a.offset - b.offset || a.kind.localeCompare(b.kind)

/**
 * Above this many findings of one kind, list them as a group instead.
 *
 * A payload of eleven characters is eighty-eight zero-width carriers. Printing
 * eighty-eight near-identical lines buries the one line that matters — the
 * decoded payload — and produces a report nobody reads, which is the same
 * failure as not reporting at all.
 */
const CROWD = 6

/**
 * A row in a rendered report: one finding, or a fold standing for several.
 *
 * It extends `Finding` rather than wrapping one so every existing reader of a
 * collapsed row — the table, the terminal — keeps working untouched, and only
 * the code that acts on a fold has to know that folds exist at all.
 */
export interface Row extends Finding {
  /** The findings this row stands for, when it stands for more than itself. */
  folded?: Finding[]
}

/**
 * The edits one action on this row would make. Empty when there are none.
 *
 * One function, because a button's enabled state, its label ("Apply" against
 * "Apply all 30") and its effect are three readings of the same question, and
 * answering them in three places is how the three drift apart.
 *
 * A fold is all-or-nothing: thirty em dashes are exactly the case where acting
 * on a row earns its keep, and a fold whose members disagree about whether they
 * can be applied has no honest single answer.
 */
export const editsOf = (row: Row): Finding[] => {
  const members = row.folded ?? [row]
  return members.every((f) => f.replacement !== undefined && f.scope !== 'document') ? members : []
}

/**
 * Fold large groups of same-kind findings into one summary each.
 *
 * Deliberately not a filter: nothing is dropped, and the summary carries the
 * count and the span so the detail is still available to anyone who wants it.
 */
export function collapseRuns(findings: readonly Finding[]): Row[] {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    // The label is part of the key, not only the kind and the verdict. Once
    // punctuation is reported per occurrence rather than as a count, a key
    // without it folds every em dash, curly quote and ellipsis into one
    // undifferentiated `31 x typography` row — strictly less than this report
    // said when none of them were locatable. The same rule applied to carriers
    // separates a binary zero-width alphabet into the two codepoints it is
    // built from, which is the scheme rather than a detail.
    const key = `${finding.kind} ${finding.verdict}\0${finding.label}`
    const group = groups.get(key)
    if (group) group.push(finding)
    else groups.set(key, [finding])
  }

  const out: Row[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (!first || group.length <= CROWD) {
      out.push(...group)
      continue
    }

    const last = group.reduce((a, b) => (b.offset > a.offset ? b : a))
    const distinct = [...new Set(group.map((f) => f.label))]
    out.push({
      kind: first.kind,
      verdict: first.verdict,
      offset: first.offset,
      length: last.offset + last.length - first.offset,
      label: `${group.length} × ${KIND_LABEL[first.kind].toLowerCase()}, offsets ${first.offset}–${last.offset}`,
      evidence: distinct.slice(0, 4).join(', ') + (distinct.length > 4 ? ', …' : ''),
      // Both outcome fields travel with the fold. Copying only `preserved`
      // meant a crowd of findings waiting on a toggle folded into one row that
      // `outcomeOf` read as `removed`, while the document still contained every
      // one of them — the summary contradicting the text it summarised.
      ...(first.preserved ? { preserved: first.preserved } : {}),
      ...(first.available ? { available: first.available } : {}),
      ...(first.noFix ? { noFix: first.noFix } : {}),
      ...(first.scope ? { scope: first.scope } : {}),
      // Deliberately no `replacement`. The span above is a hull: these are
      // grouped by what they are and not by sitting next to each other, so it
      // covers whatever unrelated text lies between the first and the last.
      // Splicing it would delete that text. `folded` is how a caller reaches
      // the members instead, and `editsOf` is the only thing that should.
      folded: group,
    })
  }

  return out.sort(bySeverity)
}

/** The strongest verdict in a set — what a summary line should report. */
export const worstVerdict = (findings: readonly Finding[]): Verdict | undefined =>
  findings.length === 0
    ? undefined
    : findings.reduce(
        (worst, f) => (RANK[f.verdict] < RANK[worst] ? f.verdict : worst),
        'likely_false_positive' as Verdict,
      )

/**
 * Counts for a report header: what happened, before the rows say to what.
 *
 * Lives here rather than beside the table because it is arithmetic over
 * findings, not a component — and the CLI needs the same three numbers.
 */
export function summariseOutcomes(findings: readonly Finding[]): string {
  if (findings.length === 0) return ''
  const counts: Record<Outcome, number> = { removed: 0, kept: 0, available: 0, reported: 0 }
  for (const finding of findings) counts[outcomeOf(finding)] += 1

  return [
    counts.removed > 0 ? `${counts.removed} removed` : '',
    counts.kept > 0 ? `${counts.kept} kept` : '',
    counts.available > 0 ? `${counts.available} available` : '',
    counts.reported > 0 ? `${counts.reported} reported` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
