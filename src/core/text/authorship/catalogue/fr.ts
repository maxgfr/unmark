// The French catalogue.
//
// Vocabulary tiers and several structural habits follow humanizer-fr (MIT
// License); see lexicon/fr.ts for how the selection departs from it. The
// structural entries are the ones worth most, for the reason the-antislop
// (MIT) gives: vocabulary is the first thing a rewrite changes, and the shape
// of a sentence is the last.
//
// Every pattern goes through `word()`, because `\b` does not see "é".

import { TIER_1, TIER_2, TIER_3, type LexiconEntry } from '../../lexicon/fr.ts'
import { word } from '../segment.ts'
import type { Pattern, Tier } from './types.ts'

/** `'` in a source stands for either apostrophe. */
const fr = (source: string) => word(source.replaceAll("'", "['’]"))

const LEXICON_REASON: Record<Tier, string> = {
  1: 'a stock phrase of generated French, rare in writing people do by hand',
  2: 'formal on its own; stacked with others like it in one paragraph, it reads as generated',
  3: 'adds weight only to a sentence already flagged for something else',
}

const LEXICON_FIX: Record<Tier, string> = {
  1: 'say the specific thing; if the sentence stands without the phrase, cut it',
  2: 'one formal phrase per paragraph is register; cut the others or say them plainly',
  3: 'nothing to do on its own; fix what else the sentence was flagged for',
}

const lexicon = (tier: Tier, entries: readonly LexiconEntry[]): Pattern[] =>
  entries.map((entry) => ({
    id: `fr.lex.${entry.name}`,
    lang: 'fr',
    tier,
    category: 'lexicon',
    pattern: fr(entry.source),
    reason: LEXICON_REASON[tier],
    fixHint: LEXICON_FIX[tier],
    samples: [entry.sample],
    traps: entry.traps ?? [],
  }))

/**
 * Words ending in -ant that are not present participles.
 *
 * A chain of three participles — "offrant…, permettant… et garantissant…" — is
 * one of the most reliable French tells. "Pendant", "maintenant" and
 * "important" end the same way and are everywhere.
 */
const NOT_PARTICIPLE =
  'pendant|maintenant|cependant|avant|devant|auparavant|durant|néanmoins|tant|autant|quant|enfant|enfants|important|intéressant|suffisant|constant|courant|puissant|brillant|charmant|méchant|élégant|pesant|étonnant|surprenant|inquiétant|montant|instant|restaurant|étudiant|habitant|participant|représentant|enseignant|dirigeant|passant|plaisant|suivant|vivant|attendant|géant|diamant|volant|croissant|savant|séant|gant|chant|néant'

const PARTICIPLE = String.raw`(?!(?:${NOT_PARTICIPLE})(?![\p{L}]))\p{L}{3,}ant(?![\p{L}])`
const GERUND = String.raw`en (?:y |l'|le |la |les |se |s'|en |nous |vous )?${PARTICIPLE}`

