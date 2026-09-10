# Local rewrite regression check — 2026-09-10

Tested the production build in headed Chromium on a real Apple WebGPU adapter,
using Qwen2.5-0.5B-Instruct-q4f32_1-MLC and Ultra. These six short examples diagnose
specific failures; they are not a model-quality benchmark. Latencies below use
assets served from localhost. The first example includes model initialization;
subsequent examples reuse the loaded worker. Production download time is excluded.

| Input                                       | Previous prompt                                                           | Current concise prompt                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bonjour c cool`                            | Repeated the instruction template; all three candidates rejected (7.4 s). | Copied the original, accepted in 1.3 s.                                                                         |
| French project update                       | Returned unrelated English editing commentary, incorrectly accepted.      | Kept French and added “maintenant” (1.3 s). The known commentary response is now rejected by a regression test. |
| French update with dates, numbers and Marie | Hit the output limit; basic fallback.                                     | Preserved the original (0.8 s).                                                                                 |
| French collaboration paragraph              | Preserved the original.                                                   | Changed “suivi” to “surveillance” (0.8 s), a questionable editorial choice despite passing checks.              |
| English sales update with `2026-09-10`      | Hit the output limit; basic fallback.                                     | Reformatted the date and changed tense. All three candidates rejected; original retained (1.3 s).               |
| Inline code, quoted message and URL         | Echoed instructions and lost protected content; rejected.                 | Preserved the original (0.8 s).                                                                                 |

The concise prompt fixes the reported instruction-echo failure and avoids the
observed output-limit failures on these examples. It does not make a 0.5B model a
high-quality editor. The checks cover extracted facts, protected spans, style
regressions and known model commentary; they cannot prove semantic equivalence,
correct language or statistical-watermark removal. Ultra uses the same model as
Deep, with more attempts and deterministic cleanup around the model.

`UNMARK_HEADED=1 UNMARK_MODE=ultra node scripts/smoke-text-model.mjs` exercises a
real model, then cached and offline French runs. Ordinary Playwright tests inject
a worker to verify acceptance, refusal reasons, unchanged output, cancellation,
source edits and model errors independently of GPU availability.

## Reproduction inputs

fr-simple:

```text
Le projet avance bien. Nous avons terminé la première étape et nous préparons la suite.
```

fr-facts:

```text
Le 10 septembre 2026, notre équipe a livré 12 dossiers. Le budget reste fixé à 1 500 euros. Nous attendons la validation de Marie avant vendredi.
```

fr-polish:

```text
Il est important de noter que cette solution permet de faciliter la collaboration entre les équipes. Dans ce contexte, nous souhaitons mettre en place un processus clair afin de garantir un suivi efficace des demandes.
```

en-facts:

```text
Sales reached 10 units. The team delivered the report on 2026-09-10. The budget is 1500 euros.
```

code-quote:

```text
Run `const total = 10` and keep the message "payment is pending". Send the result to https://example.com/report.
```
