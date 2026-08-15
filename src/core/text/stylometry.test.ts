import { describe, expect, it } from 'vitest'
import {
  analyzeStyle,
  distinctSignals,
  MIN_SENTENCES,
  MIN_WORDS,
  stylometryFindings,
} from './stylometry.ts'

const triggered = (text: string) =>
  analyzeStyle(text)
    .metrics.filter((m) => m.triggered)
    .map((m) => m.id)

// ~190 words. Uneven sentences, one em dash, no marker vocabulary. This is the
// sample that matters: a stylometry module is only worth shipping if it stays
// quiet here.
const HUMAN = `I got the bike back from the shop yesterday. The mechanic said the bottom
bracket was shot, which explains the noise it had been making since about
March, and he seemed faintly offended that I had ridden it that long. Fixed
now. Cost more than I wanted it to.

I rode it up the hill behind the station this morning and it was fine — quiet,
even, which I had forgotten was an option. There is still something going on
with the rear brake, a sort of delayed bite that I notice on the way down more
than on the flat, but that can wait until the weather turns and I stop using it
every day.

The other thing I keep meaning to do is replace the saddle. It came with the
bike and it was never right, and every winter I decide I will deal with it in
the spring, and every spring I decide the saddle is fine actually. I assume
this will continue. My friend Tom says I should measure my sit bones. I have
not measured my sit bones. It has been four years.`

/** Repeat a template until the sample is long enough to measure. */
const grow = (template: (i: number) => string, count: number) =>
  Array.from({ length: count }, (_, i) => template(i)).join(' ')

describe('sample size', () => {
  it('refuses to judge a sample too short to measure', () => {
    // One em dash in twelve words extrapolates to 83 per 1000. That is not a
    // signal, it is a division. Reporting it would be inventing evidence.
    expect(triggered('A short line — with one dash in it.')).toEqual([])
  })

  it('says how much text it needed', () => {
    const report = analyzeStyle('Too short — by far.')
    expect(report.words).toBeLessThan(MIN_WORDS)
    expect(report.measurable).toBe(false)
  })

  it('measures once there is enough text', () => {
    expect(analyzeStyle(HUMAN).measurable).toBe(true)
  })
})

describe('analyzeStyle', () => {
  it('finds nothing worth reporting in ordinary human prose', () => {
    expect(triggered(HUMAN)).toEqual([])
  })

  it('counts em dashes per thousand words', () => {
    const dashes = grow(
      (i) =>
        `The report was clear — the numbers had moved — and nobody wanted to say so, case ${i}.`,
      14,
    )
    expect(triggered(dashes)).toContain('em_dash')
  })

  it('catches negative parallelism', () => {
    const text = grow(
      (i) =>
        `It is not just a tool, but a philosophy for case ${i}. This is not merely a change, but a transformation of how the team works day to day.`,
      8,
    )
    expect(triggered(text)).toContain('negative_parallelism')
  })

  it('catches the rule of three', () => {
    const text = grow(
      (i) =>
        `The system is fast, cheap, and reliable in region ${i}. The design is clean, modern, and accessible to everyone who needs it.`,
      8,
    )
    expect(triggered(text)).toContain('rule_of_three')
  })

  it('catches marker vocabulary', () => {
    const text = grow(
      (i) =>
        `Let us delve into this rich tapestry of options ${i}. It is a testament to the ever-evolving landscape, a pivotal moment in the realm of seamless, cutting-edge design.`,
      7,
    )
    expect(triggered(text)).toContain('marker_vocabulary')
  })

  it('reports low sentence-length variance, which is the machine tell', () => {
    // Humans write a two-word sentence and then a forty-word one. Models
    // converge on the mean.
    const uniform = grow(
      (i) => `The system processes each incoming request in strict order for client ${i}.`,
      24,
    )
    expect(triggered(uniform)).toContain('burstiness')
  })

  it('does not judge variance it cannot measure', () => {
    // A handful of sentences is not a sample, even when the words add up.
    const fewSentences = `${grow((i) => `word${i}`, 200)}. And a second one here.`
    const report = analyzeStyle(fewSentences)
    expect(report.sentences).toBeLessThan(MIN_SENTENCES)
    expect(triggered(fewSentences)).not.toContain('burstiness')
  })

  it('survives empty and whitespace-only input', () => {
    expect(analyzeStyle('').metrics.every((m) => !m.triggered)).toBe(true)
    expect(analyzeStyle('   \n  ').words).toBe(0)
  })

  it('counts words and sentences', () => {
    const report = analyzeStyle('One two three. Four five!')
    expect(report.words).toBe(5)
    expect(report.sentences).toBe(2)
  })
})

