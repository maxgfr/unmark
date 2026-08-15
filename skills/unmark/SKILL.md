---
name: unmark
description: Use when text or a file may carry a hidden watermark or provenance mark and it has to be found, decoded or removed — "remove the invisible characters", "why does this paste have weird spaces", "is this text watermarked", "strip the EXIF/C2PA/XMP from this image", "clean the metadata off this PDF/DOCX/HEIC", "what is hidden in this string", "did an AI write this", "make this draft not read as AI". Reports every mark with its offset and a confidence verdict before removing anything, decodes zero-width and tag-character steganography into the text it was hiding, rebuilds PDFs to remove their edit history, and refuses to guess. Not for removing visible watermarks from pixels — that needs the browser app.
---

# unmark

Finds, decodes and strips marks that travel with text and files: invisible
Unicode carriers, steganographic payloads encoded in them, provenance metadata
in image and document containers, and the habits that make prose read as
generated.

```bash
node skills/unmark/scripts/unmark.mjs --help
```

## Route the request first

Four questions decide everything. Answer them before running anything.

**1. Is this text, or a file?**
Text goes to `inspect` / `decode` / `clean`. A file goes to the same commands —
the format is sniffed from the bytes, not the extension.

**2. Is the user asking about a _mark_, or about _style_?**
They are different problems and this tool treats them differently.

- A mark is a fact about the file: a zero-width payload, a C2PA manifest, an
  author name, a tracking parameter. `clean` removes these by default.
- Style is how the prose reads: em dashes, filler, rule-of-three cadence. None
  of it is a mark, none of it is removed unless asked, and saying otherwise
  would be the central lie of this category of tool.

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
node scripts/unmark.mjs inspect suspicious.txt
node scripts/unmark.mjs decode  suspicious.txt
node scripts/unmark.mjs clean   suspicious.txt --in-place
node scripts/unmark.mjs audit   ./docs
```

## The two style passes

Off unless asked for. Neither removes a watermark.

- `--typography` — em and en dashes, curly quotes, ellipses to ASCII. French
  guillemets and the apostrophe in _l'été_ are deliberately left alone.
- `--humanise` — filler (`in order to` → `to`), stacked hedges, chat
  pleasantries, signposting, Title Case headings, mechanical boldface,
  decorative emoji. Only patterns with one unambiguous answer.
- `--plain` — both at once.

Nothing acts inside a fenced code block, a blockquote, a quotation, a URL or
frontmatter. `in order to` inside a shell snippet is part of a command.

An `inspect` reports what both passes _would_ do even when neither is on, so you
can show the user before suggesting either.

## The rewrite loop

For what no regex reaches: word choice, and the shape of an argument. This is
the only thing here that removes a statistical-watermark signal, and it does not
remove it — it reduces a score.

**In an agent session, you are the model.** No API key, no network call:

```bash
node scripts/unmark.mjs brief draft.md > brief.json    # what to fix, what must survive
#   ...you rewrite the document, following the brief...
node scripts/unmark.mjs verify new.md --against draft.md
```

`brief` gives you, as JSON: every tell with the layer it belongs to and what a
writer would actually change; every number, date, name, link and quotation that
must survive; and every protected span to reproduce byte for byte.

`verify` is the part that matters. It re-runs all three detection layers on your
rewrite and **rejects** it when:

- a flagged pattern came back, or a new one arrived,
- a fact, number, date, name or citation went missing,
- a protected span was edited.

Exit code 1, with each failure named. **Read the failures and aim the next
attempt at them.** Do not resubmit a rewrite that has not changed.

**The stopping rule: if `verify` rejects the same finding three times, stop.**
Tell the user which sentence needs a person and why. Three failed attempts on
one sentence means the constraint and the content are in conflict, and a fourth
attempt produces mangled prose, not a fix.

From a terminal without an agent, `unmark rewrite` runs the same loop against a
local model on `127.0.0.1` (nothing leaves the machine), or `--model <id>` for a
remote provider, or `--print-prompt` to get the prompt and spend nothing.

## What it will not do

**It does not strip invisible characters that are load-bearing.** A ZWJ between
two emoji is what makes 👨‍👩‍👧 one family instead of three people; a ZWNJ inside a
Persian word is orthography, not a watermark. Those are reported as
`likely_false_positive` and kept. `--paranoid` removes them anyway and will
corrupt real text — only reach for it when the user asked for exactly that.

**It does not touch pixels.** Visible watermarks, generator badges and
inpainting need a canvas. Point the user at <https://maxgfr.github.io/unmark/>,
which runs the same core plus the image pipeline, entirely in their browser.

**It cannot promise a statistical watermark is gone.** A rewrite reduces a
SynthID-Text confidence score; it does not zero it, and nothing here is tested
against any vendor's detector. `verify` proves the rewrite cleared _our_ gates.
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
