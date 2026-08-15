import { describe, expect, it } from 'vitest'
import { humanise, PHRASES, SENTENCES } from './humanise.ts'
import { normaliseTypography } from './typography.ts'

const cp = (...points: number[]) => String.fromCodePoint(...points)
const EM_DASH = cp(0x2014)
const CURLY_OPEN = cp(0x201c)
const CURLY_CLOSE = cp(0x201d)
const APOSTROPHE = cp(0x2019)
const ELLIPSIS = cp(0x2026)
const GUILLEMET_OPEN = cp(0x00ab)
const GUILLEMET_CLOSE = cp(0x00bb)

describe('normaliseTypography', () => {
  it('replaces em and en dashes', () => {
    const result = normaliseTypography(`The report ${EM_DASH} which was late ${EM_DASH} arrived.`)
    expect(result.output).not.toContain(EM_DASH)
    expect(result.output).toBe('The report - which was late - arrived.')
  })

  it('straightens curly quotes and the ellipsis', () => {
    const text = `He said ${CURLY_OPEN}later${CURLY_CLOSE}${ELLIPSIS} and left.`
    expect(normaliseTypography(text).output).toBe('He said "later"... and left.')
  })

  it('leaves French guillemets alone', () => {
    // Correct French punctuation, not a tell. Straightening it would damage
    // real text in exchange for nothing.
    const french = `Il a dit ${GUILLEMET_OPEN} plus tard ${GUILLEMET_CLOSE} puis il est parti.`
    expect(normaliseTypography(french).output).toBe(french)
  })

  it('can restrict itself to the dash family', () => {
    // The apostrophe in l'été is the right character in French. Someone who
    // only wants the dash tell gone should not lose their apostrophes.
    const text = `Le rapport ${EM_DASH} l${APOSTROPHE}${CURLY_OPEN}test${CURLY_CLOSE}`
    const result = normaliseTypography(text, { tellsOnly: true })
    expect(result.output).not.toContain(EM_DASH)
    expect(result.output).toContain(APOSTROPHE)
    expect(result.output).toContain(CURLY_OPEN)
  })

  it('counts each substitution and never calls it more than informational', () => {
    // Punctuation is a style. It is not evidence of anything, and a verdict
    // above informational would say otherwise.
    const result = normaliseTypography(`a ${EM_DASH} b ${EM_DASH} c`)
    expect(result.findings[0]?.label).toContain('2 ×')
    expect(result.findings.every((f) => f.verdict === 'informational')).toBe(true)
    expect(result.findings.every((f) => f.kind === 'typography')).toBe(true)
  })

  it('does nothing to text that is already plain', () => {
    const plain = 'A sentence with "straight quotes" and a - hyphen.'
    const result = normaliseTypography(plain)
    expect(result.output).toBe(plain)
    expect(result.findings).toEqual([])
  })
})

describe('humanise', () => {
  it('shortens filler phrases', () => {
    const result = humanise('In order to proceed, due to the fact that it was late, we stopped.')
    expect(result.output).toBe('To proceed, because it was late, we stopped.')
  })

  it('keeps the leading capital when a sentence starts with the filler', () => {
    expect(humanise('In order to win, train.').output).toBe('To win, train.')
  })

  it('collapses stacked hedges', () => {
    expect(humanise('It could potentially possibly rain.').output).toBe('It could rain.')
  })

  it('deletes a chat pleasantry whole', () => {
    // There is no shorter form of "I hope this helps!" that belongs in a
    // document, so the sentence goes rather than being trimmed.
    const result = humanise('The revenue rose 4%. I hope this helps! Let me know if you need more.')
    expect(result.output.trim()).toBe('The revenue rose 4%.')
    expect(result.findings.some((f) => f.label.includes('chat pleasantry'))).toBe(true)
  })

  it('deletes signposting', () => {
    const result = humanise("Let's dive into caching. Next.js caches at several layers.")
    expect(result.output.trim()).toBe('Next.js caches at several layers.')
  })

  it('deletes a knowledge-cutoff disclaimer', () => {
    const result = humanise('As of my last training update, the figure was 12. It is now 15.')
    expect(result.output.trim()).toBe('It is now 15.')
  })

  it('strips decorative emoji from headings and bullets', () => {
    const result = humanise('## 🚀 Launch\n- ✅ Done\n- 💡 Idea\n')
    expect(result.output).toBe('## Launch\n- Done\n- Idea\n')
  })

  it('leaves emoji in running prose alone', () => {
    // An emoji in a sentence is the writer talking. Only the decorative one at
    // the head of a heading or a bullet is the pattern.
    const prose = 'The build finally passed 🎉 after three days.'
    expect(humanise(prose).output).toBe(prose)
  })

  it('does not touch ordinary prose', () => {
    const plain = 'The mechanic said the bottom bracket was shot, which explains the noise.'
    const result = humanise(plain)
    expect(result.output).toBe(plain)
    expect(result.findings).toEqual([])
  })

  it('leaves the words it has no correct substitute for', () => {
    // "Delve" and "tapestry" have no one right replacement — rewriting the
    // sentence is the fix, and that needs a writer. The stylometry report
    // counts them; this pass must not guess.
    //
    // The fixture used to read "Let us delve into this rich tapestry…", which
    // is two claims in one sentence: it carries the judgement words AND it is a
    // signposting opener. Once signposting learned the spelled-out "let us",
    // the sentence was correctly deleted whole and this test failed for a
    // reason that had nothing to do with what it is about. The claim is
    // unchanged; the fixture now isolates it, and the deletion it used to
    // shadow is asserted on its own further down.
    const flowery = 'The report describes a rich tapestry of pivotal moments to delve into.'
    expect(humanise(flowery).output).toBe(flowery)
  })

  it('reports what it changed', () => {
    const result = humanise('In order to proceed. I hope this helps.')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings.every((f) => f.kind === 'ai_phrase')).toBe(true)
  })
})

