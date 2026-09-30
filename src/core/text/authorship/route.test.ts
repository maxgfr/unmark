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

  it('routes jargon-heavy English prose that the detectors score low but agree on', () => {
    // A real HAL abstract (CC BY 4.0). TinyLD puts English far ahead of
    // everything else, but under its absolute threshold, and routing used to
    // call the whole document "no supported language".
    const abstract = `The presence of antimicrobial residues in food-producing animals can lead to harmful effects on the consumer (e.g., allergies, antimicrobial resistance, toxicological effects) and cause issues in food transformation (i.e., cheese, yogurts production). Therefore, to control antimicrobial residues in food products of animal origin, screening methods are of utmost importance. Microbiological and immunological methods (e.g., ELISA, dipsticks) are conventional screening methods. Biosensors are an innovative solution for the development of more performant screening methods. Among the different kinds of biosensing elements (e.g., antibodies, aptamers, molecularly imprinted polymers (MIP), enzymes), aptamers for targeting antimicrobial residues are in continuous development since 2000. Therefore, this review has highlighted recent advances in the development of aptasensors, which present multiple advantages over immunosensors. Most of the aptasensors described in the literature for the detection of antimicrobial residues in animal-derived food products are either optical or electrochemical sensors. In this review, I have focused on optical aptasensors and showed how nanotechnologies (nanomaterials, micro/nanofluidics, and signal amplification techniques) largely contribute to the improvement of their performance (sensitivity, specificity, miniaturization, portability). Finally, I have explored different techniques to develop multiplex screening methods. Multiplex screening methods are necessary for the wide spectrum detection of antimicrobials authorized for animal treatment (i.e., having maximum residue limits).`
    const seg = segment(abstract)
    expect(route(abstract, seg).document).toBe('en')
  })

  it('routes English that TinyLD misreads, when both detectors put English first', () => {
    // A real HAL abstract (Dias et al., hal.science/bioemco-00542730, CC BY 4.0).
    // Its Latin binomials make TinyLD answer Berber 0.50 over English 0.44;
    // franc-min ranks English first. Two detectors agreeing on the one
    // supported language they both rank highest is an answer for routing.
    const abstract = `The mycorrhizal colonisation of plants grown in unmanaged soils from two restoration sites with a fire history in Northern Portugal was evaluated from the perspective of supporting restoration programmes. To promote restoration of original tree stands, Quercus ilex L. and Pinus pinaster Ait. were used as target species on two sites, denoted Site 1 and 2 respectively. The aim of the study was to assess whether mycorrhizal propagules that survived fire episodes could serve as in situ inoculum sources, and to analyse the spatial distribution of soil nutrients and mycorrhizal parameters. In a laboratory bioassay, P. pinaster and Q. ilex seedlings were grown on soils from the target sites and root colonisation by ectomycorrhizal (ECM) and arbuscular mycorrhizal (AM) fungi was determined. The ECM root colonisation levels found indicated that soil from Site 2 contained sufficient ECM propagules to serve as a primary source of inoculum for P pinaster. The low levels of ECM and AM colonisation obtained on the roots of plants grown in soil from Site 1 indicated that the existing mycorrhizal propagules might be insufficient for effective root colonisation of Q. ilex. Different ECM morphotypes were found in plants grown in soil from the two sites. At Site 2 mycorrhizal parameters were found to be spatially structured, with significant differences in ECM colonisation and soil P concentrations between regions of either side of an existing watercourse. The spatial distribution of mycorrhizal propagules was related to edaphic parameters (total C and extractable P), and correlations between soil nutrients and mycorrhizal parameters were found.`
    const seg = segment(abstract)
    expect(route(abstract, seg).document).toBe('en')
  })

  it('takes the language it is given over the one it would detect', () => {
    const seg = segment(EN)
    const routed = route(EN, seg, 'fr')
    expect(routed.document).toBe('fr')
    expect(routed.unsupportedShare).toBe(0)
    expect(seg.sentences.every((s) => s.lang === 'fr')).toBe(true)
  })
})
