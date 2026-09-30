// French that a person wrote and that the catalogue must not call generated.
//
// Administrative and academic French is the hardest case for a detector built
// on habits: its register is formal on purpose, and it leans on exactly the
// connectors a model overuses — "en outre", "notamment", "il convient de". A
// detector that flags a municipal notice is a detector nobody should trust
// with a student's essay.
//
// No tier-1 entry may match anything here. Tier 2 may, since one formal
// connector is a register and it takes density before tier 2 counts at all.
// Composed for this file in the registers named, not copied from a source.

export const FR_TRAPS: readonly { register: string; text: string }[] = [
  {
    register: 'administratif',
    text: `Conformément à l'article L. 2121-29 du code général des collectivités territoriales, le conseil municipal règle par ses délibérations les affaires de la commune. Il convient de noter que la mise en place de la nouvelle tarification interviendra au 1er janvier. En outre, les usagers disposent d'un délai de deux mois pour former un recours gracieux. Pour toute question, n'hésitez pas à contacter le service des finances.`,
  },
  {
    register: 'administratif',
    text: `La demande doit être déposée au plus tard le 15 mars. Le dossier comprend notamment une pièce d'identité, un justificatif de domicile et le dernier avis d'imposition. Par ailleurs, il est essentiel de joindre le formulaire signé. Force est de constater que de nombreux dossiers incomplets retardent l'instruction. N'hésitez pas à vous rapprocher de votre mairie.`,
  },
  {
    register: 'administratif',
    text: `Le présent arrêté entre en vigueur à compter de sa publication. Les travaux, réalisés en maintenant la circulation sur une voie, dureront trois semaines. Pendant cette période, le stationnement est interdit rue des Tilleuls, sauf pour les véhicules de secours. Les riverains peuvent obtenir un laissez-passer auprès de la police municipale.`,
  },
  {
    register: 'académique',
    text: `Au cœur de cette recherche se trouve la question de la mobilité résidentielle. Les données de l'enquête Logement montrent notamment que les ménages modestes déménagent moins souvent que les autres. Ce résultat témoigne de contraintes financières persistantes, que l'on retrouve par ailleurs dans les travaux sur l'accession à la propriété. Il convient toutefois de rester prudent quant à l'interprétation causale.`,
  },
  {
    register: 'académique',
    text: `Dans un premier temps, nous présentons le corpus, constitué de 312 entretiens semi-directifs menés entre 2014 et 2017. Dans un second temps, nous analysons les trajectoires professionnelles des enquêtés. Cependant, l'échantillon reste limité, et les résultats doivent être lus comme exploratoires plutôt que représentatifs.`,
  },
  {
    register: 'journalistique',
    text: `Mardi soir, les élus ont longuement débattu de la rénovation de l'école primaire, dont la toiture fuit depuis deux hivers. Le maire a rappelé que le devis dépassait de 40 % l'enveloppe prévue. « Nous n'avons pas le choix », a-t-il dit, avant de proposer un emprunt sur quinze ans.`,
  },
  {
    register: 'fiction',
    text: `— Tu viens ? demanda-t-elle en poussant la porte.
— Pas maintenant. J'attends Paul, il devait passer avant midi.
Elle haussa les épaules, prit son manteau et sortit sans répondre, laissant derrière elle une odeur de tabac froid.`,
  },
  {
    register: 'courriel',
    text: `Bonjour Madame, je vous remercie pour votre retour rapide. Je vous transmets en pièce jointe le devis corrigé ainsi que le planning prévisionnel. N'hésitez pas à me dire si un créneau jeudi matin vous conviendrait pour en discuter. Bien cordialement, Julien Moreau.`,
  },
]
