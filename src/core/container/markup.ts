// Text containers: SVG, HTML and Markdown.
//
// These are edited as text rather than parsed into a tree and re-serialised,
// which is a deliberate trade. A round trip through a parser would reformat the
// whole document — reordering attributes, normalising quotes, collapsing
// whitespace — and hand back a file that differs everywhere for the sake of
// removing one tag. Surgical string edits keep the diff to what was removed.
//
// The cost is that these patterns are not a parser and will not follow markup
// that is pathological on purpose. For metadata blocks, which are written by
// tools and look like it, that trade is worth making.

import type { Finding, FindingKind, Verdict } from '../report.ts'
import { snippet } from './types.ts'

export interface TextCleanResult {
  output: string
  findings: Finding[]
}

interface Rule {
  pattern: RegExp
  kind: FindingKind
  verdict: Verdict
  label: string
  /** Pull the part worth quoting out of the match. */
  evidence?: (match: RegExpExecArray) => string | undefined
  /**
   * Second look at a match before acting on it, for rules whose pattern has to
   * be broad. The JSON-LD rule matches every ld+json block because a regex
   * cannot ask what is inside the JSON; this is where that question gets asked.
   */
  applies?: (match: RegExpExecArray) => boolean
}

/**
 * Apply rules right-to-left so earlier offsets stay valid as text is removed.
 *
 * Findings still report offsets into the *original* document, which is what a
 * UI highlighting the input needs.
 */
function applyRules(text: string, rules: readonly Rule[]): TextCleanResult {
  const hits: { start: number; end: number; finding: Finding }[] = []

  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1
        continue
      }
      if (rule.applies && !rule.applies(match)) continue
      const evidence = rule.evidence?.(match)
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        finding: {
          kind: rule.kind,
          verdict: rule.verdict,
          offset: match.index,
          length: match[0].length,
          label: rule.label,
          ...(evidence ? { evidence: snippet(evidence) } : {}),
        },
      })
    }
  }

  // Overlapping matches would splice each other apart; the outermost wins.
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const chosen: typeof hits = []
  let reach = -1
  for (const hit of hits) {
    if (hit.start < reach) continue
    chosen.push(hit)
    reach = hit.end
  }

  let output = text
  for (const hit of [...chosen].reverse()) {
    output = output.slice(0, hit.start) + output.slice(hit.end)
  }

  return { output, findings: chosen.map((hit) => hit.finding) }
}

const GENERATOR_COMMENT =
  /<!--[^>]*?(?:generator|generated (?:by|with)|created with)[\s\S]*?-->\s*/gi

const DATA_AI_ATTRIBUTE = /\s+data-ai(?:-[a-z0-9-]+)?=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi

// What makes a JSON-LD block a provenance claim rather than page structure:
// it has to name a producing tool *and* say that tool is software.
const PROVENANCE_KEY = /"(?:generator|creator|producer|softwareApplication|isBasedOn)"/i
const SOFTWARE_CREATOR = /SoftwareApplication|Organization/i

const SVG_RULES: Rule[] = [
  {
    pattern: /<metadata\b[\s\S]*?<\/metadata>\s*/gi,
    kind: 'doc_property',
    verdict: 'informational',
    label: '<metadata> block',
    evidence: (m) => m[0],
  },
  {
    pattern: /<\?xpacket\b[\s\S]*?<\?xpacket end[^>]*\?>\s*/gi,
    kind: 'xmp',
    verdict: 'probable',
    label: 'XMP packet',
    evidence: (m) => m[0],
  },
  {
    pattern: /<x:xmpmeta\b[\s\S]*?<\/x:xmpmeta>\s*/gi,
    kind: 'xmp',
    verdict: 'probable',
    label: 'XMP metadata element',
    evidence: (m) => m[0],
  },
  {
    pattern: GENERATOR_COMMENT,
    kind: 'generator_tag',
    verdict: 'informational',
    label: 'Generator comment',
    evidence: (m) => m[0],
  },
  {
    pattern: DATA_AI_ATTRIBUTE,
    kind: 'generator_tag',
    verdict: 'probable',
    label: 'data-ai attribute',
    evidence: (m) => m[0],
  },
]

const HTML_RULES: Rule[] = [
  {
    pattern: /<meta\b[^>]*\bname=["']generator["'][^>]*>\s*/gi,
    kind: 'generator_tag',
    verdict: 'informational',
    label: '<meta name="generator">',
    evidence: (m) => /content=["']([^"']*)["']/i.exec(m[0])?.[1],
  },
  {
    pattern: /<meta\b[^>]*\bname=["'][a-z-]*ai-generated["'][^>]*>\s*/gi,
    kind: 'generator_tag',
    verdict: 'confirmed',
    label: '<meta> AI-generated declaration',
    evidence: (m) => m[0],
  },
  {
    // Matches every ld+json block, then `applies` decides. A blanket strip
    // would take out a site's Article, Product and Breadcrumb schema, which is
    // structured data the page depends on and has nothing to do with origin.
    pattern: /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\s*/gi,
    kind: 'generator_tag',
    verdict: 'probable',
    label: 'JSON-LD provenance block',
    applies: (m) => PROVENANCE_KEY.test(m[0]) && SOFTWARE_CREATOR.test(m[0]),
    evidence: (m) => m[0],
  },
  {
    pattern: GENERATOR_COMMENT,
    kind: 'generator_tag',
    verdict: 'informational',
    label: 'Generator comment',
    evidence: (m) => m[0],
  },
  {
    pattern: DATA_AI_ATTRIBUTE,
    kind: 'generator_tag',
    verdict: 'probable',
    label: 'data-ai attribute',
    evidence: (m) => m[0],
  },
]

export const cleanSvg = (text: string): TextCleanResult => applyRules(text, SVG_RULES)
export const cleanHtml = (text: string): TextCleanResult => applyRules(text, HTML_RULES)

// Frontmatter keys that record which tool wrote the document.
const AI_FRONTMATTER_KEY =
  /^(?:ai|ai_generated|ai-generated|generator|generated_by|generated-by|model|llm|assistant|tool|openai|chatgpt|claude|gemini|copilot)\s*:/i

/**
 * Markdown carries provenance in YAML frontmatter, so only the frontmatter is
 * touched — and only the keys that name a tool. Everything else in the block is
 * the author's own metadata.
 */
export function cleanMarkdown(text: string): TextCleanResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!match?.[1]) return { output: text, findings: [] }

  const findings: Finding[] = []
  const blockStart = 4 // past the opening '---\n'
  const lines = match[1].split('\n')
  const kept: string[] = []

  let cursor = blockStart
  for (const line of lines) {
    if (AI_FRONTMATTER_KEY.test(line.trim())) {
      findings.push({
        kind: 'doc_property',
        verdict: 'probable',
        offset: cursor,
        length: line.length,
        label: 'AI provenance key in frontmatter',
        evidence: snippet(line),
      })
    } else {
      kept.push(line)
    }
    cursor += line.length + 1
  }

  if (findings.length === 0) return { output: text, findings: [] }

  const rebuilt = `---\n${kept.join('\n')}\n---${match[2] ?? ''}`
  return { output: rebuilt + text.slice(match[0].length), findings }
}
