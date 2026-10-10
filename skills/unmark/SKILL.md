---
name: unmark
description: Inspect, decode, or remove hidden marks from text and files, including invisible Unicode, EXIF/C2PA/XMP metadata, PDF/DOCX history, and AI-style signals. Assess whether French or English prose reads as AI-written, with every suspect passage located and a way to fix it. Use image editing for visible pixel watermarks. Use only when the user explicitly asks for unmark, a hidden-mark scan, or an AI-writing check.
metadata:
  opencode/autoinvoke: 'true'
---

# unmark

Finds, decodes and strips marks that travel with text and files: invisible
Unicode carriers, steganographic payloads encoded in them, provenance metadata
in image and document containers, and the habits that make prose read as
generated.

`<skill-dir>` below is the directory this SKILL.md sits in; run the bundled
script by its absolute path, from any working directory:

```bash
node <skill-dir>/scripts/unmark.mjs --help
```

One file, no dependency, no install step. Outside an agent, the same file is
attached to every GitHub release of maxgfr/unmark as `unmark.mjs`.

## Route the request first

Four questions decide everything. Answer them before running anything.

**1. Is this text, or a file?**
Text goes to `inspect` / `decode` / `clean`. A file goes to the same commands —
the format is sniffed from the bytes, not the extension.

**2. Is the user asking about a _mark_, about _style_, or about _authorship_?**
They are different problems and this tool treats them differently.

- A mark is a fact about the file: a zero-width payload, a C2PA manifest, an
  author name, a tracking parameter. `clean` removes these by default.
- Style is how the prose reads: em dashes, filler, rule-of-three cadence. None
  of it is a mark, none of it is removed unless asked, and saying otherwise
  would be the central lie of this category of tool.
- Authorship is "was this written by AI?" — an _assessment_ of the habits, with
  passages located. Go to **Was this written by AI?** below.

**3. Report, or remove?**
**Always `inspect` first.** Show the user what is there before you change their
file. This is not ceremony: the tool reports `likely_false_positive` findings it
deliberately keeps, and the user is the one who decides whether a zero-width
joiner in their Persian text is a watermark or orthography.

**4. Does the fix need a writer?**
If the report says the tells are `rule_of_three`, `marker_vocabulary`,
`recap_loop` or anything in the silhouette layer, no flag fixes those. Go to
**The rewrite loop** below.

## The loop for marks

1. **`inspect`** — changes nothing, prints what is there, where, and how sure.
   What `clean` would strip is marked `removable`; never say it was removed.
   A C2PA manifest is decoded — generator, actions, signer — and labelled
   either _created by generative AI_ or _file passed through an AI tool_; only
   the first says a model made the content. A Word document also lists every
   picture with its paragraph and caption (`Figure 4…`), and a PDF report ends
   with a `scanned:` line saying how many images and attachments were opened.
2. **`decode`** when the report mentions a `stego_payload`. Carriers usually
   _encode_ something — a name, an ID, a URL. Deleting them without reading them
   throws away the only evidence of who marked the text and with what.

   Six schemes are read: zero-width alphabets, tag characters, variation
   selectors, the choice of space character, trailing tabs and spaces at line
   ends, and the choice between a Latin letter and its Cyrillic twin. **The last
   three use no unusual characters at all** — the text contains only ordinary
   ones, arranged unusually — so "no invisible characters found" is not the same
   as "this text is unmarked".

3. **`clean`** to strip. It removes what is removable and leaves what it cannot
   justify removing, listing both.

```bash
node <skill-dir>/scripts/unmark.mjs inspect suspicious.txt
node <skill-dir>/scripts/unmark.mjs decode  suspicious.txt
node <skill-dir>/scripts/unmark.mjs clean   suspicious.txt --in-place
node <skill-dir>/scripts/unmark.mjs audit   ./docs
```

## The two style passes

Off unless asked for. Neither removes a watermark.

- `--typography` — em and en dashes, curly quotes, ellipses to ASCII. French
  guillemets and the apostrophe in _l'été_ are deliberately left alone.
- `--humanise` — filler (`in order to` → `to`), stacked hedges, chat
  pleasantries, signposting, Title Case headings, mechanical boldface,
  decorative emoji. Only patterns with one unambiguous answer.
- `--plain` — both at once.

Two more options for text: `--confusables` maps Cyrillic and Greek lookalikes
back to Latin, and `--paranoid` (see below) strips even load-bearing joiners.

