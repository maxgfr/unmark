# Authorship evaluation — 2026-09-30

Calibration `fit-2026-09-30-ba0e67364077-a56b9f` · split `test` · corpora: pinned 37f8f56fd9ce, binoculars-eu 575c9fcd22d9 · bootstrap 1000 rounds, seed 42.

Scores are computed for every document, including those under 150 words that the verdict abstains on; verdict counts are as a user would see them. None of this is a guarantee on text from another model, another genre or another decade.

## Separation

- AUROC human vs generated: **0.752** (95 % CI 0.7–0.801)
- True-positive rate at 1 % false positives: **0.37** (95 % CI 0.26–0.451)
- True-positive rate at 5 % false positives: **0.46** (95 % CI 0.357–0.519)
- Humanised generated text: AUROC 0.457; 3 % still reach the AI threshold
- Sentence-level AUROC on mixed documents: 0.558 (32 sentences)

Documents: 458 (146 human, 235 generated, 75 humanised; 195 of 150 words or more).

## Verdicts

| Label     | likely_ai | uncertain | likely_human | insufficient_evidence |
| --------- | --------: | --------: | -----------: | --------------------: |
| ai        |         8 |        40 |            7 |                   180 |
| human     |         0 |        83 |           36 |                    27 |
| humanized |         1 |        16 |            1 |                    57 |
| mixed     |         0 |         0 |            2 |                     0 |

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
| fr/blog         |        34 |           0 |   0 |         4 |
| fr/encyclopedic |        43 |           0 |   0 |         7 |
| fr/fiction      |        22 |           0 |   0 |         9 |
| fr/news         |        32 |           0 |   0 |         6 |

## Fitted calibration

Fitted on the train split (439 documents). Weights: spans 0, lexicon 0.41, discourse 0.053, variation 0.298, stylometry 0.139, forensic 0.1. Thresholds: human 0.05, AI 0.5. Logistic coefficients: spans -0.035, lexicon 3.461, discourse 0.444, variation 2.521, stylometry 1.176.
