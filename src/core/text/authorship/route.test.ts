import { describe, expect, it } from 'vitest'
import { segment } from './segment.ts'
import { route } from './route.ts'
import { passageLanguages } from '../language.ts'

const FR = `Le conseil municipal s'est réuni mardi soir pour examiner le budget de l'année prochaine. Les élus ont longuement débattu de la rénovation de l'école primaire, dont la toiture fuit depuis deux hivers.`
const EN = `The council met on Tuesday evening to go through next year's budget. Most of the discussion was about the primary school roof, which has been leaking for two winters now.`
const DE = `Der Gemeinderat hat sich am Dienstagabend getroffen, um den Haushalt für das kommende Jahr zu beraten. Die meiste Zeit ging es um das Dach der Grundschule, das seit zwei Wintern undicht ist.`

describe('passageLanguages', () => {
  it('names the language of each prose block, with its offsets', () => {
    const text = `${FR}\n\n${EN}`
    const found = passageLanguages(text)
    expect(found.map((p) => p.lang)).toEqual(['fr', 'en'])
    expect(text.slice(found[1]?.start, found[1]?.end)).toBe(EN)
  })

  it('does not let a quotation choose the language of its paragraph', () => {
    const quoted = `${FR} Il a répondu : « The budget is fine and nobody needs to worry about the roof at all. »`
    expect(passageLanguages(quoted)[0]?.lang).toBe('fr')
  })
})

describe('route', () => {
  it('routes each paragraph to its own language', () => {
    const text = `${FR}\n\n${EN}`
    const seg = segment(text)
    const routed = route(text, seg)
    expect(routed.document).toBe('fr')
    expect(new Set(seg.sentences.map((s) => s.lang))).toEqual(new Set(['fr', 'en']))
  })

  it('lets a paragraph too short to read inherit the document language', () => {
    const text = `${FR}\n\n- Oui.\n- Non.`
    const seg = segment(text)
    route(text, seg)
    expect(seg.sentences.map((s) => s.lang)).toEqual(['fr', 'fr', 'fr', 'fr'])
  })

  it('reports how much of the prose is in a language it does not support', () => {
    const seg = segment(DE)
    const routed = route(DE, seg)
    expect(routed.unsupportedShare).toBeGreaterThan(0.5)
    expect(seg.sentences.every((s) => s.lang === undefined)).toBe(true)
  })

  it('takes the language it is given over the one it would detect', () => {
    const seg = segment(EN)
    const routed = route(EN, seg, 'fr')
    expect(routed.document).toBe('fr')
    expect(routed.unsupportedShare).toBe(0)
    expect(seg.sentences.every((s) => s.lang === 'fr')).toBe(true)
  })
})