describe('sentence-start anchoring', () => {
  it('removes a sycophantic opener that is not the first thing in the document', () => {
    // The first draft anchored these to ^, meaning start of *string* — so
    // "Great question!" was only ever caught when it opened the whole file,
    // which it never does.
    const result = humanise('Some context here.\n\nGreat question! The answer is 12.')
    expect(result.output).not.toContain('Great question')
    expect(result.output).toContain('The answer is 12.')
  })

  it('keeps "a great question" where the phrase is the content', () => {
    const sentence = 'That is a great question to put to the committee.'
    expect(humanise(sentence).output).toBe(sentence)
  })

  it('collapses the blank lines a removed paragraph leaves behind', () => {
    const result = humanise('First.\n\nI hope this helps!\n\nSecond.')
    expect(result.output).not.toMatch(/\n{3,}/)
    expect(result.output).toContain('First.')
    expect(result.output).toContain('Second.')
  })

  it('does not collapse a deliberate paragraph break', () => {
    const text = 'First paragraph.\n\nSecond paragraph.'
    expect(humanise(text).output).toBe(text)
  })
})

// The eval contract: every pattern below carries a row that must fire and a row
// that must not. The false-positive rows are the point of the exercise — a rule
// table with no negatives passes every test and quietly damages real documents.

describe('humanise: sealed regions', () => {
  it('does not edit inside a fenced code block', () => {
    const text = 'Prose in order to run.\n\n```sh\n# in order to build\nmake\n```\n'
    const { output } = humanise(text)
    expect(output).toContain('# in order to build')
    expect(output).toContain('Prose to run.')
  })

  it('does not flatten Markdown indentation', () => {
    // The whitespace tidy used to run over the whole document, so every nested
    // list and indented code block in the file came out flattened by a pass
    // that was supposed to be cleaning up after its own deletion.
    const text = [
      'Steps, in order to build:',
      '',
      '- one',
      '    - nested one',
      '        - nested two',
      '',
      '    const indented = true',
      '',
      'Done.',
    ].join('\n')
    const { output } = humanise(text)
    expect(output).toContain('    - nested one')
    expect(output).toContain('        - nested two')
    expect(output).toContain('    const indented = true')
    expect(output).toContain('Steps, to build:')
  })

  it('does not edit inside a blockquote', () => {
    const text = '> I hope this helps, they wrote.\n\nOur own text.'
    expect(humanise(text).output).toBe(text)
  })

  it('does not edit inside a quotation', () => {
    const text = 'The memo said "let us dive into the numbers" and stopped there.'
    expect(humanise(text).output).toBe(text)
  })

  it('does not edit a URL that contains a rule phrase', () => {
    const text = 'See https://example.com/in-order-to-win for the writeup.'
    expect(humanise(text).output).toBe(text)
  })
})

