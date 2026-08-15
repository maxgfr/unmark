import { describe, expect, it } from 'vitest'
import { briefToPrompt, buildBrief, extractFacts, verifyRewrite } from './rewrite.ts'

/** Long enough for the style metrics to be allowed to say anything. */
const grow = (template: (i: number) => string, count: number) =>
  Array.from({ length: count }, (_, i) => template(i)).join(' ')

const SLOP = grow(
  (i) =>
    `Let us delve into this rich tapestry — a testament to the ever-evolving landscape of case ${i}. It is not just robust, but seamless. The result is fast, cheap, and reliable — a pivotal, crucial moment.`,
  9,
)

const PLAIN_REWRITE = `The parser reads the central directory first and then seeks to each local
header in turn. Deflate is the only compression method it handles.

A stored entry is copied out byte for byte. The writer zeroes every timestamp
it emits, because a timestamp names a machine and a moment just as an author
field does, and leaving one behind would undo half the work.`

describe('extractFacts', () => {
  it('finds numbers, dates, names, links and quotations', () => {
    const facts = extractFacts(
      'Revenue rose 4.2% in March 2024, and Ada said "we shipped it" — see https://example.com/q1.',
    )
    expect(facts.numbers).toContain('4.2%')
    expect(facts.dates.join(' ')).toContain('March')
    expect(facts.names).toContain('Ada')
    expect(facts.urls).toContain('https://example.com/q1')
    expect(facts.quotes.join('')).toContain('we shipped it')
  })

  it('does not mistake a sentence-initial capital for a name', () => {
    // The false-positive row. Every sentence starts with a capital, so a rule
    // that counted them all would demand the rewrite preserve the first word of
    // every sentence — which is not a fact, it is punctuation.
    expect(extractFacts('The report arrived. Costs fell.').names).not.toContain('Costs')
  })

  it('misses a name that only ever opens a sentence, and that is the trade', () => {
    // Documented rather than hidden. Without a lexicon, "Ada said" at the head
    // of a sentence is the same shape as "Costs fell", and the two rules cannot
    // both be satisfied. Erring towards missing a name costs a check; erring
    // the other way would demand the rewrite keep the first word of every
    // sentence and make the gate impossible to pass.
    expect(extractFacts('The report arrived. Ada signed it.').names).not.toContain('Ada')
  })
})

describe('buildBrief', () => {
  it('names the tells with the layer each belongs to', () => {
    const brief = buildBrief(SLOP)
    expect(brief.tells.length).toBeGreaterThan(0)
    expect(
      brief.tells.every((tell) => ['phrase', 'structure', 'silhouette'].includes(tell.layer)),
    ).toBe(true)
  })

  it('gives every tell something a writer can actually do', () => {
    // Not a substitution — there is no correct replacement for "delve". The
    // brief has to say what to change, not what to change it to.
    for (const tell of buildBrief(SLOP).tells) {
      expect(tell.fix.length).toBeGreaterThan(10)
    }
  })

  it('marks code and blockquotes as protected', () => {
    const brief = buildBrief('Prose.\n\n```js\nconst a = 1\n```\n\n> quoted\n')
    expect(brief.protected.map((span) => span.why).sort()).toEqual([
      'code',
      'someone else being quoted',
    ])
  })

  it('says so when the sample is too short to measure', () => {
    expect(buildBrief('Two words.').measurable).toBe(false)
  })
})

describe('verifyRewrite', () => {
  const brief = buildBrief(SLOP)

  it('rejects a rewrite that is really the same slop', () => {
    const verdict = verifyRewrite(SLOP, SLOP, brief)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((failure) => failure.kind === 'pattern')).toBe(true)
  })

  it('rejects a rewrite that lost a number', () => {
    const source = 'Revenue rose 4.2% in the quarter and costs fell 1.8%.'
    const own = buildBrief(source)
    const verdict = verifyRewrite(source, 'Revenue rose 4.2% in the quarter.', own)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((f) => f.kind === 'fact' && f.what.includes('1.8%'))).toBe(true)
  })

  it('rejects a rewrite that edited a code fence', () => {
    const source = 'Prose here.\n\n```js\nconst a = 1\n```\n'
    const own = buildBrief(source)
    const verdict = verifyRewrite(source, 'Different prose.\n\n```js\nconst a = 2\n```\n', own)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((f) => f.kind === 'protected')).toBe(true)
  })

  it('rejects a rewrite that introduced a pattern the source did not have', () => {
    // Voice never exempts content from the contract. A rewrite is allowed to
    // sound different; it is not allowed to arrive carrying new boilerplate.
    const source = 'The parser reads the central directory first.'
    const own = buildBrief(source)
    const verdict = verifyRewrite(
      source,
      'The parser reads the central directory first. I hope this helps!',
      own,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((f) => f.kind === 'pattern')).toBe(true)
  })

  it('rejects an empty answer rather than accepting it as clean', () => {
    const verdict = verifyRewrite(SLOP, '   ', brief)
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0]?.kind).toBe('empty')
  })

  it('accepts a plain rewrite that kept everything', () => {
    // The row that matters most. A gate that never passes is a gate nobody can
    // use, and it would be indistinguishable from a broken one.
    const source =
      'The parser reads the central directory first, then seeks to each local header. ' +
      'Deflate is the only method it handles. A stored entry is copied verbatim.'
    const own = buildBrief(source)
    const verdict = verifyRewrite(source, PLAIN_REWRITE, own)
    expect(verdict.failures).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('names what failed, so the next attempt can be aimed', () => {
    const verdict = verifyRewrite(SLOP, SLOP, brief)
    for (const failure of verdict.failures) {
      expect(failure.what.length).toBeGreaterThan(0)
      expect(failure.detail.length).toBeGreaterThan(0)
    }
  })
})

