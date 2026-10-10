// Formulas of academic and medical writing, read with `--register academic`.
//
// "To our knowledge", "C'est dans ce contexte que", "plays a role", "remain
// reassuring": stock phrases of the register, written by hand for decades
// before any model, and leaned on by models writing in it. On a thesis the
// general catalogue found nothing and the report could not say whether that
// meant "nothing there" or "nothing this list reads". These entries close that
// gap without turning the register into evidence:
//
//   tier 3   each one only ever adds to a sentence something else flagged;
//   alone    it is listed under "what is not evidence", by name and count.
//
// Composed for this file from the formulas the relevé of a thesis found, and
// from the usual stock of the register; not copied from a source.

import { word } from '../segment.ts'
import type { Pattern } from './types.ts'

const fr = (source: string) => word(source.replaceAll("'", "['’]"))

const REASON = 'a stock formula of academic writing: a register, which people use as much as models'
const FIX = 'say the specific thing the formula announces, or cut it'

interface Entry {
  name: string
  source: string
  sample: string
  traps?: string[]
}

const english = (entries: Entry[]): Pattern[] =>
  entries.map((entry) => ({
    id: `en.register.${entry.name}`,
    lang: 'en',
    tier: 3,
    category: 'register',
    pattern: new RegExp(String.raw`\b(?:${entry.source})\b`, 'gi'),
    reason: REASON,
    fixHint: FIX,
    samples: [entry.sample],
    traps: entry.traps ?? [],
  }))

const french = (entries: Entry[]): Pattern[] =>
  entries.map((entry) => ({
    id: `fr.register.${entry.name}`,
    lang: 'fr',
    tier: 3,
    category: 'register',
    pattern: fr(entry.source),
    reason: REASON,
    fixHint: FIX,
    samples: [entry.sample],
    traps: entry.traps ?? [],
  }))

