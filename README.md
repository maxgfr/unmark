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

Several good open-source projects each solve part of this, and none runs in a
browser: [`watermarks-remover`](https://github.com/guillaumemeyer/watermarks-remover)
covers text Unicode hygiene and container metadata in Python,
[`watermark-removal`](https://github.com/zuruoke/watermark-removal) covers visible
image watermarks with TensorFlow and a GPU, and
[`unslop`](https://github.com/theclaymethod/unslop) is the sharpest thing written
on detecting generated prose — its three-layer split and its eval contract are
both borrowed here, with credit. All of them ask you to install a toolchain
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

A deterministic stylometry report flags the habits of generated prose and never
rewrites anything. Eighteen metrics in three layers, following unslop's split,
because _which kind_ of tell fired is more useful than how many did:

| Layer          | Reads                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **phrase**     | marker vocabulary, business jargon, attribution with nobody behind it                                                                                                                    |
| **structure**  | **dashes per paragraph**, sentence-length and paragraph-length spread, signpost density, how uniformly paragraphs open, staccato runs, false ranges, copula avoidance, aphorism formulas |
| **silhouette** | a closing paragraph that recaps the ones above it, headings that would fit any subject, paragraphs built to one internal template                                                        |

The silhouette layer is the one that survives a word-level rewrite, which is why
it is worth more than another vocabulary list. Dashes are counted per paragraph
as well as per document, because a rate across three thousand words hides the one
paragraph with four of them in it.

It cannot return a `confirmed` verdict, and it refuses to measure below 120 words,
because one em dash in twelve words is eighty-three per thousand and that is a
division, not a signal. Co-occurrence is counted over distinct _signals_ rather
than metrics: three metrics reading the same em dashes are one habit, and letting
each vote would manufacture a pattern out of a single character.

**Making text read less like a machine wrote it** is a separate, opt-in pass,
following [Wikipedia's _Signs of AI writing_](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
That catalogue splits in two, and the split is the whole design:

- **One right answer → fixed.** Em and en dashes, curly quotes and ellipses to
  ASCII. Filler (`in order to` → `to`, `has the ability to` → `can`), stacked
  hedges, chat pleasantries, signposting, cutoff disclaimers, decorative emoji on
  headings and bullets.
- **Needs a rewrite → reported, never guessed at.** Rule-of-three cadence,
  promotional tone, passive voice, the word _delve_. There is no correct
  substitution for _delve_; rewriting the sentence is the fix, and that takes a
  writer. A tool that guessed would produce mangled prose and call it humanised.

French guillemets and the apostrophe in _l'été_ are left alone — straightening
those damages real text for nothing.

Neither pass removes a watermark, and both are off by default. They still _run_
on every inspection, so the report lists what they would do before you have
guessed to turn anything on.

**Files.** Provenance metadata across seventeen formats: PNG, JPEG, WebP, GIF,
HEIC, AVIF, MP4/MOV, SVG, PDF, DOCX, PPTX, XLSX, ODT, EPUB, HTML, Markdown and
plain text. C2PA manifests, EXIF, XMP, IPTC,
document properties, generator tags. Removal only — dropping a PNG chunk leaves
every other chunk's CRC valid, and JPEG's scan is copied verbatim, so the pixels
of two real camera JPEGs come out byte-identical after their EXIF and XMP are
stripped.

Including the places the format specs make easy to miss:

| Where                                            | Why it matters                                                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JPEG **APP2 = MPF**                              | Either an ICC profile or an MPF block, told apart only by an identifier. MPF can hold **an entire second photograph**.                                                               |
| **ICC profile**                                  | Kept, since removing it changes rendering — but reported: it survives an EXIF strip and names the software. Facebook stamps its own with `Copyright: FB`.                            |
| DOCX **tracked changes, comments, `people.xml`** | Author names and timestamps on every edit, and a list of everyone who ever opened it. Accepting all changes removes none of it.                                                      |
| DOCX **`docProps/thumbnail.jpeg`**               | A rendered picture of the first page. No text-level clean touches it.                                                                                                                |
| DOCX **RSIDs**                                   | Revision save ids that fingerprint editing sessions and link documents to one machine.                                                                                               |
| PDF **incremental saves**                        | Every earlier draft is still in the file, including text under a black rectangle someone called a redaction. **Removed** — the rebuild writes only the live object graph.            |
| DOCX **`word/media/*`**                          | A photograph pasted into a document keeps its own EXIF, GPS included. Every XML-reading pass walks straight past it, so the file could be reported clean while carrying coordinates. |
| MOV **`©xyz`, and the `keys` table**             | The location atom, plus the metadata iPhones actually write — tags named by index into a table rather than by four-character code, which a handler that only knows 4ccs never sees.  |

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
widened the promise for every visitor, including the ones who never used it. It
lives in the terminal instead, where a network is already expected and where you
opted in by typing the command — see **Crossing the deterministic ceiling**.
`pnpm check:imports` follows the import graph from the page's entry point and
fails if it can reach `src/cli`, so the boundary is a build gate rather than a
convention one careless import away from being untrue.

## What it does not remove

Stated here and in the interface, not buried:

- **Robust pixel watermarks** — SynthID, Tree-Ring, StableSignature, StegaStamp.
  They are designed to survive re-encoding, resizing, cropping and inpainting.
  Nothing here removes them.
- **Statistical text watermarks** — the SynthID-Text family lives in word choice,
  not in characters. No deterministic edit touches them, so a clean report does
  not mean unwatermarked text. `unmark rewrite` reduces the score; it does not
  zero it, and nothing here is tested against any vendor's detector.
- **Encrypted PDFs.** Nothing is read, so nothing is reported. This used to be
  the most dangerous bug in the project: encrypted strings do not match the byte
  pass's patterns, so an encrypted PDF came out reported **clean**.
- **Signed PDFs**, unless you force it. Any edit voids the signature, and the
  tool says so rather than quietly breaking one.

It is not certified to defeat any vendor's detector, and it never claims to be.

## From the terminal

```bash
npx skills add maxgfr/unmark

unmark inspect suspicious.txt     # report every mark, change nothing
unmark decode  suspicious.txt     # recover what the invisible characters spell
unmark clean   suspicious.txt --in-place
unmark audit   ./docs             # walk a tree, list what is marked

# The opt-in style passes
unmark clean draft.md --typography   # em dashes, curly quotes, ellipses → ASCII
unmark clean draft.md --humanise     # filler, pleasantries, signposting, decorative emoji
unmark clean draft.md --plain        # both at once
```

Zero dependencies — one file, no install step. Exit codes compose: `inspect`
returns 1 when something `confirmed` is present, `audit` returns 1 when a tree is
dirty. The CLI and the page run the **same core**, built twice from one source, so
they cannot disagree about the same character.

## Crossing the deterministic ceiling

Everything above is a regex, and a regex cannot reach word choice or the shape of
an argument. That takes a model — and the dangerous version of "use a model" is
to hand it the document, ask for something more human, and ship what comes back.
That trades one machine's prose for another's, quietly drops a figure, and
reports success.

So the model is bracketed rather than trusted:

```bash
unmark brief   draft.md                     # what to fix, and what must survive
unmark verify  new.md --against draft.md    # did it clear the gates, or only read better
unmark rewrite draft.md                     # the loop, driven for you
```

`verify` re-runs all three detection layers on the rewrite and **rejects** it when
a flagged pattern came back, when a number or a citation went missing, or when a
code fence was edited. Each failure is named, so the next attempt is aimed rather
than another roll of the dice. Exit 1, so it composes.

**The page has no rewrite at all**, and that is deliberate:

| Surface   | Where the model runs                                                        |
| --------- | --------------------------------------------------------------------------- |
| the page  | nowhere. `connect-src 'self'`, and a build gate that fails on any origin    |
| the skill | you are the model — no key, no request from our code                        |
| the CLI   | `127.0.0.1` by default. `--model <id>` for a provider, priced first, opt-in |

`--print-prompt` emits the prompt and contacts nothing at all. On the remote path,
[`llm-models`](https://github.com/maxgfr/llm-models) resolves the model, checks
the document fits its context, and prints the cost **before** it is spent — but
it is spawned as a process, never imported, so "one file, no install step" still
holds and it degrades to a note when it is absent.

## Careful by default

The tool refuses to corrupt real text. A zero-width joiner between two emoji is
what makes 👨‍👩‍👧 one family instead of three people; a zero-width non-joiner inside a
Persian word is orthography. Those are reported as `likely_false_positive` and
kept, with the reason attached. `--paranoid` strips them anyway and says that it
will damage legitimate text.

A file whose format is not recognised is reported as `unknown` and handed back
byte for byte. That is not a smaller promise than cleaning it — it is a
different one: the text path decodes UTF-8 and encodes it back, which is
lossless for text and destructive for everything else, so an unrecognised file
that fell into it came out with every invalid byte replaced and a report saying
nothing was found.

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
pnpm verify    # typecheck · lint · format · test · import gate · skill · build · privacy gate
pnpm e2e       # Chromium, Firefox and WebKit, plus two phones with a real touchscreen
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
