import { describe, expect, it } from 'vitest'
import { analyzeStyle } from './stylometry.ts'

// Every metric value, frozen.
//
// `verifyRewrite` compares a rewrite's metrics against the original's, so a
// refactor that nudges any value moves the rewrite gate without a single test
// about rewriting going red. This file is the tripwire: it was recorded before
// the lexicon moved out and `styleHits` went in, and it must not change unless
// a metric is changed on purpose.

const grow = (template: (i: number) => string, count: number) =>
  Array.from({ length: count }, (_, i) => template(i)).join(' ')

const SAMPLES: Record<string, string> = {
  human: `I got the bike back from the shop yesterday. The mechanic said the bottom
bracket was shot, which explains the noise it had been making since about
March, and he seemed faintly offended that I had ridden it that long. Fixed
now. Cost more than I wanted it to.

I rode it up the hill behind the station this morning and it was fine — quiet,
even, which I had forgotten was an option. There is still something going on
with the rear brake, a sort of delayed bite that I notice on the way down more
than on the flat, but that can wait until the weather turns and I stop using it
every day.`,
  loaded: grow(
    (i) =>
      `Let us delve into this rich tapestry — a testament to the ever-evolving landscape of case ${i}. It is not just robust, but seamless. The result is fast, cheap, and reliable — a pivotal, crucial moment.`,
    9,
  ),
  signposts: grow(
    (i) =>
      `However, the plan held for team ${i}. Moreover, it's worth noting that experts say the budget serves as a guide. Furthermore, in today's fast-paced world we must circle back and move the needle. Ultimately, from the smallest detail to the grandest vision, data is the lifeblood of growth.`,
    6,
  ),
  markdown: [
    '---',
    'title: Notes',
    '---',
    '',
    '# Introduction',
    '',
    `${grow((i) => `The İstanbul office leverages robust tooling for release ${i}, and it boasts a seamless pipeline.`, 5)}`,
    '',
    '## Overview',
    '',
    '```js',
    'const delve = "tapestry" // leverage, robust, seamless',
    '```',
    '',
    '> Quoted: moreover, furthermore, a pivotal moment.',
    '',
    '- A list item that is fast, cheap, and good.',
    '- Another — with a dash.',
    '',
    '## Conclusion',
    '',
    `${grow((i) => `In conclusion, the office ${i} is not only fast but it's also calm. Short one. Tiny. Done.`, 4)}`,
  ].join('\n'),
  crlf: grow(
    (i) =>
      `Paragraph ${i} says the thing plainly and then stops, which is fine.\r\nIt is not merely a note, but a record of the day.\r\n\r\n`,
    12,
  ),
}

const round = (value: number) => (Number.isNaN(value) ? 'NaN' : Math.round(value * 1e6) / 1e6)

describe('stylometry values', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`are unchanged on the ${name} sample`, () => {
      const report = analyzeStyle(text)
      expect({
        words: report.words,
        sentences: report.sentences,
        paragraphs: report.paragraphs,
        measurable: report.measurable,
        metrics: Object.fromEntries(
          report.metrics.map((m) => [m.id, `${round(m.value)}${m.triggered ? ' !' : ''}`]),
        ),
      }).toMatchSnapshot()
    })
  }
})