describe('stylometryFindings', () => {
  const LOADED = grow(
    (i) =>
      `Let us delve into this rich tapestry — a testament to the ever-evolving landscape of case ${i}. It is not just robust, but seamless. The result is fast, cheap, and reliable — a pivotal, crucial moment.`,
    9,
  )

  it('never returns a confirmed verdict', () => {
    // Style is not evidence. A tool that says "confirmed: written by AI" on the
    // strength of an em-dash count is lying, and every one of these metrics is
    // something a human writer legitimately does.
    const findings = stylometryFindings(LOADED)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.verdict !== 'confirmed')).toBe(true)
  })

  it('raises its confidence only when several tells co-occur', () => {
    const many = stylometryFindings(LOADED)
    expect(many.length).toBeGreaterThanOrEqual(3)
    expect(many.every((f) => f.verdict === 'probable')).toBe(true)

    const one = stylometryFindings(
      grow(
        (i) => `The report was clear — the numbers had moved — and nobody said so, case ${i}.`,
        14,
      ),
    )
    expect(one.every((f) => f.verdict === 'informational')).toBe(true)
  })

  it('is silent on clean prose', () => {
    expect(stylometryFindings(HUMAN)).toEqual([])
  })

  it('produces only findings that a clean pass will never remove', () => {
    expect(stylometryFindings(LOADED).every((f) => f.kind === 'stylometry')).toBe(true)
  })
})

// The eval contract: each new metric gets a document that must trigger it and a
// document that must not. HUMAN above is the standing negative for all of them
// — the suite is only worth having if that sample stays silent.

describe('layers', () => {
  it('labels every metric with a layer and a signal', () => {
    for (const metric of analyzeStyle(HUMAN).metrics) {
      expect(['phrase', 'structure', 'silhouette']).toContain(metric.layer)
      expect(metric.signal.length).toBeGreaterThan(0)
    }
  })

  it('counts one habit once, however many metrics read it', () => {
    // Three metrics measuring the same em dashes are one tell. Letting each
    // vote would turn a single character into a "pattern" of three.
    const dashes = grow(
      (i) => `The report was clear — the numbers had moved — nobody said so, case ${i}.`,
      14,
    )
    const metrics = analyzeStyle(dashes).metrics.filter((m) => m.triggered)
    const dashMetrics = metrics.filter((m) => m.signal === 'em_dash')
    expect(dashMetrics.length).toBeGreaterThanOrEqual(2)
    expect(distinctSignals(metrics)).toBeLessThan(metrics.length)
  })
})

describe('phrase layer', () => {
  it('catches business jargon', () => {
    const text = grow(
      (i) =>
        `The team will circle back on best practices for region ${i}. We must move the needle and drive value through actionable insights.`,
      8,
    )
    expect(triggered(text)).toContain('business_jargon')
  })

  it('does not fire on a sentence that happens to mention practice', () => {
    const text = grow(
      (i) => `The rider practised on the hill behind the station most mornings in week ${i}.`,
      16,
    )
    expect(triggered(text)).not.toContain('business_jargon')
  })

  it('catches attribution with nobody behind it', () => {
    const text = grow(
      (i) => `Experts argue the figure is wrong in case ${i}. Studies show the opposite.`,
      12,
    )
    expect(triggered(text)).toContain('vague_attribution')
  })

  it('does not fire when the source is named', () => {
    const text = grow(
      (i) => `The Institute of Statistics published the figure for year ${i} in its annual return.`,
      14,
    )
    expect(triggered(text)).not.toContain('vague_attribution')
  })
})

describe('structure layer', () => {
  it('catches a paragraph stuffed with dashes that a document-wide rate would average away', () => {
    // The whole point of the per-paragraph rule. One dense paragraph inside a
    // long clean document does not move the per-1000-words figure at all.
    const clean = grow((i) => `A plain sentence about the work in week ${i}.`, 90)
    const text = `${clean}\n\nThe report — late again — arrived — and nobody read it.\n\n${clean}`
    const ids = triggered(text)
    expect(ids).toContain('em_dash_paragraph')
    expect(ids).not.toContain('em_dash')
  })

  it('does not fire on a paragraph with a single dash', () => {
    const text = `${grow((i) => `A plain sentence about the work in week ${i}.`, 40)}\n\nThe report — late — arrived.`
    expect(triggered(text)).not.toContain('em_dash_paragraph')
  })

  it('catches sentences that all open with a transition', () => {
    const text = grow(
      (i) =>
        `However, the figure moved in month ${i}. Moreover, nobody noticed. Furthermore, the report was late. Ultimately, it did not matter.`,
      6,
    )
    expect(triggered(text)).toContain('signpost_density')
  })

  it('does not fire on prose with one however in it', () => {
    const text = grow((i) => `The figure moved in month ${i} and nobody noticed at all.`, 18)
    expect(`${text} However, it did not matter.`).toBeTruthy()
    expect(triggered(`${text} However, it did not matter.`)).not.toContain('signpost_density')
  })

  it('catches a run of short sentences manufacturing drama', () => {
    const text = `${grow((i) => `The system processed the request for client ${i} without any delay.`, 20)} Then it stopped. No warning. No log. Nothing at all.`
    expect(triggered(text)).toContain('staccato')
  })

  it('does not fire on one short sentence used for emphasis', () => {
    const text = `${grow((i) => `The system processed the request for client ${i} without any delay.`, 20)} Then it stopped.`
    expect(triggered(text)).not.toContain('staccato')
  })

  it('catches copula avoidance', () => {
    const text = grow(
      (i) =>
        `The gallery serves as the main space in city ${i}. It boasts four rooms and features a courtyard. The wing represents a later addition.`,
      7,
    )
    expect(triggered(text)).toContain('copula_avoidance')
  })

  it('catches an aphorism formula', () => {
    const text = grow(
      (i) => `Symmetry is the language of trust in design ${i}. Efficiency becomes a trap.`,
      12,
    )
    expect(triggered(text)).toContain('aphorism')
  })

  it('catches paragraphs cut to one length', () => {
    const paragraph = (i: number) =>
      `The team reviewed the report for region ${i} and confirmed that the totals matched the ledger held by the finance group at the close of the quarter.`
    const text = Array.from({ length: 6 }, (_, i) => paragraph(i)).join('\n\n')
    expect(triggered(text)).toContain('paragraph_variance')
  })

  it('does not judge paragraph length across too few paragraphs', () => {
    // Three paragraphs will look either uniform or varied depending on which
    // three they are, which is not a measurement.
    expect(triggered(HUMAN)).not.toContain('paragraph_variance')
    expect(analyzeStyle(HUMAN).paragraphs).toBeLessThan(5)
  })
})

