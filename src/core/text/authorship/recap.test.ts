import { describe, expect, it } from 'vitest'
import { detectAuthorship } from './index.ts'

const doc = (sections: Record<string, string>) =>
  Object.entries(sections)
    .map(([title, body]) => `## ${title}\n\n${body}`)
    .join('\n\n')

describe('recap loops', () => {
  it('finds a key phrase copied into several sections, with every copy', () => {
    const text = doc({
      Abstract:
        'Thirty of the anchors stayed covered, and in nearly nine displaced anchors out of ten the conjunctiva still separated the implant from the surface.',
      Results:
        'The cover held for most anchors: in nearly nine displaced anchors out of ten the conjunctiva still separated the implant from the surface.',
      Conclusion:
        'Exteriorisation is common, yet in nearly nine displaced anchors out of ten the conjunctiva still protects the eye.',
    })
    const [recap] = detectAuthorship(text).recaps
    expect(recap?.phrase).toMatch(/nearly nine displaced anchors out of ten/)
    expect(recap?.occurrences.map((o) => o.section)).toEqual(['Abstract', 'Results', 'Conclusion'])
    expect(recap?.summary).toBe(true)
    for (const o of recap?.occurrences ?? [])
      expect(text.slice(o.start, o.end)).toMatch(/^in nearly nine displaced anchors out of ten/)
  })

  it('finds a short formula when it carries a number', () => {
    const text = doc({
      Introduction: 'Published rates vary by a factor of ten between series of different design.',
      Discussion: 'Their frequencies vary by a factor of ten, which no definition explains alone.',
    })
    expect(detectAuthorship(text).recaps.map((r) => r.phrase)).toEqual(['vary by a factor of ten'])
  })

  it('leaves the subject’s own terminology alone', () => {
    const technique = 'using the scleral pockets technique'
    const text = doc({
      Methods: `All eyes had surgery ${technique} by two surgeons. The scleral pockets technique was used throughout. Each scleral pockets technique case was reviewed.`,
      Results: `Lenses fitted ${technique} stayed centred. The scleral pockets technique gave stable results. The scleral pockets technique raised no alarm.`,
    })
    expect(detectAuthorship(text).recaps).toEqual([])
  })

  it('does not count a repetition inside one section', () => {
    const text = doc({
      Discussion:
        'In nearly nine displaced anchors out of ten the cover held. Again, in nearly nine displaced anchors out of ten the cover held.',
    })
    expect(detectAuthorship(text).recaps).toEqual([])
  })
})
