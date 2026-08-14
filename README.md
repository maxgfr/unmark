# unmark

**[maxgfr.github.io/unmark](https://maxgfr.github.io/unmark/)** — find, decode and
remove watermarks and provenance marks, in your browser or from your terminal.

Invisible characters in text. Metadata in files. Watermarks drawn into images.
Every mark is named, located and graded before anything is stripped, and what
cannot be removed is stated on the screen that does the removing.

```bash
npx skills add maxgfr/unmark    # the same engine, as a Claude skill and a CLI
```

## Why

Two good open-source projects each solve half of this, and neither runs in a
browser: [`watermarks-remover`](https://github.com/guillaumemeyer/watermarks-remover)
covers text Unicode hygiene and container metadata in Python, and
[`watermark-removal`](https://github.com/zuruoke/watermark-removal) covers visible
image watermarks with TensorFlow and a GPU. Both ask you to install a toolchain
before you can check whether a paragraph you were sent has a zero-width character
in it.

Every hosted alternative is a single **upload → magic → download** button that asks
to be trusted with your file. unmark inverts that: nothing is uploaded, and nothing
is removed before you have seen what it is.

## What it does

**Text.** Invisible Unicode carriers — zero-width characters, bidi overrides, tag
characters, variation selectors, exotic spaces, homoglyphs — found, classified and
stripped. And **decoded**: those carriers usually spell something, and deleting them
without reading them throws away the only evidence of who marked the text.

Six encoding schemes are read, covering the families named in the [Unicode
watermarking survey](https://arxiv.org/html/2512.13325):

| Scheme                  | How it hides                                                 | Named methods                 |
| ----------------------- | ------------------------------------------------------------ | ----------------------------- |
| zero-width              | ZWSP/ZWNJ/ZWJ/WJ as a binary or base-4 alphabet              | AITSteg, CovertSYS, StegCloak |
| tag characters          | U+E0020–E007F, one per ASCII character                       | —                             |
| variation selectors     | VS1–VS256, one byte each                                     | VariantMark                   |
| **space choice**        | U+0020 against U+2004 or U+3000 — no extra characters at all | Innamark, UniSpaCh, WhiteMark |
| **trailing whitespace** | tabs and spaces parked past each line end                    | SNOW, Shiu                    |
| **confusable letters**  | Latin `a` against Cyrillic `а`                               | LookALikes, Rizzo             |

The last three carry their payload in entirely ordinary characters, so a check that
hunts for invisible codepoints walks straight past them. unmark also measures
**periodicity** — "every third space is a three-per-em" is a pattern, not typing,
and a periodic substitution is reported `confirmed` where a lone one is not.

A deterministic stylometry report flags the habits of generated prose — dash
density, triples, negative parallelism, marker vocabulary, sentence-length variance
— and never rewrites anything. It cannot return a `confirmed` verdict, and it
refuses to measure below 120 words, because one em dash in twelve words is
eighty-three per thousand and that is a division, not a signal.

**Files.** Provenance metadata across eleven formats: PNG, JPEG, WebP, GIF, SVG,
PDF, DOCX, ODT, HTML, Markdown and plain text. C2PA manifests, EXIF, XMP, IPTC,
document properties, generator tags. Removal only — dropping a PNG chunk leaves
every other chunk's CRC valid, and JPEG's scan is copied verbatim, so the pixels
come out byte-identical.

**Images.** A corner scan finds flat semi-transparent overlays and snaps to their
real edges, then **unblends** them: a composited badge is an invertible transform of
the picture, not a hole in it, so the original pixels come back exactly rather than
being guessed at. Where that does not apply there is Telea inpainting, and an
opt-in MI-GAN pass for content a boundary cannot imply. Plus signal disruption —
low-bit scrub, Lanczos resample, micro-crop, JPEG requantise, noise — for marks
encoded in the exact pixel values.

## What leaves your device

Nothing. Not "nothing important" — nothing.

The page is static, all processing happens in your browser, and the
Content-Security-Policy pins `connect-src` to `'self'` and nothing else. Every
asset is served from this site, down to the 28 MB inpainting model and the 13 MB
WebAssembly runtime, so the browser will refuse a request to any other origin —
including one made by a dependency that decides to phone home.

`pnpm check:network` turns that into a build gate. It walks the built bundle and
fails on any external origin, any runtime network API, and any drift between the
shipped CSP and the policy [`scripts/csp.mjs`](scripts/csp.mjs) declares. CI and
the deploy workflow both run it, so a regression breaks the build instead of
shipping.

An in-browser paraphrase for statistical text watermarks was considered and
dropped for exactly this reason: a CSP is static, so permitting it would have
widened the promise for every visitor, including the ones who never used it.

## What it does not remove

Stated here and in the interface, not buried:

- **Robust pixel watermarks** — SynthID, Tree-Ring, StableSignature, StegaStamp.
  They are designed to survive re-encoding, resizing, cropping and inpainting.
  Nothing here removes them.
- **Statistical text watermarks** — the SynthID-Text family lives in word choice,
  not in characters. No deterministic edit touches them, so a clean report does
  not mean unwatermarked text.
- **Metadata inside a PDF's compressed object streams**, which a byte-level pass
  cannot see. unmark reports that rather than implying the file came out clean.

It is not certified to defeat any vendor's detector, and it never claims to be.

## From the terminal

```bash
npx skills add maxgfr/unmark

unmark inspect suspicious.txt     # report every mark, change nothing
unmark decode  suspicious.txt     # recover what the invisible characters spell
unmark clean   suspicious.txt --in-place
unmark audit   ./docs             # walk a tree, list what is marked
```

Zero dependencies — one file, no install step. Exit codes compose: `inspect`
returns 1 when something `confirmed` is present, `audit` returns 1 when a tree is
dirty. The CLI and the page run the **same core**, built twice from one source, so
they cannot disagree about the same character.

## Careful by default

The tool refuses to corrupt real text. A zero-width joiner between two emoji is
what makes 👨‍👩‍👧 one family instead of three people; a zero-width non-joiner inside a
Persian word is orthography. Those are reported as `likely_false_positive` and
kept, with the reason attached. `--paranoid` strips them anyway and says that it
will damage legitimate text.

| Verdict                 | Means                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| `confirmed`             | Structurally certain — a C2PA manifest, a tag-char run that decodes to ASCII |
| `probable`              | Consistent with a mark, but a human could have produced it                   |
| `informational`         | Present, not evidence of anything — EXIF from a camera                       |
| `likely_false_positive` | Matched, but context says it is legitimate; kept by default                  |

## Develop

```bash
pnpm install
pnpm assets    # fetch the pinned MI-GAN weights (checksummed)
pnpm dev
pnpm verify    # typecheck · lint · format · test · skill bundle · build · privacy gate
pnpm shoot     # screenshot and drive the built page in a real browser
```

`src/core` is written without a single `node:` or DOM import, and typechecks in a
project that has neither available — which is what makes "one implementation, two
deliveries" a compile error rather than a convention.

## Intended use

Provenance and metadata hygiene on your own files, stripping tracking marks from
text you were sent, and inspecting what is hidden inside a document you received.

Not a tool for removing authorship marks from work that is not yours.

## License

MIT. MI-GAN is MIT ([Picsart AI Research](https://github.com/Picsart-AI-Research/MI-GAN));
IBM Plex Sans and JetBrains Mono are OFL.
