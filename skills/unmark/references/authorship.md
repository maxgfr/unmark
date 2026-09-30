# Authorship assessment

`unmark detect` reads how prose is written — vocabulary, sentence structure,
repetition, document shape, chat residue — and says how much of it matches the
habits of generated text. It is an assessment of habits. People write this way
too, and generated text can be edited until none of it shows.

## Verdicts

| Verdict                 | Exit | Say it as                                                          |
| ----------------------- | ---: | ------------------------------------------------------------------ |
| `likely_ai`             |    1 | "Likely AI-written" — several independent habits agree             |
| `uncertain`             |    0 | "Uncertain: not enough to call it either way"                      |
| `likely_human`          |    0 | "Few AI-writing signals found" — never "written by a person"       |
| `insufficient_evidence` |    3 | "Not enough text to assess", or the language is not French/English |

Two guards stand behind `likely_ai`: it needs at least two independent signals
at 0.5 or more, and chat residue ("I hope this helps", "[Your Name]") lifts the
score to the threshold without replacing that corroboration. A text carrying
residue or a technical mark is never called `likely_human`.

The report names its **calibration** (`provisional-0` until fitted, then
`fit-<date>-<corpus>`). Quote it: a verdict is only as good as the corpus its
thresholds came from.

## Bands

Every sentence gets a score from 0 to 1, and a band: `high` (0.60 and up),
`medium` (0.35), `low` (0.15), `none`. A sentence under eight words is scored
and flagged `lowConfidence`. Floors: chat residue 0.90, a mixed-script word
0.90, an invisible carrier 0.85.

## Evidence labels

| Label               | What it is                                            | May support                          |
| ------------------- | ----------------------------------------------------- | ------------------------------------ |
| `TECHNICAL_MARK`    | a carrier, payload, citation token, mixed-script word | `confirmed` findings, from `inspect` |
| `CHAT_RESIDUE`      | text left over from a chat window, a template slot    | `likely_ai`, with corroboration      |
| `STYLE_HEURISTIC`   | a catalogue habit: vocabulary, structure              | `likely_ai`, with corroboration      |
| `MEASURED_FEATURE`  | repetition, diversity, rhythm, document shape         | `likely_ai`, with corroboration      |
| `JUDGE_OBSERVATION` | what you add, tied to a line                          | one level of movement, no more       |

`confirmed` belongs to technical marks only. Nothing about style reaches it.

## The judge's rules

You read the passages the engine flagged, and you are the second opinion it
does not have. Hold to these:

1. **One level.** You may move the engine's verdict one step (`likely_ai` ↔
   `uncertain` ↔ `likely_human`), and each move cites the line that justifies it.
   The floor is `uncertain` whenever `findings` holds chat residue or
   `technicalMarks` is not empty: "few signals" is never said about a text
   carrying either.
2. **Abstentions stay abstentions.** `insufficient_evidence` is the answer for
   a short text; you do not supply the verdict the engine declined to give.
3. **The disclaimer is copied word for word** from the report's `disclaimer`
   field, directly under the verdict.
4. **What is not evidence:** the subject (a text about AI is not AI-written),
   a formal, administrative or academic register, phrasing typical of a
   second-language writer, clean spelling and grammar, em dashes or one stock
   phrase on their own. Reject any passage that one of these explains, and
   say which.
5. **Your own observations** each carry a line number and one of:
   - _horoscope test_ — the sentence would fit any subject;
   - _genericity_ — claims with no particular case, name or example behind them;
   - _fabricated precision_ — figures, dates or sources nobody could check;
   - _uniform register_ — not one sentence shorter, looser or more personal
     than the rest.

## Template

Write the report in this shape. Fill every section; write "none" rather than
dropping one.

```markdown
# Authorship assessment

**Engine:** <verdict sentence> · score <0.00> · confidence <low|medium|high> · <language> · <n> words · calibration `<id>`
**Judge:** <verdict sentence> — <kept | moved from X: one-line reason citing line N>

> <disclaimer, verbatim>

## Why

- <3 to 5 bullets, each tied to a signal or a confirmed passage>

## Passages

| Line | Excerpt | Pattern                  | Engine reason | Judge                       | Fix |
| ---: | ------- | ------------------------ | ------------- | --------------------------- | --- |
|   12 | …       | fr.struct.que_vous_soyez | …             | confirmed / rejected: <why> | …   |

## Judge observations

- line <N> — <horoscope test | genericity | fabricated precision | uniform register>: <what, in one sentence>

## What is not evidence here

- <each rejected passage and the reason it was set aside, plus the report's `notEvidence` list>

## How to fix

- <grouped by what to do, most frequent first>
- Checked rewrite: `unmark brief` → rewrite → `unmark verify`, then `unmark detect` again.
```

## Reading the JSON

| Field              | Use                                                            |
| ------------------ | -------------------------------------------------------------- |
| `verdict`, `score` | the engine's answer; `score` is `null` when it abstains        |
| `abstainReason`    | `too_short` or `unsupported_language`                          |
| `signals[]`        | one per habit family; `value: null` means not measurable       |
| `spans[]`          | sentences in a band, with `line`, `band`, `reasons`, `excerpt` |
| `findings[]`       | each counted habit: `patternId`, `line`, `reason`, `fixHint`   |
| `technicalMarks[]` | marks from the existing passes, with their own verdicts        |
| `disclaimer`       | copy it                                                        |

Pattern ids read `lang.category.name`: `fr.lex.plongeons`,
`en.struct.negative_parallelism`, `any.residue.placeholder`. Tier 1 habits
count alone; tier 2 only when two share a paragraph; tier 3 only beside
something else.
