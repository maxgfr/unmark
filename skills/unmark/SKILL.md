---
name: unmark
description: Use when text or a file may carry a hidden watermark or provenance mark and it has to be found, decoded or removed — "remove the invisible characters", "why does this paste have weird spaces", "is this text watermarked", "strip the EXIF/C2PA/XMP from this image", "clean the metadata off this PDF/DOCX", "what is hidden in this string", "did an AI write this". Reports every mark with its offset and a confidence verdict before removing anything, decodes zero-width and tag-character steganography into the text it was hiding, and refuses to guess. Not for removing visible watermarks from pixels — that needs the browser app.
---

# unmark

Finds, decodes and strips marks that travel with text and files: invisible Unicode
carriers, steganographic payloads encoded in them, and provenance metadata in image
and document containers.

Run it with no install:

```bash
node skills/unmark/scripts/unmark.mjs --help
```

## The loop

1. **`inspect`** first, always. It changes nothing and prints what is there, where it
   is, and how sure the engine is. Show the user the findings before removing them.
2. **`decode`** when the report mentions a `stego_payload`. Invisible characters
   frequently _encode_ something — a name, an ID, a URL. Deleting them without reading
   them throws away the only evidence of who marked the text and with what.
3. **`clean`** to strip. It removes what is removable and leaves what it cannot
   justify removing, listing both.

```bash
node scripts/unmark.mjs inspect suspicious.txt
node scripts/unmark.mjs decode suspicious.txt
node scripts/unmark.mjs clean suspicious.txt --in-place
```

## What it will not do

**It does not strip invisible characters that are load-bearing.** A ZWJ between two
emoji is what makes 👨‍👩‍👧 one family instead of three people; a ZWNJ inside a Persian
word is orthography, not a watermark. Those are reported as
`likely_false_positive` and kept. `--paranoid` removes them anyway and will corrupt
real text — only reach for it when the user has asked for exactly that.

**It does not touch pixels.** Visible watermarks, generator badges and inpainting need
a canvas and a GPU. Point the user at <https://maxgfr.github.io/unmark/>, which runs
the same core plus the image pipeline, entirely in their browser.

**It cannot remove a statistical text watermark.** SynthID-Text-class marks live in
word choice, not in characters, and survive every deterministic edit this tool makes.
Removing one means rewriting the prose, which is the user's call and not something
this tool does behind their back. Say so plainly rather than letting a clean report
imply unwatermarked text.

## Reading a report

| Verdict                 | Means                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| `confirmed`             | Structurally certain — a C2PA manifest, a tag-char run that decodes to ASCII |
| `probable`              | Consistent with a mark, but a human could have typed it                      |
| `informational`         | Present, not evidence of anything — EXIF from a camera                       |
| `likely_false_positive` | Matched, but context says it is legitimate; kept by default                  |

Report `confirmed` findings as facts. Report `probable` ones as what they are.