Nothing acts inside a fenced code block, a blockquote, a quotation, a URL or
frontmatter. `in order to` inside a shell snippet is part of a command.

An `inspect` reports what both passes _would_ do even when neither is on, so you
can show the user before suggesting either.

## The rewrite loop

Use rewriting for word choice and the shape of an argument. Its effect on a
statistical watermark is unknown unless measured with the matching detector.
Do not describe a rewrite as removing a watermark or reducing its score.

**In an agent session, you are the model.** No API key, no network call:

```bash
node <skill-dir>/scripts/unmark.mjs brief draft.md > brief.json    # what to fix, what must survive
#   ...you rewrite the document, following the brief...
node <skill-dir>/scripts/unmark.mjs verify new.md --against draft.md
```

`brief`, `verify` and `rewrite` read the prose of a `.docx` or a PDF, as
`detect` does; `rewrite --in-place` refuses one, since it would write plain
text over the document. For a thesis, change sentences, not the file: use
`sweep` below.

`brief` gives you, as JSON: every tell with the layer it belongs to and what a
writer would actually change; every number, date, name, link and quotation that
must survive; and every protected span to reproduce byte for byte.

`verify` checks style, extracted facts and protected spans. It cannot prove
semantic equivalence or watermark removal. It checks your
rewrite and **rejects** it when:

- a flagged pattern came back, or a new one arrived,
- an extracted number, date, link or quotation was added or lost,
- an extracted name went missing (name detection is heuristic),
- a protected block or inline code span was edited or an occurrence lost.

Exit code 1, with each failure named. **Read the failures and aim the next
attempt at them.** Do not resubmit a rewrite that has not changed.

**The stopping rule: if `verify` rejects the same finding three times, stop.**
Tell the user which sentence needs a person and why. Three failed attempts on
one sentence means the constraint and the content are in conflict, and a fourth
attempt produces mangled prose, not a fix.

From a terminal without an agent, `unmark rewrite` runs the same loop against a
local model on `127.0.0.1` (nothing leaves the machine), or `--model <id>` for a
remote provider, or `--print-prompt` to get the prompt and spend nothing.
`--attempts <n>` sets how many tries it gets before it gives up and says why
(default 3). `--version` prints the version of the bundle.

## Was this written by AI?

`detect` gives an assessment, never proof, in French and English. You are the
**judge** of what it found: the engine counts habits; you read the passages
and decide which ones hold up. Load `references/authorship.md` before writing
the report — it holds the verdict scale, the judge's rules and the template.

1. Run the engine and keep its JSON:

   ```bash
   node <skill-dir>/scripts/unmark.mjs detect draft.md --json > detect.json
   ```

   Exit 3, `insufficient_evidence`: say so and stop. Under 150 words there is
   no verdict, and you do not supply one.

2. Judge every passage in the `high` and `medium` bands: **confirm** or
   **reject** it, one line each, citing its line number. Reject what the
   subject, a formal register or a second-language writer explains. On a
   careful text no sentence reaches a band, and this step has nothing in it:
   then the passages to judge are the `medium` rows of `sweep` (below), and
   you judge those instead.
3. Add your own `JUDGE_OBSERVATION`s, each tied to a line: the horoscope test
   (a sentence that fits any subject), genericity, fabricated precision
   (figures or sources nobody could check), a register that never varies.
4. Write the report from the template in `references/authorship.md`, with the
   engine's `disclaimer` copied word for word under the verdict.

You may move the engine's verdict **one level**, and only by citing a line.
The top of the scale is `likely_ai`; `confirmed` belongs to technical marks.
A text with chat residue or a technical mark stays `uncertain` at best.

**Any file with prose.** `detect` reads `.txt`, `.md`, `.html`, the body of a
`.docx` (tables, captions, contents and the reference list left out) and a PDF
page by page. Options, all documented in `--help`:

- `--pages <file.pdf>`: the printed PDF of the same document; every passage is
  placed as `p. 29, §2.6.3` (`location: {paragraph, page, section}` in JSON).
- `--source <file>`: the .docx or PDF a text file was extracted from. Its
  container marks (a C2PA manifest on a figure…) come back as `fileMarks`,
  labelled as marks of the file, never of the prose; a confirmed one keeps the
  verdict at `uncertain` at best, like a mark in the text.