describe('humanise: offsets address the original document', () => {
  it('points a deletion finding at the sentence in the input', () => {
    // Offsets used to index a buffer that had already been mutated, so by the
    // time a caller read them they addressed a document that no longer existed
    // — and they were then sorted against cleanText's, which do address the
    // original.
    const text = 'Revenue rose 4%. I hope this helps. Costs fell 2%.'
    const finding = humanise(text).findings.find((f) => f.label.includes('chat pleasantry'))
    expect(finding).toBeDefined()
    expect(text.slice(finding!.offset, finding!.offset + finding!.length)).toContain(
      'I hope this helps.',
    )
  })

  it('keeps later offsets correct after an earlier deletion', () => {
    const text = 'Great question. Revenue rose. I hope this helps. Costs fell.'
    const findings = humanise(text).findings.filter((f) => f.verdict === 'probable')
    for (const finding of findings) {
      expect(
        text.slice(finding.offset, finding.offset + finding.length).trim().length,
      ).toBeGreaterThan(0)
    }
  })
})

describe('humanise: new rules', () => {
  const out = (text: string) => humanise(text).output

  it('shortens an inflated verb', () => {
    expect(out('We utilize the report.')).toBe('We use the report.')
  })

  it('leaves financial leverage alone', () => {
    // The collocation guard. "leverage" is filler as a verb and a real word as
    // a noun, and a rule with no guard damages the second.
    expect(out('The firm reduced its financial leverage.')).toBe(
      'The firm reduced its financial leverage.',
    )
  })

  it('drops the bold from an inline-header bullet but keeps the label', () => {
    expect(out('- **Performance:** faster now')).toBe('- Performance: faster now')
  })

  it('leaves bold in the middle of a bullet alone', () => {
    expect(out('- the **fast** path')).toBe('- the **fast** path')
  })

  it('drops a hyphen from a compound after the noun', () => {
    expect(out('The report is high-quality.')).toBe('The report is high quality.')
  })

  it('keeps the hyphen when the compound comes before the noun', () => {
    expect(out('It is a high-quality report.')).toBe('It is a high-quality report.')
  })

  it('lowers a Title Case heading to sentence case', () => {
    expect(out('## Strategic Negotiations And Global Partnerships')).toBe(
      '## Strategic negotiations and global partnerships',
    )
  })

  it('keeps a name capitalised in a heading', () => {
    const text = '## Negotiations With Microsoft Today\n\nWe met Microsoft in June.'
    expect(out(text)).toContain('## Negotiations with Microsoft today')
  })

  it('leaves a short heading alone', () => {
    expect(out('## Two Words')).toBe('## Two Words')
  })

  it('deletes a generic positive conclusion', () => {
    expect(out('Revenue fell. The future looks bright.').trim()).toBe('Revenue fell.')
  })

  it('deletes transcript furniture', () => {
    expect(out('You said:\nWhat is the revenue?').trim()).toBe('What is the revenue?')
  })

  it('deletes a signposting sentence', () => {
    expect(out('Let us take a closer look. Revenue fell.').trim()).toBe('Revenue fell.')
  })

  it('deletes an authority trope without eating the clause', () => {
    // And leaves the sentence starting with a capital. This used to assert
    // `'revenue fell.'`, which codified the defect: a pass that claims to make
    // only changes with one right answer cannot hand back a sentence that
    // starts in lower case.
    expect(out('Make no mistake, revenue fell.')).toBe('Revenue fell.')
  })

  it('leaves an authority trope alone in the middle of a sentence', () => {
    // Unanchored, these gutted mid-sentence usage and stranded the comma:
    // 'The design is, fundamentally, sound.' came out as 'The design is, sound.'
    expect(out('The design is, fundamentally, sound.')).toBe('The design is, fundamentally, sound.')
    expect(out('The problem, at its core, is money.')).toBe('The problem, at its core, is money.')
  })

  it('dehyphenates every hyphen in a predicate compound, not just the first', () => {
    // 'end-to-end' has two. Replacing one produced 'end to-end', which is not a
    // shorter form of anything.
    expect(out('The pipeline is end-to-end.')).toBe('The pipeline is end to end.')
  })

  it('leaves ordinary technical prose untouched', () => {
    // The single most important negative in this file. If a plain paragraph is
    // edited at all, every rule above is suspect.
    const text =
      'The parser reads the central directory first, then seeks to each local header. ' +
      'Deflate is the only method it handles, because that is the only one the format ' +
      'requires. A stored entry is copied verbatim.'
    expect(out(text)).toBe(text)
  })

  it('leaves French prose untouched', () => {
    const text = "Le rapport a ete envoye avant la reunion, mais personne ne l'a lu."
    expect(out(text)).toBe(text)
  })
})