const structure: Pattern[] = [
  {
    id: 'fr.struct.gerund_chain',
    lang: 'fr',
    tier: 2,
    category: 'structure',
    pattern: fr(`${GERUND}[^.!?\\n]{1,80}?${GERUND}[^.!?\\n]{1,80}?${GERUND}`),
    reason: 'three gerunds chained in one sentence, the rhythm of a generated list of benefits',
    fixHint: 'keep the one gerund that matters and make the others sentences with a subject',
    samples: [
      'Cette solution simplifie le travail en offrant un suivi, en permettant le partage et en garantissant la sécurité.',
    ],
    traps: [
      'Il est parti en courant, en maintenant la porte, avant midi.',
      'En attendant, il travaille en tant que stagiaire.',
    ],
  },
  {
    id: 'fr.struct.participle_chain',
    lang: 'fr',
    tier: 2,
    category: 'structure',
    pattern: fr(
      `${PARTICIPLE}[^.!?\\n]{1,80}?, ${PARTICIPLE}[^.!?\\n]{1,80}?(?:, | et )${PARTICIPLE}`,
    ),
    reason: 'three present participles strung together, a list of benefits in one breath',
    fixHint: 'split it: one claim per sentence, each with its own verb',
    samples: [
      'Une plateforme unifiant les données, simplifiant les échanges et renforçant la collaboration.',
    ],
    traps: [
      'Pendant la réunion, maintenant close, cependant rien ne change.',
      'Le montant, important et suffisant, a été versé.',
    ],
  },
  {
    id: 'fr.struct.que_vous_soyez',
    lang: 'fr',
    tier: 1,
    category: 'structure',
    pattern: fr(`que vous soyez [^.!?\\n]{1,60}? ou`),
    reason: '"Que vous soyez X ou Y" speaks to an imagined audience instead of a reader',
    fixHint: 'say who the text is for, or drop the address and make the point',
    samples: ['Que vous soyez débutant ou expert, cet outil vous aidera.'],
    traps: ['Il faut que vous soyez présent jeudi.'],
  },
  {
    id: 'fr.struct.il_ne_sagit_pas',
    lang: 'fr',
    tier: 1,
    category: 'structure',
    pattern: fr(
      `il ne s'agit pas (?:seulement|simplement|uniquement|que|juste) (?:de |d')[^.!?\\n]{1,80}?mais`,
    ),
    reason: '"Il ne s\'agit pas seulement de… mais" knocks down a claim nobody made',
    fixHint: 'state the positive claim directly',
    samples: ["Il ne s'agit pas seulement de réduire les coûts, mais de repenser le service."],
    traps: ["Il ne s'agit pas d'une erreur."],
  },
  {
    id: 'fr.struct.ce_nest_pas_cest',
    lang: 'fr',
    tier: 1,
    category: 'structure',
    pattern: fr(`ce n'est pas (?:seulement|simplement|juste|qu'une?) [^.!?\\n]{1,60}?, c'est`),
    reason: 'the "ce n\'est pas X, c\'est Y" pivot, a staple of generated French',
    fixHint: 'state the positive claim directly',
    samples: ["Ce n'est pas seulement un outil, c'est une philosophie."],
    traps: ["Ce n'est pas un outil."],
  },
  {
    id: 'fr.struct.non_seulement',
    lang: 'fr',
    tier: 2,
    category: 'structure',
    pattern: fr(`non seulement [^.!?\\n]{1,80}?mais (?:aussi|également|encore)`),
    reason: '"non seulement… mais aussi" is correct French, and a cadence when it repeats',
    fixHint: 'state both claims plainly; the reader can add them up',
    samples: ['Il est non seulement rapide mais aussi fiable.'],
    traps: ['Il est rapide et fiable.'],
  },
  {
    id: 'fr.struct.triad',
    lang: 'fr',
    tier: 2,
    category: 'structure',
    pattern: fr(String.raw`\p{Ll}{4,}, \p{Ll}{4,} et \p{Ll}{4,}`),
    reason: 'three bare qualities in a row, the rule of three in French',
    fixHint: 'keep the one or two that are true of this subject in particular',
    samples: ['Une solution simple, efficace et durable.'],
    traps: ['Les élèves, les parents et les enseignants sont invités.'],
  },
  {
    id: 'fr.struct.connector_opener',
    lang: 'fr',
    tier: 2,
    category: 'structure',
    pattern: new RegExp(
      String.raw`(?<=(?:^|\n)[^\S\n]{0,3})(?:En conclusion|En somme|En résumé|Pour conclure|Pour résumer|En définitive)(?=,)`,
      'gu',
    ),
    reason: 'a closing formula opening the paragraph: the recap announces itself',
    fixHint: 'end on the last concrete point; the reader does not need the summary announced',
    samples: ['En conclusion, le projet avance.'],
    traps: [
      'Le projet avance, en conclusion de quoi nous signons.',
      'Premièrement, le cœur stratégique est sanctuarisé.',
    ],
  },
]

const discourse: Pattern[] = [
  {
    id: 'fr.disc.dans_cet_article',
    lang: 'fr',
    tier: 1,
    category: 'discourse',
    pattern: fr(
      `dans cet (?:article|billet|guide),? (?:nous (?:allons|verrons|explorerons|examinerons|découvrirons)|je vais|vous (?:allez découvrir|découvrirez))`,
    ),
    reason: 'an announcement of what the text is about to do, instead of doing it',
    fixHint: 'cut it and start with the first real point',
    samples: ['Dans cet article, nous allons voir comment faire.'],
    traps: ['Cet article a été publié en 2019.'],
  },
  {
    id: 'fr.disc.sans_plus_attendre',
    lang: 'fr',
    tier: 1,
    category: 'discourse',
    pattern: fr('sans plus attendre|explorons ensemble|embarquons'),
    reason: "a presenter's flourish that introduces nothing",
    fixHint: 'cut it and start with the first real point',
    samples: ['Sans plus attendre, voici la liste.'],
    traps: ['Il est parti sans attendre.'],
  },
  {
    id: 'fr.disc.bonne_question',
    lang: 'fr',
    tier: 2,
    category: 'discourse',
    pattern: new RegExp(
      String.raw`(?<=^|[.!?]\s{0,3}|\n\s{0,3})(?:excellente|très bonne|bonne) question(?![\p{L}])`,
      'giu',
    ),
    reason: 'praise for the question, which only makes sense in a conversation',
    fixHint: 'cut it; answer the question',
    samples: ['Excellente question !'],
    traps: ['Il a posé une bonne question.'],
  },
  {
    id: 'fr.disc.conclusion_generique',
    lang: 'fr',
    tier: 2,
    category: 'discourse',
    pattern: fr(
      `l'avenir s'annonce (?:prometteur|radieux|passionnant)|les possibilités sont (?:infinies|illimitées)|seul l'avenir nous le dira|le voyage ne fait que commencer`,
    ),
    reason: 'a closing line that would end any text on any subject',
    fixHint: 'end on the last concrete point instead',
    samples: ["L'avenir s'annonce prometteur."],
    traps: ["L'avenir du quartier dépend du vote."],
  },
]

