# Recipes

The requests that actually arrive, and the sequence for each. Every command here
is run by `pnpm verify:skill`, so if one of them stops working, CI says so.

## "Someone sent me this paragraph — is it marked?"

```bash
node <skill-dir>/scripts/unmark.mjs inspect paste.txt
node <skill-dir>/scripts/unmark.mjs decode  paste.txt     # only if a stego_payload was reported
```

Read the payload aloud to the user before offering to remove anything. The
carriers are how it was hidden; the payload is _who marked it_, and deleting the
first without reading the second throws away the only evidence.

If `inspect` reports nothing, say what that does and does not mean: three of the
six schemes hide in ordinary characters, and a statistical watermark leaves no
character trace at all.

## "Clean this document before I forward it"

```bash
node <skill-dir>/scripts/unmark.mjs inspect report.docx        # show them first
node <skill-dir>/scripts/unmark.mjs clean   report.docx --in-place
node <skill-dir>/scripts/unmark.mjs inspect report.docx        # prove it
```

Re-inspecting is the step people skip. It turns "I cleaned it" into something
the user can see.

For a DOCX specifically, name what came off: tracked-change authors, `people.xml`,
revision save ids, the rendered thumbnail of page one, and the EXIF inside every
embedded image. Users are usually surprised by the last two.

## "Was this written by AI?"

```bash
node <skill-dir>/scripts/unmark.mjs detect essay.md --json > detect.json
node <skill-dir>/scripts/unmark.mjs detect essay.md --format md      # the engine's report as Markdown
```

Follow **Was this written by AI?** in SKILL.md: judge each `high` and `medium`
passage, add observations with line numbers, and write the report from the
template in `authorship.md`. Exit 3 means under 150 words or an unsupported
language: say that, and give no verdict.

If the user means to act on the answer about someone else — a student, an
applicant, a colleague — say before anything else that this is not proof and
must not decide a sanction.

## "Fix what reads as AI"

```bash
node <skill-dir>/scripts/unmark.mjs detect  draft.md                 # where, and why
node <skill-dir>/scripts/unmark.mjs clean   draft.md --plain         # the deterministic half
node <skill-dir>/scripts/unmark.mjs brief   draft.md > /tmp/brief.json
#   ...rewrite, aiming at the passages detect listed...
node <skill-dir>/scripts/unmark.mjs verify  rewritten.md --against draft.md
node <skill-dir>/scripts/unmark.mjs detect  rewritten.md             # did it move
```

`--plain` removes the filler and chat residue that has one right answer. Stock
phrases, school connectors, "not just X but Y", triads and recap endings need a
writer: that is the rewrite loop below. A lower `detect` score afterwards means
fewer of these habits, not that a detector — or a watermark — has been beaten.

## "Rewrite it properly" — the loop

```bash
node <skill-dir>/scripts/unmark.mjs brief draft.md > /tmp/brief.json
```

Read the brief. Rewrite the document yourself following it: fix each tell, keep
every listed fact, reproduce every protected span byte for byte.

```bash
node <skill-dir>/scripts/unmark.mjs verify rewritten.md --against draft.md
```

- **Exit 0** — it cleared every gate. Tell the user what it cannot promise: a
  reduced SynthID-Text score, not a removed watermark, and no vendor detector
  was involved.
- **Exit 1** — read each failure and aim the next attempt at it. Do not resubmit
  unchanged text.
- **Same finding rejected three times** — stop. Name the sentence and hand it
  back. The constraint and the content are in conflict, and a fourth attempt
  produces mangled prose rather than a fix.

## "Audit this repo for marked files"

```bash
node <skill-dir>/scripts/unmark.mjs audit ./docs
node <skill-dir>/scripts/unmark.mjs audit ./docs --json > audit.json
```

Exits 1 when anything is marked, so it works in a pre-commit hook. It skips
`node_modules`, `.git`, `dist`, `coverage`, `.next` and `build`, and anything
over 64 MB.

## "This PDF is signed — now what?"

`clean` refuses by default, and it is right to. Any edit voids the signature, and
a silently broken signature is worse than an uncleaned file.

Give the user the actual choice:

1. Leave it signed and send it as-is; the metadata stays.
2. Accept that the signature dies — `unmark clean signed.pdf --force` — and
   re-sign afterwards if that matters.
3. Extract the content and produce a fresh document.

Only take path 2 if they say so, and say out loud that the signature is now void.

The same shape applies to an encrypted PDF, except there is no option 2: nothing
was read, so nothing can be reported. "I could not see inside this file" is the
honest answer and the tool gives it rather than reporting a clean file.

## "Is there GPS in these photos?"

```bash
node <skill-dir>/scripts/unmark.mjs audit ./photos
```

HEIC and AVIF are handled, which matters because every recent iPhone photo is
HEIC. So is the `©xyz` location atom in a `.mov`. Report what was found before
stripping it — a photographer may want the location kept.

## "Go through my thesis and tell me every sentence that reads as generated"

```bash
node <skill-dir>/scripts/unmark.mjs detect thesis.docx --pages thesis.pdf --register academic --top 10 --json > detect.json
node <skill-dir>/scripts/unmark.mjs sweep  thesis.docx --pages thesis.pdf --print-prompt > prompt.txt
# write rewrites.json from the prompt: [{"id": "S…", "rewrite": "…"}]
node <skill-dir>/scripts/unmark.mjs sweep  thesis.docx --pages thesis.pdf --apply rewrites.json --format md > sweep.md
```

Expect: a verdict per language block and a combined one, the figures' C2PA
statements under file marks, and a table "current text → replace with" by
section, every quote checked in the .docx and the PDF. Rewrites that dropped a
number or a reference call are marked rejected; rewrite those again.

## "I only have the extracted text, but the .docx had a C2PA image"

```bash
node <skill-dir>/scripts/unmark.mjs detect extracted.txt --source thesis.docx --json
```

`fileMarks` carries the container's marks; they hold the verdict above
`likely_human` and say nothing about who wrote the prose.
