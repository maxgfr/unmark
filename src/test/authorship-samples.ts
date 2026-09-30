// Two French documents for tests that need a whole text rather than a sentence.
//
// AI_FR was written by a model for these tests, and piles up the habits the
// French catalogue lists. HUMAN_FR is real, dated, openly licensed human prose.

export const AI_FR = `Dans un monde en constante évolution, la transformation numérique joue un rôle crucial pour les entreprises. Plongeons au cœur de cette révolution qui redéfinit notre façon de travailler.

Que vous soyez dirigeant de PME ou responsable d'un grand groupe, il est essentiel de comprendre ces enjeux. Il ne s'agit pas seulement d'adopter de nouveaux outils, mais de repenser en profondeur l'organisation. En outre, l'intelligence artificielle offre des opportunités fascinantes, notamment en matière d'automatisation.

Les solutions modernes permettent d'optimiser les processus en offrant une visibilité accrue, en permettant une collaboration fluide et en garantissant une sécurité renforcée. Ce n'est pas seulement une question de technologie, c'est une question de culture. Force est de constater que les organisations agiles, innovantes et résilientes tirent leur épingle du jeu.

Par ailleurs, la formation des équipes constitue la pierre angulaire de toute transformation réussie. Il convient de noter que l'accompagnement humain reste essentiel, notamment pour les collaborateurs les moins familiers avec le numérique.

En conclusion, à l'ère du numérique, l'avenir s'annonce prometteur pour les entreprises qui sauront saisir ces opportunités. N'hésitez pas à explorer ces pistes pour libérer tout le potentiel de votre organisation.`

/**
 * A real administrative page, written by people before chat models existed:
 * "Carte d'identité d'un majeur : première demande", service-public.fr, DILA,
 * Licence Ouverte 2.0 (etalab-2.0), as captured on 2021-10-22 —
 * https://web.archive.org/web/20211022134657/https://www.service-public.fr/particuliers/vosdroits/F1341
 *
 * It replaces a "human" sample that had been written for these tests by a
 * model, which the variation signal then correctly read as generated.
 */
export const HUMAN_FR = `Pour demander une carte nationale d'identité, il faut se rendre au guichet avec les pièces justificatives nécessaires. Les documents à présenter dépendent de votre situation et notamment de la possession d'un passeport récent.

Le lieu de la demande ne dépend pas du domicile. Vous pouvez vous rendre à n'importe quelle mairie, à condition qu'elle soit équipée d'une station d'enregistrement.

Votre présence est indispensable pour procéder à la prise d'empreintes.

Vous pouvez préparer la démarche en faisant une pré-demande en ligne mais ce n'est pas une obligation.

Il faudra ensuite vous rendre en mairie pour finaliser la demande avec les pièces justificatives.

Le guichet récupérera vos données grâce au numéro de pré-demande, vérifiera vos pièces justificatives et prendra les empreintes.

Il faut présenter les documents originaux.

Votre passeport

Photo d'identité de moins de 6 mois et conforme aux normes

Justificatif de domicile

Numéro de pré-demande si vous avez fait cette démarche en ligne (sinon, il faut utiliser le formulaire cartonné disponible au guichet)

Gratuit

La carte d'identité n'est pas fabriquée sur place et ne peut donc pas être délivrée immédiatement. Le délai de fabrication dépend du lieu et de la période de la demande. Par exemple, à l'approche des vacances d'été, les délais peuvent augmenter de manière significative.`