// Long enough to clear MIN_WORDS: the module is right to refuse a short sample,
// so a fixture that tests anything else has to get past that floor first.
const RECAP_BODY = [
  'The parser reads the central directory before it seeks to any local header entry, because the directory is the only place the archive states what it really contains.',
  'Deflate is the only compression method the reader handles anywhere in the archive, and an entry stored with anything else raises rather than returning half a file.',
  'A stored entry is copied verbatim into the output without any further processing at all, which is what keeps the mimetype entry of an open document format legal.',
  'The writer zeroes every timestamp it emits, because a timestamp is metadata exactly like an author name, and leaving it behind would undo half of the work.',
].join('\n\n')

describe('silhouette layer', () => {
  it('catches a closing paragraph that recaps the ones above it', () => {
    const recap =
      'The parser reads the central directory, handles deflate compression, copies stored entries verbatim, and zeroes every timestamp in every single archive that it writes out anywhere.'
    expect(triggered(`${RECAP_BODY}\n\n${recap}`)).toContain('recap_loop')
  })

  it('does not fire when the last paragraph says something new', () => {
    const ending =
      'Encryption remains unsupported, and a password-protected archive raises immediately rather than returning half a document to whoever happened to ask for it.'
    expect(triggered(`${RECAP_BODY}\n\n${ending}`)).not.toContain('recap_loop')
  })

  it('catches paragraphs built to one internal template', () => {
    const paragraph = (i: number) =>
      `Caching improves latency in service ${i} by keeping recent answers close to the caller. For example, a lookup that took forty milliseconds now takes two. However, a stale entry can be worse than a slow one.`
    const text = Array.from({ length: 5 }, (_, i) => paragraph(i)).join('\n\n')
    expect(triggered(text)).toContain('paragraph_template')
  })

  it('does not fire on paragraphs that happen to contain an example', () => {
    const text = [
      'Caching keeps recent answers close to the caller and cuts the round trip out of the common path entirely.',
      'For example, a lookup that took forty milliseconds now takes two, which is the whole reason anyone bothers.',
      'A stale entry can be worse than a slow one, and the invalidation rules are where most of the bugs live.',
      'The team measured the hit rate for a week before turning it on for everyone in the London office.',
      'Nobody has changed the eviction policy since, which is either confidence or nobody wanting to touch it.',
    ].join('\n\n')
    expect(triggered(text)).not.toContain('paragraph_template')
  })

  it('catches a generic outline', () => {
    const section = (name: string, i: number) =>
      `## ${name}\n\nThe report covers the material for section ${i} in the detail the reader needs to follow the argument through, with the figures set beside the text rather than collected at the end where nobody ever reads them.`
    const text = ['Introduction', 'Background', 'Challenges', 'Future Outlook', 'Conclusion']
      .map((name, i) => section(name, i))
      .join('\n\n')
    expect(triggered(text)).toContain('generic_outline')
  })

  it('does not fire on headings that name their subject', () => {
    const section = (name: string, i: number) =>
      `## ${name}\n\nThe report covers the material for section ${i} in the detail the reader needs to follow the argument through, with the figures set beside the text rather than collected at the end where nobody ever reads them.`
    const text = [
      'Central directory layout',
      'Deflate and stored entries',
      'Timestamp zeroing',
      'What the reader refuses',
      'Encrypted archives',
    ]
      .map((name, i) => section(name, i))
      .join('\n\n')
    expect(triggered(text)).not.toContain('generic_outline')
  })
})

describe('measuring prose only', () => {
  it('does not count a fenced code block as sentences', () => {
    // A document that is half code would otherwise have its sentence
    // statistics decided by its code.
    const text = 'One sentence here.\n\n```js\nconst a = 1; const b = 2; const c = 3;\n```\n'
    expect(analyzeStyle(text).words).toBe(wordsOf('One sentence here.'))
  })
})

const wordsOf = (text: string) => [...text.matchAll(/[\p{L}\p{N}'’-]+/gu)].length
