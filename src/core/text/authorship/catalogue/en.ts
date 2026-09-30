// The English catalogue.
//
// Built almost entirely from lists this codebase already keeps, so that the
// detector, the style report and the rewrite loop read one definition of each
// habit rather than three that drift apart:
//
//   lexicon/en.ts          the marker vocabulary and jargon stylometry counts
//   stylometry.ts          its structure patterns, exported for this
//   humanise.ts SENTENCES  chat residue, signposting, sycophancy
//   rewrite.ts FIX         what a writer does about each metric
//
// Structural ideas (negation pivots, "whether you're X or Y") follow
// the-antislop (MIT), which ranks structure above vocabulary for a reason: a
// find-and-replace defeats a word list and leaves the shape of the argument.

import { JARGON, MARKERS } from '../../lexicon/en.ts'
import {
  APHORISM,
  COPULA_AVOIDANCE,
  FALSE_RANGE,
  NEGATIVE_PARALLELISM,
  RULE_OF_THREE,
  SIGNPOST,
  VAGUE_ATTRIBUTION,
} from '../../stylometry.ts'
import { SENTENCES } from '../../humanise.ts'
import { FIX } from '../../../rewrite.ts'
import { word } from '../segment.ts'
import type { Category, Pattern, Tier } from './types.ts'

const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')

const escape = (phrase: string) =>
  phrase.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("'", "['’]")

const global = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

const lexicon: Pattern[] = [
  ...MARKERS.map((phrase): Pattern => ({
    id: `en.lex.${slug(phrase)}`,
    lang: 'en',
    tier: 2,
    category: 'lexicon',
    pattern: word(escape(phrase)),
    reason: `"${phrase}" turns up far more often in generated prose than in people's writing`,
    fixHint: FIX['marker_vocabulary'] as string,
    samples: [phrase],
    traps: [],
  })),
  ...JARGON.map((phrase): Pattern => ({
    id: `en.lex.${slug(phrase)}`,
    lang: 'en',
    tier: 2,
    category: 'lexicon',
    pattern: word(escape(phrase)),
    reason: `"${phrase}" is business jargon standing in for a concrete claim`,
    fixHint: FIX['business_jargon'] as string,
    samples: [phrase],
    traps: [],
  })),
]

