# unmark — visual world

## Thesis

**A forensic report, not a magic button.** The category ships one button and asks
for trust. unmark shows its work: every mark named, located, graded, and legible
before anything is removed. The page should read like a lab result — evidence in
columns, one signal colour, nothing decorative competing with the finding.

Mode: **Operate.** The visitor is completing a task and needs to scan a table,
not be persuaded.

## Ground and palette

Dark by decision. The page is read beside a terminal and a code editor, and its
central object is a log-like table.

| Token      | Value     | Role                                             |
| ---------- | --------- | ------------------------------------------------ |
| `--ground` | `#0b0b0c` | page                                             |
| `--panel`  | `#121214` | raised regions: input fields, table headers      |
| `--rule`   | `#26262a` | hairlines; the only structural divider           |
| `--bone`   | `#e8e6e1` | body and data                                    |
| `--muted`  | `#8b8a86` | labels, secondary data (6.5:1 on ground)         |
| `--signal` | `#ffb020` | **confirmed findings and decoded payloads only** |
| `--clean`  | `#6ee7a8` | the "nothing found" state, and nothing else      |

One amber. It is reserved for a `confirmed` verdict and for a recovered payload
— the two things a user came to see. Spending it anywhere else destroys the only
scanning affordance the table has.

Verdicts are graded by weight and colour together, never colour alone:
`confirmed` amber at 500, `probable` bone, `informational` muted,
`likely_false_positive` muted and struck through.

## Type

Two self-hosted faces, no system fallback as the voice.

- **IBM Plex Sans** — headings, labels, prose. Drawn for technical
  documentation, which is the register this page is in. Space Grotesk was the
  first choice and was dropped: it is one of the handful of faces every recent
  interface converges on, so it reads as a default rather than a decision.
- **JetBrains Mono** (400/500/700) — every measurement: offsets, codepoints,
  byte counts, payloads, evidence, cleaned output.

Monospace here is for data, not costume: the product's subject is literally
codepoints and byte offsets. Prose is never monospace.

Tabular figures everywhere numbers appear in a column — offsets jitter otherwise
as a report updates.

## Structure

Hairline-ruled sections, not cards. A card grid would turn a report into a
dashboard; the rule is what makes the table read as a document. Radius is 0 on
regions and 6px on small controls only.

Layout is two columns on wide screens — input on the left, report on the right —
and stacks below 1024px with the **input first**. The first draft put the report
first there, reasoning that after a paste the report is what you want to see.
That is true after a paste and wrong before one: on a first visit it buried the
textarea under an empty findings panel you had to scroll past to reach. Do the
thing, then read the result.

The header carries a masthead spec block on wide screens — build, format count,
uploads — set right against the lede. A report states its own parameters, and it
gives the top band something to be other than empty.

## Motion

One authored moment: findings enter with a 12ms-staggered, exponential ease-out
rise as a report resolves. Nothing else animates on arrival. Under
`prefers-reduced-motion` the stagger is dropped and the rows simply appear.

## Browser surfaces

Selection, caret, scrollbars, focus ring and the table's numerals are themed from
the palette. A default blue selection would be the loudest colour on the page.

## Refuses

- Cards as page structure; nested cards.
- Emoji or Unicode glyphs standing in for icons — icons are authored SVG, 1.5px
  stroke, 16px grid.
- Gradient text, glass, decorative blur.
- A hero metric. The count of findings is not the point; the findings are.
- Any reassurance the engine cannot support.
