# Third-party work in the authorship assessment

The authorship assessment (`src/core/text/authorship/`, `src/core/text/lexicon/`,
`scripts/eval-authorship.mjs`) builds on four projects. None of their code is
bundled; what is taken is structure, method and, for the corpus, data. Each is
credited here with its licence notice.

| Project                                                             | What unmark takes from it                                                                                                                                                                                                                                                                                     | Licence    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [humanizer-fr](https://github.com/Matthieusabourin2/humanizer-fr)   | the three-tier split of French AI-writing vocabulary and the idea of trap lists for legitimate uses (`lexicon/fr.ts`, `catalogue/fr.ts`)                                                                                                                                                                      | MIT        |
| [ADAFAI](https://github.com/virajshoor/ADAFAI)                      | the per-sentence score with floors, bands and `low_confidence`, and abstention below a length (`spans.ts`, `verdict.ts`)                                                                                                                                                                                      | MIT        |
| [the-antislop](https://github.com/aplaceforallmystuff/the-antislop) | structure ranked above vocabulary, the `Line / Excerpt / Pattern` report, audit-only use (`catalogue/*.ts`, `report.ts`)                                                                                                                                                                                      | MIT        |
| [binoculars-eu](https://github.com/linagora/binoculars-eu)          | the evaluation protocol (frozen corpus pinned by hash, fixed split, AUROC, true-positive rate at 1 % false positives, bootstrap intervals) and its French corpus, fetched at commit `575c9fcd22d905b6cd3765769aec2b4fc40f6c66`; a few of its generated and humanised texts are part of `fixtures/authorship/` | Apache-2.0 |

The binoculars-eu corpus as a whole is only fetched into `.cache/` by
`scripts/fetch-authorship-corpus.mjs` and is never committed: some of its human
texts are press articles and blog posts whose own licences it does not state.
The texts copied into `fixtures/authorship/` are generated or humanised ones,
listed with their origin in `fixtures/authorship/manifest.json`. binoculars-eu
ships no NOTICE file.

## humanizer-fr

```
MIT License

Copyright (c) 2025 Adam Boudjemaa (humanizer-skill, upstream)
Copyright (c) 2026 contributors of the humanizer-fr fork

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ADAFAI

```
MIT License

Copyright (c) 2026 Viraj Shoor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## the-antislop

```
MIT License

Copyright (c) 2026 Jim Christian

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## binoculars-eu

Licensed under the Apache License, Version 2.0; the full text is at
<https://www.apache.org/licenses/LICENSE-2.0> and in `.cache/authorship-corpus/binoculars-eu/LICENSE`
once the corpus is fetched. Texts taken from its corpus are used unmodified,
except the humanised ones, which are used exactly as that corpus publishes them.