describe('normaliseTypography: sealed regions', () => {
  it('does not straighten a curly quote inside a fenced code block', () => {
    // A JSON snippet whose quotes get flattened is a snippet that no longer
    // parses. This is the reason the pass consults the region map at all.
    const text = `Prose ${EM_DASH} here.\n\n\`\`\`json\n{ "k": ${CURLY_OPEN}v${CURLY_CLOSE} }\n\`\`\`\n`
    const { output } = normaliseTypography(text)
    expect(output).toContain(`{ "k": ${CURLY_OPEN}v${CURLY_CLOSE} }`)
    expect(output).toContain('Prose - here.')
  })

  it('does not straighten a quote inside an inline code span', () => {
    const text = `Run \`echo ${CURLY_OPEN}hi${CURLY_CLOSE}\` now.`
    expect(normaliseTypography(text).output).toBe(text)
  })

  it('still straightens a curly quote inside a quotation', () => {
    // The important negative for the guard itself. Quotations are sealed
    // against rewriting words, not against normalising characters — sealing
    // them here would leave the pass with nothing to normalise anywhere.
    const text = `He said ${CURLY_OPEN}on track${CURLY_CLOSE} and left.`
    expect(normaliseTypography(text).output).toBe('He said "on track" and left.')
  })

  it('does not touch a hyphen inside a URL', () => {
    const text = `See https://example.com/a${cp(0x2013)}b for more.`
    expect(normaliseTypography(text).output).toBe(text)
  })
})

// The guard for the failure that started this round.
//
// A rule table is where a dead pattern hides best: the code reads correctly,
// the tests around it pass, and one entry silently never matches anything. That
// is what `(?:w14?|w15|cp|dc|xmp)?` did in the DOCX handler — it reads as a list
// of namespace prefixes and means "w1 followed by an optional 4", so `w:author`
// was never matched and every tracked change kept its author through a clean
// that reported success.
//
// Each rule now carries a frozen `sample` of the phrase it is for, and the
// sample stops moving when the pattern does. Sabotaging `\bin order to\b` into
// `\b(?:in1|in2) order to\b` fails here with `!~ in order to` rather than
// shipping, and the original DOCX regex would have failed the same way against
// a sample of ` w:author="Jane"`.
//
// The one thing it cannot do is prove a pattern was right when it was written:
// a sample copied out of a pattern agrees with it by construction. **Write the
// sample from what the rule is meant to catch, not from what the regex says.**

const withoutFlags = (pattern: RegExp) =>
  new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/g, ''))

describe('no rule in the tables is dead', () => {
  it('every rule carries a sample', () => {
    const missing = [...PHRASES, ...SENTENCES].filter((rule) => !rule.sample?.trim())
    expect(missing.map((rule) => rule.pattern.source)).toEqual([])
  })

  it('every phrase rule still matches its own sample', () => {
    const broken = PHRASES.filter((rule) => !withoutFlags(rule.pattern).test(rule.sample))
    expect(broken.map((rule) => `${rule.pattern.source} !~ ${rule.sample}`)).toEqual([])
  })

  it('every sentence rule still matches its own sample', () => {
    const broken = SENTENCES.filter((rule) => !withoutFlags(rule.pattern).test(rule.sample))
    expect(broken.map((rule) => `${rule.pattern.source} !~ ${rule.sample}`)).toEqual([])
  })

  it('every phrase rule actually changes the document it fires on', () => {
    // Matching is not enough. A rule whose replacement equals what it matched
    // does nothing while looking busy — the same failure wearing a different hat.
    const inert = PHRASES.filter((rule) => humanise(rule.sample).output === rule.sample)
    expect(inert.map((rule) => rule.pattern.source)).toEqual([])
  })

  it('every sentence rule removes the sentence it fires on', () => {
    const survived = SENTENCES.filter((rule) => {
      // On its own line, because several of these are anchored to a line start
      // on purpose: transcript furniture is only furniture when it opens a line,
      // and "You said:" mid-sentence is somebody being quoted.
      const { output } = humanise(
        `The figure was 12.\n${rule.sample} rest of it.\nAnd this stands.`,
      )
      return output.includes(rule.sample)
    })
    expect(survived.map((rule) => rule.pattern.source)).toEqual([])
  })

  it('no two rules share a sample, which would hide one behind the other', () => {
    const samples = [...PHRASES, ...SENTENCES].map((rule) => rule.sample)
    const duplicates = samples.filter((sample, index) => samples.indexOf(sample) !== index)
    expect([...new Set(duplicates)]).toEqual([])
  })
})