/**
 * What a chat window leaves in a document. Read in every sentence whatever its
 * language: a French reply pasted into an English report is still a reply.
 */
const residue: Pattern[] = [
  {
    id: 'fr.residue.bien_sur_voici',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern: fr(`(?:bien sûr|certainement|absolument)[\\s\\u00a0]?[!,.][\\s\\u00a0]{1,3}voici`),
    reason: 'the opening of a chatbot answer, left in the document',
    fixHint: 'delete it; it was never part of the document',
    samples: ['Bien sûr ! Voici une version révisée.'],
    traps: ['Bien sûr, il viendra.'],
  },
  {
    id: 'fr.residue.voici_version',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern: fr(
      `voici (?:une|la|votre) (?:version|proposition) (?:révisée|reformulée|améliorée|corrigée|plus)`,
    ),
    reason: 'a chatbot handing over its rewrite, left in the document',
    fixHint: 'delete it; it was never part of the document',
    samples: ['Voici une version révisée de votre texte.'],
    traps: ['Voici le compte rendu de la réunion.'],
  },
  {
    id: 'fr.residue.en_tant_quia',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern: fr(
      `en tant qu'(?:ia|intelligence artificielle|assistant(?:e)? (?:virtuel|ia))|en tant que modèle de langage|je (?:ne )?suis (?:qu')?un modèle de langage`,
    ),
    reason: 'a model describing itself',
    fixHint: 'delete it; it was never part of the document',
    samples: ["En tant qu'IA, je ne peux pas donner d'avis."],
    traps: ["En tant qu'ingénieur, je ne peux pas signer."],
  },
  {
    id: 'fr.residue.jespere_que_cela_aide',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern: fr(
      `j'espère que (?:cela|ceci|ça) (?:vous )?(?:aide|aidera|a aidé|répond|vous sera utile)`,
    ),
    reason: 'a line addressed to the person in a chat window, left in the document',
    fixHint: 'delete it; it was never part of the document',
    samples: ['J’espère que cela vous aide.'],
    traps: ["J'espère que cela ira mieux demain."],
  },
  {
    id: 'fr.residue.nhesitez_pas_me',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern: fr(
      `n'hésitez pas à me (?:demander|le demander|faire savoir|dire si vous souhaitez|solliciter|poser)|souhaitez-vous que je|voulez-vous que je|dites-moi si vous souhaitez`,
    ),
    reason: 'an offer to keep chatting, left in the document',
    fixHint: 'delete it; it was never part of the document',
    samples: ["N'hésitez pas à me demander si vous voulez plus de détails."],
    traps: ["N'hésitez pas à me dire si un créneau jeudi vous convient."],
  },
  {
    id: 'fr.residue.date_de_coupure',
    lang: 'any',
    tier: 1,
    category: 'residue',
    pattern: fr(
      `(?:à la date de|depuis) ma dernière mise à jour|(?:selon|d'après) mes (?:dernières )?(?:connaissances|données d'entraînement)|ma date (?:de coupure|limite) (?:des|de mes) connaissances`,
    ),
    reason: "a model's disclaimer about its own training data",
    fixHint: 'delete it, and check the facts it was hedging with a dated source',
    samples: ['Selon mes dernières connaissances, la loi est en vigueur.'],
    traps: ['Selon mes calculs, la loi est en vigueur.'],
  },
]

export const FR: readonly Pattern[] = [
  ...lexicon(1, TIER_1),
  ...lexicon(2, TIER_2),
  ...lexicon(3, TIER_3),
  ...structure,
  ...discourse,
  ...residue,
]