describe('briefToPrompt', () => {
  it('carries the tells, the rules and the protected spans', () => {
    const source = 'Prose.\n\n```js\nconst a = 1\n```\n'
    const prompt = briefToPrompt(source, buildBrief(source))
    expect(prompt).toContain('PROTECTED SPANS')
    expect(prompt).toContain('const a = 1')
    expect(prompt).toContain('Return only the rewritten document')
  })

  it('still asks for plainness when nothing was measurable', () => {
    const prompt = briefToPrompt('Short.', buildBrief('Short.'))
    expect(prompt).toContain('none measured')
  })
})

describe('facts a rewrite must not be punished for fixing', () => {
  it('does not read names out of a Title Case heading', () => {
    // Lowering that heading to sentence case is the correct fix. If the brief
    // listed its words as names, verify would reject the very rewrite it asked
    // for — a gate that fails the right answer is worse than no gate.
    const source = '# Strategic Negotiations And Global Partnerships\n\nThe team met in June.'
    expect(buildBrief(source).facts.names).not.toContain('Partnerships')
  })

  it('accepts the sentence-case heading as a valid rewrite', () => {
    const source = '# Strategic Negotiations And Global Partnerships\n\nThe team met the auditor.'
    const brief = buildBrief(source)
    const verdict = verifyRewrite(
      source,
      '# Strategic negotiations and global partnerships\n\nThe team met the auditor.',
      brief,
    )
    expect(verdict.failures.filter((f) => f.kind === 'fact')).toEqual([])
  })

  it('does not count a month as both a date and a name', () => {
    const facts = buildBrief('The board met in March 2024 and approved it.').facts
    expect(facts.dates.join(' ')).toContain('March')
    expect(facts.names).not.toContain('March')
  })
})

// The gate has to fail the wrong answer AND pass the right one. The second half
// is the one that was broken: rejecting on every metric that fired meant an
// ordinary human anecdote failed against itself, because paragraph-length and
// sentence-length variance both trip on plain expository writing. A gate that
// fails the correct answer is unusable, and behind --model it spends money
// doing it.

const HUMAN_LONG = [
  'I got the bike back from the shop yesterday. The mechanic said the bottom bracket was shot, which explains the noise it had been making since about March, and he seemed faintly offended that I had ridden it that long.',
  'I rode it up the hill behind the station this morning and it was fine, quiet even, which I had forgotten was an option. There is still something going on with the rear brake, a sort of delayed bite I notice on the way down.',
  'The other thing I keep meaning to do is replace the saddle. It came with the bike and it was never right, and every winter I decide I will deal with it in the spring, and every spring I decide the saddle is fine.',
  'My friend Tom says I should measure my sit bones. I have not measured my sit bones. It has been four years and the subject comes up about twice a year, usually in a cafe.',
  'The shop has moved twice since I started going there. The current place is further from the station but has better coffee, which the owner insists is a coincidence and nobody believes.',
].join('\n\n')

describe('the gate passes the right answer', () => {
  it('accepts ordinary human prose against itself', () => {
    // Long enough that every metric is allowed to speak, and human enough that
    // none of them should be a rejection.
    const brief = buildBrief(HUMAN_LONG)
    expect(brief.measurable).toBe(true)
    expect(brief.paragraphs).toBeGreaterThanOrEqual(5)

    const verdict = verifyRewrite(HUMAN_LONG, HUMAN_LONG, brief)
    expect(verdict.failures).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('does not read a metric as worse than itself', () => {
    // The reported value is rounded and the baseline was not, so 0.29 < 0.2934
    // made every unchanged metric look like a regression.
    const brief = buildBrief(SLOP)
    const verdict = verifyRewrite(SLOP, SLOP, brief)
    const regressions = verdict.failures.filter((failure) => failure.detail.includes('worse than'))
    expect(regressions).toEqual([])
  })

  it('still rejects the slop it was given', () => {
    const verdict = verifyRewrite(SLOP, SLOP, buildBrief(SLOP))
    expect(verdict.ok).toBe(false)
    expect(verdict.failures.some((f) => f.what.includes('Marker vocabulary'))).toBe(true)
  })

  it('rejects a rewrite that made a structural metric worse', () => {
    // Not beyond reproach — just not a regression. A rewrite that flattens
    // sentence lengths further than the source did is going the wrong way.
    const brief = buildBrief(HUMAN_LONG)
    const flattened = Array.from(
      { length: 14 },
      (_, i) => `The system processed the request for client ${i} in strict order without delay.`,
    ).join(' ')
    const verdict = verifyRewrite(HUMAN_LONG, flattened, brief)
    expect(verdict.ok).toBe(false)
  })

  it('reports a tell it does not reject over', () => {
    // Structure tells the source already had are surfaced through `remaining`
    // so a reader still sees them, without the gate refusing to pass.
    const verdict = verifyRewrite(HUMAN_LONG, HUMAN_LONG, buildBrief(HUMAN_LONG))
    expect(Array.isArray(verdict.remaining)).toBe(true)
  })
})
