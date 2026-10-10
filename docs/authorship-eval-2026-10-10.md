# Authorship evaluation — 2026-10-10

Calibration `fit-2026-10-10-ba0e67364077-16791e` · split `test` · corpora: pinned 37f8f56fd9ce, binoculars-eu 575c9fcd22d9 · bootstrap 1000 rounds, seed 42.

Scores are computed for every document, including those under 150 words that the verdict abstains on; verdict counts are as a user would see them. None of this is a guarantee on text from another model, another genre or another decade.

## Separation

- AUROC human vs generated: **0.763** (95 % CI 0.712–0.81)
- True-positive rate at 1 % false positives: **0.386** (95 % CI 0.268–0.459)
- True-positive rate at 5 % false positives: **0.45** (95 % CI 0.364–0.536)
- Humanised generated text: AUROC 0.513; 5 % still reach the AI threshold
- Sentence-level AUROC on mixed documents: 0.558 (32 sentences)

Documents: 420 (142 human, 220 generated, 56 humanised; 181 of 150 words or more).

## Verdicts

| Label     | likely_ai | uncertain | likely_human | insufficient_evidence |
| --------- | --------: | --------: | -----------: | --------------------: |
| ai        |         3 |        34 |           13 |                   170 |
| human     |         0 |        66 |           51 |                    25 |
| humanized |         1 |         8 |            3 |                    44 |
| mixed     |         0 |         0 |            2 |                     0 |

Of the documents long enough for a verdict, 44 % of human ones and 26 % of generated ones read as `likely_human` ("few AI-writing signals found"): the human threshold is floored at 0.1, so a text with no habit at all is said to have none, and the generated texts that show none are the price of saying so.

## False positives by stratum (human documents called `likely_ai`)

| Stratum         | Documents | `likely_ai` | FPR | Abstained |
| --------------- | --------: | ----------: | --: | --------: |
| en/academic     |         2 |           0 |   0 |         0 |
| en/admin        |         2 |           0 |   0 |         0 |
| en/encyclopedic |         2 |           0 |   0 |         0 |
| en/fiction      |         1 |           0 |   0 |         0 |
| en/news         |         2 |           0 |   0 |         1 |
| fr/academic     |         3 |           0 |   0 |         0 |
| fr/admin        |         3 |           0 |   0 |         0 |
| fr/blog         |        33 |           0 |   0 |         4 |
| fr/encyclopedic |        41 |           0 |   0 |         6 |
| fr/fiction      |        21 |           0 |   0 |         8 |
| fr/news         |        32 |           0 |   0 |         6 |

## Fitted calibration

Fitted on the train split (411 documents). Weights: spans 0, lexicon 0.402, discourse 0.073, variation 0.279, stylometry 0.147, forensic 0.1. Thresholds: human 0.1, AI 0.5. Logistic coefficients: spans -0.663, lexicon 3.315, discourse 0.599, variation 2.299, stylometry 1.209.
