// French vocabulary that generated prose leans on, by how much one use is worth.
//
// The three-tier split and much of the selection follow humanizer-fr (MIT
// License), which catalogues the habits of French text written by language
// models. The lists here are a re-selection for detection rather than a copy:
// entries common in legitimate administrative or academic French were moved
// down a tier on purpose, because "force est de constater" in a prefecture
// notice is register, not a tell.
//
// Each entry is a regex source for `word()`: `'` stands for either apostrophe,
// and the entry must not use `\b`, which does not see accented letters.

export interface LexiconEntry {
  /** Stable id suffix. */
  name: string
  source: string
  sample: string
  traps?: readonly string[]
}

/** Counts on its own. */
export const TIER_1: readonly LexiconEntry[] = [
  {
    name: 'plongeons',
    source: 'plongeons(?:-nous)?(?: (?:dans|au cœur|ensemble|sans plus attendre))',
    sample: 'Plongeons dans le sujet',
    traps: ['Nous plongeons les légumes dans l’eau bouillante'],
  },
  {
    name: 'dans_un_monde_ou',
    source: 'dans un monde où',
    sample: 'Dans un monde où tout va vite',
  },
  {
    name: 'a_lere_de',
    source: "à l'ère (?:du|de la|de l'|des)",
    sample: "À l'ère du numérique",
  },
  {
    name: 'monde_en_evolution',
    source: 'dans un monde en (?:constante|perpétuelle) (?:évolution|mutation)',
    sample: 'dans un monde en constante évolution',
  },
  {
    name: 'nhesitez_pas',
    // The contact form of it is the most ordinary sentence in French
    // administration. Only the version that invites the reader to go and
    // explore something counts.
    source:
      "n'hésitez pas à(?= (?!(?:nous|me|m'|vous|contacter|joindre|prendre contact|appeler|écrire|consulter|revenir)(?![\\p{L}])))",
    sample: "N'hésitez pas à explorer ces pistes",
    traps: [
      "N'hésitez pas à contacter le service instructeur.",
      "N'hésitez pas à nous écrire.",
      "N'hésitez pas à vous rapprocher de votre mairie.",
    ],
  },
  {
    name: 'temoigne_de',
    // Bare "témoigne de" is the everyday verb of historians and sociologists.
    // The generated habit is the praise that follows it.
    source:
      "témoigne(?:nt)? (?:de l'|de la |du |des |d')(?:importance|richesse|engagement|volonté|dynamisme|vitalité|résilience|diversité|créativité|profondeur|puissance|ingéniosité|savoir-faire|excellence|passion|détermination|capacité)",
    sample: "Ce projet témoigne de l'engagement de toute l'équipe",
    traps: ['Ce résultat témoigne de contraintes financières persistantes'],
  },
  {
    name: 'pierre_angulaire',
    source: 'pierre angulaire',
    sample: 'La confiance est la pierre angulaire du projet',
  },
  {
    name: 'riche_tapisserie',
    source: '(?:riche|véritable|vaste) tapisserie',
    sample: 'une riche tapisserie de cultures',
    traps: ['Le papier peint et la tapisserie du salon'],
  },
  {
    name: 'mine_dor',
    source: "(?:véritable|vraie) mine d'or",
    sample: "une véritable mine d'or d'informations",
  },
  {
    name: 'voyage_fascinant',
    source: 'voyage (?:fascinant|captivant|passionnant|au cœur)',
    sample: 'un voyage fascinant',
  },
  {
    name: 'naviguer_complexite',
    source: 'naviguer (?:dans|à travers) (?:les méandres|le paysage|les complexités|la complexité)',
    sample: 'naviguer dans les méandres administratifs',
  },
  {
    name: 'paysage_actuel',
    source: 'dans le paysage (?:actuel|numérique|contemporain|en constante)',
    sample: 'dans le paysage actuel',
  },
  {
    name: 'revolutionner_facon',
    source: 'révolutionne(?:r|nt)? (?:la façon|notre façon|votre façon|le monde)',
    sample: 'révolutionner la façon dont nous travaillons',
  },
]

/** Counts only when two or more tier-2 hits share a paragraph. */
export const TIER_2: readonly LexiconEntry[] = [
  {
    name: 'force_est_de_constater',
    source: 'force est de constater',
    sample: 'Force est de constater',
  },
  {
    name: 'il_convient_de',
    source: 'il convient de (?:noter|souligner|rappeler|mentionner)',
    sample: 'Il convient de noter',
  },
  {
    name: 'il_est_important_de',
    source:
      'il est (?:important|essentiel|crucial|primordial) de (?:noter|souligner|rappeler|comprendre)',
    sample: 'Il est important de noter',
  },
  { name: 'au_coeur_de', source: 'au cœur (?:de|du|des)', sample: 'au cœur de la ville' },
  { name: 'notamment', source: 'notamment', sample: 'notamment' },
  { name: 'en_outre', source: 'en outre', sample: 'En outre' },
  { name: 'par_ailleurs', source: 'par ailleurs', sample: 'Par ailleurs' },
  { name: 'crucial', source: 'cruci(?:al|ale|ales|aux)', sample: 'un rôle crucial' },
  { name: 'essentiel', source: 'essentiel(?:le|s|les)?', sample: 'un point essentiel' },
  {
    name: 'mise_en_place',
    source: "la mise en place (?:de|du|des|d')",
    sample: 'la mise en place de',
  },
  {
    name: 'en_constante_evolution',
    source: 'en (?:constante|perpétuelle) évolution',
    sample: 'un secteur en constante évolution',
  },
  { name: 'incontournable', source: 'incontournables?', sample: 'un acteur incontournable' },
  { name: 'holistique', source: 'holistiques?', sample: 'une approche holistique' },
  { name: 'synergie', source: 'synergies?', sample: 'créer des synergies' },
  {
    name: 'fascinant',
    source: '(?:fascinant|captivant)(?:e|s|es)?',
    sample: 'un sujet fascinant',
  },
  {
    name: 'role_cle',
    source:
      '(?:joue|jouent|jouer|jouera|jouant) un rôle (?:clé|crucial|essentiel|central|déterminant|prépondérant|majeur)',
    sample: 'joue un rôle clé',
  },
  {
    name: 'a_laube_de',
    source: "à l'aube (?:de|du|des|d')",
    sample: "à l'aube d'une nouvelle ère",
  },
  {
    name: 'levier',
    source: 'levier (?:puissant|essentiel|incontournable|majeur|stratégique)',
    sample: 'un levier stratégique',
  },
  {
    name: 'optimiser_potentiel',
    source: '(?:libérer|exploiter|optimiser) (?:tout )?(?:le|son|votre|leur) (?:plein )?potentiel',
    sample: 'libérer tout son potentiel',
  },
]

/** Never counts alone: weight added to a sentence something else flagged. */
export const TIER_3: readonly LexiconEntry[] = [
  { name: 'ainsi', source: 'ainsi', sample: 'ainsi' },
  { name: 'de_plus', source: 'de plus', sample: 'De plus' },
  { name: 'en_effet', source: 'en effet', sample: 'En effet' },
  { name: 'en_fin_de_compte', source: 'en fin de compte', sample: 'en fin de compte' },
  { name: 'veritable', source: 'véritables?', sample: 'un véritable atout' },
  { name: 'ecosysteme', source: 'écosystèmes?', sample: "l'écosystème" },
  { name: 'dynamique', source: 'dynamiques?', sample: 'une dynamique' },
  { name: 'optimiser', source: 'optimise(?:r|z|ons)?', sample: 'optimiser' },
]
