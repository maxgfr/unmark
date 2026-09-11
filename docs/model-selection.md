# Browser model selection — 10 September 2026

The browser now uses **Qwen3.5 0.8B, q4f16_1**, through pinned WebLLM 0.2.85.
Fable 5.1 was the coding agent for the language gate and its regression tests;
it is not downloaded or called by the application.

## Why this model

The requirement was a recent multilingual model with a memory target below
2 GB, running locally in the existing WebLLM application.

| Candidate          | Evidence                                                                                                              | Decision                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Qwen3.5 0.8B q4f16 | WebLLM catalog estimates 1,629.49 MB GPU memory; compiled browser runtime available                                   | Selected; measured below 2 GB on the test machine                   |
| Qwen3.5 0.8B q4f32 | Catalog estimate 1,894.19 MB GPU memory                                                                               | Less headroom than f16                                              |
| Qwen3.5 2B q4f16   | Catalog estimate 2,245.44 MB GPU memory                                                                               | Exceeds target                                                      |
| Gemma 4 E2B        | Recent lightweight Google model; standard Q4_0 estimate around 2.9 GB; mobile LiteRT-LM has a smaller text deployment | No released compatible WebLLM binary; MLC integration remains draft |

Sources: [WebLLM catalog](https://github.com/mlc-ai/web-llm/blob/main/src/config.ts),
[Qwen3.5 0.8B model card](https://huggingface.co/Qwen/Qwen3.5-0.8B),
[Gemma 4 release](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/),
[Google memory estimates](https://ai.google.dev/gemma/docs/core),
[MLC Gemma 4 integration](https://github.com/mlc-ai/mlc-llm/pull/3485),
[compiler support](https://github.com/mlc-ai/relax/pull/346).
Availability was checked on the date above. This is a choice among verified
compatible options, not a claim that no newer model exists anywhere.

The asset manifest pins the complete model and WASM runtime by upstream commit,
byte size and SHA-256, totalling **453,205,372 bytes** served. A visitor
downloads **443,112,645 bytes** of that: the model config names four tokenizer
files and the runtime stops at the first that works, so `vocab.json`,
`merges.txt` and `tokenizer_config.json` are served and allowlisted but never
fetched. A real headed load on 10 September 2026 fetched 15 files and no others.
Downloads are not resident memory. WebGPU **shader-f16** is required; unsupported devices retain
basic cleaning without downloading weights. Context is 4,096 tokens, output is
capped at 1,024 tokens, and recurrent history is limited to one entry.

## Actual browser checks

Headed Chromium on the development Mac, Ultra mode, assets served from localhost:

- Nine inputs: informal French, French grammar, Spanish, German, French prose,
  French dates/names/numbers, French filler, English facts, and protected code,
  URL and quotation.
- All nine retained their language and passed the content checks.
- The grammar example changed `Nous avons préparer` to `Nous avons préparé`
  and `nous sommes prêt` to `nous sommes prêts`; the next sentence stayed intact.
- The other eight inputs were returned unchanged, including `bonjour c cool`.
  This demonstrates a working conservative rewrite, not broad stylistic quality.
- First inference including initialization: 3,962 ms; subsequent examples:
  806–1,309 ms. Network download times on a public site will differ.
- Sum of resident memory for the owned Chromium process tree, sampled every
  200 ms with `ps`: peak **1,927,659,520 bytes (1.93 GB)**; final sample
  **809,484,288 bytes (0.81 GB)**. This includes browser processes but is only an
  approximate measurement: shared pages can be counted twice and GPU/driver
  accounting varies. It is not a hard 2 GB guarantee on every device.

The repeatable hardware check is
`UNMARK_HEADED=1 UNMARK_MODE=ultra node scripts/smoke-text-model.mjs` after building
and fetching assets. It downloads through the settings panel and checks the panel's
own storage and memory rows, then verifies French grammar, Spanish and German, then
cached and offline French reloads, with only same-origin GET requests and no further
model downloads after the panel's.

## Measured ceiling on text length

A French text full of deliberate mistakes (agreement, homophones, accents,
conjugation), grown paragraph by paragraph on the development machine:

| Paragraphs | Words | Seconds | Rewrite used | Mistakes repaired              |
| ---------- | ----- | ------- | ------------ | ------------------------------ |
| 1          | 38    | 3       | yes          | 5 of 6                         |
| 2          | 82    | 2       | yes          | 6 of 12                        |
| 3          | 125   | 3       | yes          | 10 of 15                       |
| 4          | 160   | 4       | yes          | 15 of 19                       |
| 6          | 242   | 6       | yes          | 14 of 19                       |
| 8          | 320   | 15      | no           | model dropped 1622 and 1673    |
| 12         | 480   | 25      | no           | same                           |
| 16         | 640   | 20      | no           | hit the 1,024-token answer cap |

Long documents are now cut into sections of about 180 words, rewritten one at a
time and concatenated, so the ceiling above applies per section rather than per
document. Re-measured with sectioning on:

| Paragraphs | Words | Seconds | Rewrite used | Mistakes repaired |
| ---------- | ----- | ------- | ------------ | ----------------- |
| 4          | 160   | 6       | yes          | 15 of 19          |
| 8          | 320   | 8       | yes          | 15 of 19          |
| 12         | 480   | 11      | yes          | 15 of 19          |
| 16         | 640   | 16      | yes          | 15 of 19          |

The three sizes that failed outright before now pass at the same repair rate as
a short text, and the time grows roughly with the length.

Without sectioning the working range was roughly up to 250 words, where two thirds to four
fifths of the mistakes are repaired. Past that the model stops returning the
whole passage: it drops sentences, the content checks correctly report a lost
date, and the page now says why rather than only naming the number. These are
real refusals, not false positives — the rewrite really had lost the fact.

## Language preservation

The prompt explicitly preserves the source language. The shared verification
step independently checks detected languages before accepting a rewrite. It
excludes protected quotes, code, blockquotes and links, and considers passages
separately so bilingual documents keep both languages. A refusal names the
language constraint for the next attempt; exhausted attempts retain the cleaned
source.

Two local detectors and plausible alternatives reduce false refusals, including
French that one detector mistakes for Portuguese. Ambiguous short inputs can
remain undetermined, and close languages can be confused. The gate is not proof
of language or semantic equivalence. Deterministic injected translations test
refusal and recovery independently of how the real model happens to respond.

The runtime inserts an empty thinking wrapper even when thinking is disabled.
Only that exact injected prefix is removed; arbitrary model commentary and
nonempty reasoning are still rejected.

The earlier Qwen2.5 0.5B investigation is retained as
[historical evidence](local-rewrite-check.md).
