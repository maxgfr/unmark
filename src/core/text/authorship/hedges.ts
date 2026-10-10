// Stacked hedges, sentence by sentence and stretch by stretch.
//
// One "could" is a careful writer. Two hedges in one sentence — "cannot be
// directly extrapolated … support the plausibility of" — or five "could" across
// two paragraphs of a discussion, is a habit, and the most frequent one a
// relevé of a thesis found. A phrase list cannot see it: no single phrase is
// the habit, the count is. So it is counted here, per sentence and over a
// window of sentences, and reported as hits of the `hedging` category, which
// weighs nothing in a score until a refit has measured it.
//
// Three shapes:
//
//   stacked        two or more hedges in one sentence
//   contradictory  an assertion ("show that", "montrent que") hedged in the
//                  same sentence ("seems", "semble")
//   dense          three or more hedged sentences among five in a row

import type { Pattern } from './catalogue/types.ts'
import type { Hit } from './features.ts'
import { word, type Lang, type Segmentation } from './segment.ts'

const HEDGE: Record<Lang, RegExp> = {
  en: /\b(?:could|might|may(?! (?:19|20)\d\d)|possibly|potentially|perhaps|presumably|plausib(?:le|ly|ility)|(?:un)?likely|appears? to|appeared to|seems? to|seemed to|suggests? that|suggested that|tends? to|to some extent|cannot be (?:directly )?(?:extrapolated|generali[sz]ed)|in the event of|it is possible that)\b/g,
  fr: word(
    "pourrai(?:t|ent)|pourrait-(?:il|elle|on)|peu(?:t|vent) (?:être )?(?:nécessiter|entraîner|expliquer|favoriser|contribuer|justifier|conduire|refléter|traduire)|possiblement|potentiellement|éventuellement|vraisemblablement|probablement|peut-être|sembl(?:e|ent|erait|eraient|ait|aient)|para(?:î|i)t|paraissent|il est possible qu(?:e|')|susceptibles? d(?:e|')|plausib(?:le|les|ilité)|tendrai(?:t|ent) à|laiss(?:e|ent) (?:penser|supposer)|ne (?:peu(?:t|vent)|saurai(?:t|ent)) (?:pas )?être (?:directement )?(?:extrapolé|généralisé)(?:e|s|es)?|en cas d(?:e|')|a priori".replaceAll(
      "'",
      "['’]",
    ),
  ),
}

/** The modal hedges a "dense" stretch counts: the could/pourrait family. */
const MODAL: Record<Lang, RegExp> = {
  en: /\b(?:could|might|may(?! (?:19|20)\d\d))\b/g,
  fr: word('pourrai(?:t|ent)|sembl(?:e|ent|erait|eraient)'),
}

const ASSERT: Record<Lang, RegExp> = {
  en: /\b(?:shows?|showed|shown|demonstrates?|demonstrated|proves?|proved|confirms?|confirmed) that\b/g,
  fr: word(
    "montr(?:e|ent|aient|ait) qu(?:e|’|')|démontr(?:e|ent) qu(?:e|’|')|prouv(?:e|ent) qu(?:e|’|')|confirm(?:e|ent) qu(?:e|’|')",
  ),
}

const entry = (
  lang: Lang,
  name: string,
  reason: string,
  fixHint: string,
  sample: string,
): Pattern => ({
  id: `${lang}.hedge.${name}`,
  lang,
  tier: 1,
  category: 'hedging',
  pattern: HEDGE[lang],
  reason,
  fixHint,
  samples: [sample],
  traps: [],
})

export const STACKED_HEDGES: Record<
  Lang,
  { stacked: Pattern; contradictory: Pattern; dense: Pattern }
> = {
  en: {
    stacked: entry(
      'en',
      'stacked',
      'several hedges qualify one claim in the same sentence',
      'keep the one hedge the evidence calls for',
      'These data cannot be directly extrapolated but could support it.',
    ),
    contradictory: entry(
      'en',
      'contradictory',
      'the sentence asserts and hedges the same claim',
      'either the data show it or they suggest it; say which',
      'These results show that it seems frequent.',
    ),
    dense: entry(
      'en',
      'dense',
      'hedge after hedge across a few sentences',
      'one hedge per hypothesis; state the rest plainly or cite them',
      'It could rise. It could fall. It might stay.',
    ),
  },
  fr: {
    stacked: entry(
      'fr',
      'stacked',
      'plusieurs précautions qualifient la même affirmation dans une phrase',
      'garder la seule précaution que les données imposent',
      'Ces données ne peuvent être directement extrapolées mais pourraient soutenir la plausibilité du risque.',
    ),
    contradictory: entry(
      'fr',
      'contradictory',
      'la phrase affirme puis atténue la même chose',
      'soit les données le montrent, soit elles le suggèrent : choisir',
      'Ces résultats montrent que l’extériorisation semble fréquente.',
    ),
    dense: entry(
      'fr',
      'dense',
      'précaution sur précaution en quelques phrases',
      'une précaution par hypothèse ; affirmer le reste ou le citer',
      'Cela pourrait jouer. Cela pourrait aussi compter. Il semble que oui.',
    ),
  },
}

const count = (pattern: RegExp, text: string) =>
  [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length

/** How many sentences in a row a dense stretch is read over, and how many hedged. */
const WINDOW = 5
const DENSE = 3

/** Stacked, contradictory and dense hedging, as counted hits of weight 0. */
export function hedgingHits(text: string, seg: Segmentation): Hit[] {
  const hits: Hit[] = []
  const modal: boolean[] = []
  seg.sentences.forEach((sentence, index) => {
    const lang = sentence.lang
    if (!lang) {
      modal.push(false)
      return
    }
    const body = text.slice(sentence.start, sentence.end)
    const hedges = count(HEDGE[lang], body)
    const add = (entry: Pattern) =>
      hits.push({
        entry,
        start: sentence.start,
        end: sentence.end,
        sentence: index,
        counted: true,
        weight: 0,
      })
    if (hedges >= 2) add(STACKED_HEDGES[lang].stacked)
    else if (hedges >= 1 && count(ASSERT[lang], body) >= 1) add(STACKED_HEDGES[lang].contradictory)
    modal.push(count(MODAL[lang], body) >= 1)
  })

  // A stretch of WINDOW sentences of one paragraph or the next, with DENSE of
  // them hedged: each hedged sentence in it is flagged once.
  const dense = new Set<number>()
  for (let at = 0; at < seg.sentences.length; at += 1) {
    const first = seg.sentences[at]
    if (!first) continue
    const window: number[] = []
    for (let k = at; k < Math.min(seg.sentences.length, at + WINDOW); k += 1) {
      const s = seg.sentences[k]
      if (!s || s.paragraphIndex > first.paragraphIndex + 1) break
      if (modal[k]) window.push(k)
    }
    if (window.length >= DENSE) for (const k of window) dense.add(k)
  }
  for (const index of dense) {
    const sentence = seg.sentences[index]
    if (!sentence?.lang) continue
    if (hits.some((hit) => hit.sentence === index)) continue
    hits.push({
      entry: STACKED_HEDGES[sentence.lang].dense,
      start: sentence.start,
      end: sentence.end,
      sentence: index,
      counted: true,
      weight: 0,
    })
  }
  return hits.sort((a, b) => a.start - b.start)
}