- `--register academic`: also reads the formulas of academic writing ("to our
  knowledge", "c'est dans ce contexte que"), tier 3; alone they are listed under
  not evidence. `coverage` says how much of the catalogue applied, so a 0.00
  can be told from "out of the catalogue's reach".
- `--top <n>`: the n sentences scoring highest, whatever their band — material
  for the judge when nothing reaches a band.
- `--lang fr|en|auto`, `--min-score <0..1>` (filters the list, never the
  verdict), `--format text|md|json` (`md` is a report to share), `--json`.

A document that changes language (a French thesis around an English article)
is cut into `blocks`, each assessed with its own catalogue; the verdict is
their word-weighted combination. `language.unsupported` lists the paragraphs
read as a language with no catalogue. `recaps` lists key phrases copied word
for word into several sections. Hedging and wordy phrasing are reported in
`findings` (categories `hedging`, `phrasing`) and weigh nothing in the score
until a refit measures them.

**The judge's worksheet is `sweep`.** Run it whenever the user wants the
passages, not only the verdict, and always before writing the judge section:

```bash
node <skill-dir>/scripts/unmark.mjs sweep thesis.docx --pages thesis.pdf --json > sweep.json
node <skill-dir>/scripts/unmark.mjs sweep thesis.docx --print-prompt > prompt.txt
#   ...you write the rewrites as [{"id": "S123", "rewrite": "…"}] in rewrites.json...
node <skill-dir>/scripts/unmark.mjs sweep thesis.docx --pages thesis.pdf --apply rewrites.json --format md
```

Every row is a sentence carrying a habit, however isolated: its location, the
habit (stacked hedges, a formula repeated across sections, a stock formula, a
closing line, a recap connector, connectors in series, a triad, a figure with
no reference call, dashes, catalogue vocabulary), a confidence, whether the
register explains it, the current text quoted and checked word for word in the
source file (and the `--pages` PDF), and a rewrite. A rewrite is shown only if
it cleared the gate: every number and reference call of the sentence kept, the
habit it was asked to remove gone, no new pattern of the catalogue, and not a
copy of the sentence. An empty rewrite deletes the sentence, and is accepted
only when the sentence carries no figure and no reference call. Otherwise the
row says the rewrite was rejected and why. A figure without its reference call
is not offered for rewriting — only the author knows the call — and the row
says so. `--apply` prints on stderr how many rewrites were verified, rejected,
or named an id the sweep does not have, and exits 1 when any was rejected or
unknown. `--rewrite` asks the local model on 127.0.0.1 instead of you; with
`--model`, a remote provider, and the sentences leave the machine. Confirm or
reject each `medium` row in the report; the `low` ones are suggestions for the
author, never evidence. `sweep` gives the same `verdict` and `fileMarks` as
`detect`.

**To fix what reads as AI**, send the user through the rewrite loop above
(`brief` → rewrite → `verify`), then run `detect` again on the result.

## What it will not do

**It does not strip invisible characters that are load-bearing.** A ZWJ between
two emoji is what makes 👨‍👩‍👧 one family instead of three people; a ZWNJ inside a
Persian word is orthography, not a watermark. Those are reported as
`likely_false_positive` and kept. `--paranoid` removes them anyway and will
corrupt real text — only reach for it when the user asked for exactly that.

**It does not touch pixels.** Visible watermarks, generator badges and
inpainting need a canvas. Point the user at <https://maxgfr.github.io/unmark/>,
which runs the same core plus the image pipeline, entirely in their browser.

**It cannot promise a statistical watermark is gone.** No vendor detector is
used. The repository lab measures a public test key, and its results must not
be extrapolated to Claude or Gemini. `verify` proves the rewrite cleared _our_ gates.
It proves nothing about theirs. Say that plainly rather than letting a passing
verify imply more than it means.

**Some PDFs are refused, on purpose.** Encrypted, signed, or too damaged to
rebuild — see `references/formats.md`. A refusal that says why is the correct
outcome; a plausible broken file is not.

## References

Load these when you need them, not before.

- `references/verdicts.md` — the four verdicts, the outcome column, and how to
  report each one to a user without overstating it.
- `references/formats.md` — every format, and per format what is stripped, what
  is deliberately kept, and what is refused.
- `references/recipes.md` — worked sequences for the requests that actually
  arrive, with the output shape to expect.
- `references/authorship.md` — the authorship verdicts, bands and evidence
  labels, the judge's rules, and the report template.