export const ACADEMIC: readonly Pattern[] = [
  ...english([
    {
      name: 'to_our_knowledge',
      source: 'to (?:the best of )?our knowledge',
      sample: 'To our knowledge, this is the first study.',
    },
    {
      name: 'in_this_context',
      source: 'it is in this context that|in this context,',
      sample: 'It is in this context that lenses were developed.',
      traps: ['the context of the study'],
    },
    {
      name: 'appears_necessary',
      source: '(?:appears?|seems?) (?:necessary|essential|crucial|important) (?:to|before)',
      sample: 'Distinguishing them appears necessary before rates can be compared.',
    },
    {
      name: 'can_be_compared',
      source: 'before [^.!?\\n]{1,60}? can be compared',
      sample: 'before published rates can be compared',
    },
    {
      name: 'play_a_role',
      source:
        'play(?:s|ed|ing)? an? (?:key |major |crucial |central |important |significant )?role',
      sample: 'The anatomy could also play a role.',
      traps: ['They played the role of controls in the trial.'],
    },
    {
      name: 'remain_reassuring',
      source: 'remains? (?:nevertheless |however )?reassuring',
      sample: 'The data nevertheless remain reassuring.',
    },
    {
      name: 'main_limitations',
      source: 'constitutes? (?:its|the|our) main limitations?',
      sample: 'Its small size constitutes its main limitation.',
    },
    {
      name: 'our_study_proposes',
      source:
        '(?:our|this|the present) (?:study|work|series) (?:proposes|provides|offers) an? (?:[a-z]+ (?:and (?:a |an )?[a-z]+ )?)?(?:precise|comprehensive|detailed|thorough|novel|unique)',
      sample: 'Our study proposes a precise assessment.',
    },
    {
      name: 'further_studies',
      source:
        '(?:further|future|prospective|larger) (?:studies|research|trials) (?:are|is|would be|will be) (?:needed|warranted|required)',
      sample: 'Further studies are needed.',
    },
    {
      name: 'it_should_be_noted',
      source:
        'it should be (?:noted|emphasi[sz]ed|stressed) that|it is worth (?:noting|mentioning) that',
      sample: 'It should be noted that the series is small.',
    },
    {
      name: 'taken_together',
      source: 'taken together(?=,)',
      sample: 'Taken together, these results agree.',
    },
    {
      name: 'shed_light',
      source: 'sheds? (?:new |some )?light on',
      sample: 'These data shed light on the mechanism.',
    },
    {
      name: 'coexist',
      source: '(?:two|three|four|five|several) [a-z]+(?: [a-z]+){0,4} coexist',
      sample: 'Two ways of covering the anchors coexist: a flap and a pocket.',
      traps: ['They coexist peacefully.'],
    },
    {
      name: 'well_documented',
      source: 'is well documented|is well established',
      sample: 'Visual performance is well documented.',
    },
    {
      name: 'the_present_study',
      source: 'the present study',
      sample: 'The present study has limits.',
    },
  ]),
  ...french([
    {
      name: 'dans_ce_contexte',
      source: "c'est dans ce contexte qu(?:e |')|dans ce contexte,",
      sample: "C'est dans ce contexte qu'ont été développés des implants.",
      traps: ['le contexte de cette étude'],
    },
    {
      name: 'contraste_net',
      source: 'il existe (?:ainsi |donc )?un contraste (?:net |marqué )?entre',
      sample: 'Il existe ainsi un contraste net entre les deux.',
    },
    {
      name: 'a_notre_connaissance',
      source: 'à notre connaissance',
      sample: 'À notre connaissance, il s’agit de la première étude.',
    },
    {
      name: 'jouer_un_role',
      source:
        '(?:jouer|joue|jouent|jouerait|joueraient|pourrai(?:t|ent) (?:également |aussi )?jouer) un (?:rôle|role)(?: (?:clé|majeur|central|important|essentiel))?',
      sample: 'Les particularités anatomiques pourraient également jouer un rôle.',
    },
    {
      name: 'restent_rassurantes',
      source: 'rest(?:e|ent) (?:cependant |toutefois |néanmoins )?rassurant(?:e|es|s)?',
      sample: 'Les données restent cependant rassurantes.',
    },
    {
      name: 'principales_limites',
      source:
        'constitu(?:e|ent) (?:néanmoins |toutefois |cependant )?(?:ses|les|nos) principales limites',
      sample: 'Son effectif limité constitue néanmoins ses principales limites.',
    },
    {
      name: 'notre_etude_propose',
      source:
        '(?:notre|cette|la présente) (?:étude|travail|série) (?:propose|apporte|offre) une? (?:évaluation|analyse|classification|description)(?: et une? [\\p{L}]+){0,2} (?:précise|détaillée|exhaustive|complète)',
      sample: 'Notre étude propose une évaluation précise du stade.',
    },
    {
      name: 'problematique_commune',
      source: 'pos(?:e|ent) une problématique (?:commune|majeure|centrale)',
      sample: 'Ces situations posent une problématique commune.',
    },
    {
      name: 'presente_une_particularite',
      source: 'présente une particularité',
      sample: 'Le Carlevale présente une particularité mécanique.',
    },
    {
      name: 'coexistent',
      source: '(?:deux|trois|quatre|cinq|plusieurs) [\\p{L}]+(?: [\\p{L}’]+){0,4} coexistent',
      sample: 'Deux modalités de couverture des ancrages coexistent : le volet et la poche.',
      traps: ['Ils coexistent pacifiquement.'],
    },
    {
      name: 'tout_en_soulignant',
      source: 'tout en (?:soulignant|mettant en évidence|rappelant)',
      sample: 'une revue confirme le centrage, tout en soulignant l’hétérogénéité.',
    },
    {
      name: 'il_convient_de_souligner',
      source: 'il convient de (?:souligner|noter|rappeler) que',
      sample: 'Il convient de souligner que la série est petite.',
    },
    {
      name: 'etudes_necessaires',
      source:
        "(?:d'autres |de nouvelles |des )?études (?:prospectives |complémentaires |supplémentaires )?(?:sont|seraient|seront) nécessaires",
      sample: 'Des études prospectives sont nécessaires.',
    },
    {
      name: 'bien_documentee',
      source: 'est bien (?:documentée?|établie?)',
      sample: 'La performance visuelle est bien documentée.',
    },
  ]),
]
