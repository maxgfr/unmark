// The phrases `--humanise` rewrites, read by `detect` too.
//
// One catalogue for both passes: a habit the clean pass knows how to fix and
// the detector does not count is a habit the reader is told about in one
// place and not the other. The relevé of a thesis found stacked hedges to be
// its most frequent habit, and `detect` had counted none of them while
// `--humanise` listed them all.
//
// These entries are found, located and reported, and weigh nothing in a
// score (see UNWEIGHTED in types.ts): the calibration was fitted without them.
// French gets its own stacked-hedge phrases here; the sentence-level stacking
// detector lives in hedges.ts.

import { PHRASES } from '../../humanise.ts'
import { word } from '../segment.ts'
import type { Pattern } from './types.ts'

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')

const global = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)

const REASON: Record<string, string> = {
  'stacked hedge': 'two hedges where one would do: the claim is qualified twice over',
  filler: 'a longer way of saying something a shorter phrase says exactly',
  'inflated word': 'an inflated word with one plain equivalent',
  'authority trope': 'a phrase that claims depth or candour instead of showing it',
  'fake-candid hook': 'a hook that stages a confession or a reveal before the point',
}

const seen = new Set<string>()
const fromPhrases: Pattern[] = PHRASES.map((rule): Pattern => {
  const hedge = rule.what === 'stacked hedge'
  let id = `en.${hedge ? 'hedge' : 'phrase'}.${slug(rule.sample)}`
  while (seen.has(id)) id += '_2'
  seen.add(id)
  return {
    id,
    lang: 'en',
    tier: 1,
    category: hedge ? 'hedging' : 'phrasing',
    pattern: global(rule.pattern),
    reason: REASON[rule.what] ?? 'a phrase the humanise pass rewrites',
    fixHint: rule.to ? `write "${rule.to}"` : 'cut it; the sentence stands without it',
    samples: [rule.sample],
    traps: [],
    ...(rule.unless ? { unless: rule.unless } : {}),
  }
})

/** `'` in a source stands for either apostrophe. */
const fr = (source: string) => word(source.replaceAll("'", "['’]"))

const french = (
  name: string,
  source: string,
  sample: string,
  to: string,
  traps: string[] = [],
) => ({
  id: `fr.hedge.${name}`,
  lang: 'fr' as const,
  tier: 1 as const,
  category: 'hedging' as const,
  pattern: fr(source),
  reason: REASON['stacked hedge'] as string,
  fixHint: to ? `write "${to}"` : 'keep one hedge, the one the evidence calls for',
  samples: [sample],
  traps,
})

const FRENCH: Pattern[] = [
  french(
    'pourrait_potentiellement',
    '(?:pourrai(?:t|ent)|peu(?:t|vent)) (?:potentiellement|éventuellement|possiblement|peut-être)',
    'cela pourrait potentiellement expliquer',
    'pourrait',
    ['cela pourrait expliquer'],
  ),
  french(
    'il_semblerait_que',
    'il semblerait (?:donc |ainsi )?que',
    'il semblerait que le risque baisse',
    'le risque semble baisser',
    ['il semble que le risque baisse'],
  ),
  french(
    'il_est_possible_que_pourrait',
    "il est (?:possible|envisageable|probable) qu(?:e |')[^.!?\\n]{1,60}?pourrai(?:t|ent)",
    'il est possible que ce mécanisme pourrait jouer',
    'ce mécanisme pourrait jouer',
    ['il est possible que ce mécanisme joue'],
  ),
  french(
    'semble_potentiellement',
    'sembl(?:e|ent|erait|eraient) (?:potentiellement|éventuellement|possiblement)',
    'le risque semble potentiellement faible',
    'semble',
  ),
  french(
    'potentiellement_la_plus',
    'potentiellement (?:la|le|les) plus',
    'la conséquence potentiellement la plus préoccupante',
    'la principale',
    ['la conséquence la plus préoccupante'],
  ),
]

const ENGLISH: Pattern[] = [
  {
    id: 'en.hedge.potentially_most',
    lang: 'en',
    tier: 1,
    category: 'hedging',
    pattern: /\bpotentially (?:the )?most\b/gi,
    reason: REASON['stacked hedge'] as string,
    fixHint: 'write "the main"',
    samples: ['The potentially most concerning consequence'],
    traps: ['The most concerning consequence'],
  },
]

export const HEDGING: readonly Pattern[] = [...fromPhrases, ...FRENCH, ...ENGLISH]