const structure: Pattern[] = [
  {
    id: 'en.struct.negative_parallelism',
    lang: 'en',
    tier: 2,
    category: 'structure',
    pattern: global(NEGATIVE_PARALLELISM),
    reason: '"not just X, but Y" sets up a claim nobody made in order to knock it down',
    fixHint: FIX['negative_parallelism'] as string,
    samples: ['It is not just a tool, but a philosophy.'],
    traps: ['It is not a tool.'],
  },
  {
    id: 'en.struct.rule_of_three',
    lang: 'en',
    tier: 2,
    category: 'structure',
    pattern: global(RULE_OF_THREE),
    reason: 'lists of exactly three, again and again, are a cadence rather than a count',
    fixHint: FIX['rule_of_three'] as string,
    samples: ['It is fast, cheap, and reliable.'],
    traps: ['It is fast and cheap.'],
  },
  {
    id: 'en.struct.vague_attribution',
    lang: 'en',
    tier: 2,
    category: 'structure',
    pattern: global(VAGUE_ATTRIBUTION),
    reason: '"experts say" and "studies show" borrow authority from nobody in particular',
    fixHint: FIX['vague_attribution'] as string,
    samples: ['Experts argue that it matters.'],
    traps: ['Smith (2019) argues that it matters.'],
  },
  {
    id: 'en.struct.signpost',
    lang: 'en',
    tier: 3,
    category: 'structure',
    pattern: global(SIGNPOST),
    reason: 'a sentence that opens by announcing a turn instead of taking it',
    fixHint: FIX['signpost_density'] as string,
    samples: ['It rained. Moreover, it was cold.'],
    traps: ['It rained and it was cold.'],
  },
  {
    id: 'en.struct.copula_avoidance',
    lang: 'en',
    tier: 3,
    category: 'structure',
    pattern: global(COPULA_AVOIDANCE),
    reason: '"serves as" and "boasts" where "is" and "has" would do',
    fixHint: FIX['copula_avoidance'] as string,
    samples: ['The hall serves as a venue.'],
    traps: ['The hall is a venue.'],
  },
  {
    id: 'en.struct.false_range',
    lang: 'en',
    tier: 2,
    category: 'structure',
    pattern: global(FALSE_RANGE),
    reason: '"from X to Y" framing items that do not sit on one scale',
    fixHint: FIX['false_range'] as string,
    samples: ['It covers everything from ancient myths to modern science.'],
    traps: ['The shop is open to everyone.'],
  },
  {
    id: 'en.struct.aphorism',
    lang: 'en',
    tier: 2,
    category: 'structure',
    pattern: global(APHORISM),
    reason: 'an ordinary claim dressed up as a proverb',
    fixHint: FIX['aphorism'] as string,
    samples: ['Data is the lifeblood of growth.'],
    traps: ['Data is useful for growth.'],
  },
  {
    id: 'en.struct.whether_you',
    lang: 'en',
    tier: 1,
    category: 'structure',
    pattern: /\bwhether you(?:['’]re| are) (?:a |an )?[^.!?\n,]{1,40}? or (?:a |an )?/giu,
    reason: '"Whether you\'re X or Y" addresses an imagined audience instead of a reader',
    fixHint: 'say who this is for, or drop the address and make the point',
    samples: ["Whether you're a beginner or an expert, it helps."],
    traps: ['Whether it rains or not, we go.'],
  },
  {
    id: 'en.struct.its_not_its',
    lang: 'en',
    tier: 1,
    category: 'structure',
    pattern:
      /\bit['’]s not (?:just |only |merely )?about [^.!?\n]{1,60}?[,;—–-] ?it['’]s about\b/giu,
    reason: 'the "it\'s not about X, it\'s about Y" pivot, a staple of generated prose',
    fixHint: FIX['negative_parallelism'] as string,
    samples: ["It's not about speed, it's about care."],
    traps: ["It's about care."],
  },
]

/** How each humanise category is read here. */
const FROM_SENTENCES: Record<string, { category: Category; tier: Tier; reason: string }> = {
  'chat pleasantry': {
    category: 'residue',
    tier: 1,
    reason: 'a line addressed to the person in a chat window, left in the document',
  },
  'cutoff disclaimer': {
    category: 'residue',
    tier: 1,
    reason: "a model's disclaimer about its own training data",
  },
  'transcript furniture': {
    category: 'residue',
    tier: 1,
    reason: 'interface text from a chat transcript, copied with the answer',
  },
  sycophancy: {
    category: 'discourse',
    tier: 1,
    reason: 'praise for the question, which only makes sense in a conversation',
  },
  signposting: {
    category: 'discourse',
    tier: 1,
    reason: 'an announcement of what the text is about to do, instead of doing it',
  },
  'gap-filling': {
    category: 'discourse',
    tier: 1,
    reason: 'a stock phrase that fills the place of a fact the writer did not have',
  },
  'generic conclusion': {
    category: 'discourse',
    tier: 2,
    reason: 'a closing line that would end any text on any subject',
  },
}

const FIX_BY_CATEGORY: Record<string, string> = {
  residue: 'delete it; it was never part of the document',
  discourse: 'cut it, or replace it with the specific point it stands in for',
}

const seen = new Set<string>()
const fromSentences: Pattern[] = SENTENCES.flatMap((rule): Pattern[] => {
  const kind = FROM_SENTENCES[rule.what]
  if (!kind) return []
  let id = `en.${kind.category === 'residue' ? 'residue' : 'disc'}.${slug(rule.sample)}`
  while (seen.has(id)) id += '_2'
  seen.add(id)
  // "Certainly!" opens plenty of human dialogue. It only counts at density.
  const tier: Tier = /certainly/i.test(rule.sample) ? 2 : kind.tier
  return [
    {
      id,
      lang: kind.category === 'residue' ? 'any' : 'en',
      tier,
      category: kind.category,
      pattern: global(rule.pattern),
      reason: kind.reason,
      fixHint: FIX_BY_CATEGORY[kind.category] as string,
      samples: [rule.sample],
      traps: [],
      ...(rule.unless ? { unless: rule.unless } : {}),
    },
  ]
})

export const EN: readonly Pattern[] = [...lexicon, ...structure, ...fromSentences]
