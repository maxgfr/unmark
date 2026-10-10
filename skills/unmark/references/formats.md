# Formats

Seventeen, sniffed from the bytes rather than the extension. What comes off,
what is deliberately kept, and what is refused.

## Images

| Format   | Stripped                                                         | Kept, and reported                                       |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| **PNG**  | `tEXt` `zTXt` `iTXt`, `eXIf`, XMP, `caBX` (C2PA), `dSIG`         | `iCCP`, `pHYs`, `gAMA` — removing them changes rendering |
| **JPEG** | EXIF, XMP, IPTC (APP13), C2PA/JUMBF (APP11), COM, **MPF (APP2)** | ICC profile, JFIF, Adobe APP14                           |
| **WebP** | `EXIF`, `XMP `, `C2PA`; the VP8X flag bits are repaired to match | `ICCP`, `ALPH`, animation chunks                         |
| **GIF**  | comment and application extensions                               | `NETSCAPE2.0`, which is the loop count                   |
| **HEIC** | the `Exif` item, the XMP `mime` item, C2PA `uuid`/`jumb`         | `colr`, `ispe`, `pixi`, codec configuration              |
| **AVIF** | same as HEIC                                                     | same as HEIC                                             |

**JPEG APP2 is two different things** told apart only by an identifier: an ICC
profile, which is kept, or an **MPF block, which can hold an entire second
photograph**. That is the one worth naming to a user.

### What a C2PA manifest says

Every C2PA manifest — PNG `caBX`, JPEG APP11 (reassembled across segments),
WebP `C2PA`, HEIC/AVIF/MP4 `uuid` and `jumb`, a PDF attachment or JPEG 2000
image — is **decoded, not only detected**: the JUMBF boxes, the CBOR claim and
assertions, and the signer's name from the COSE certificate. The report gives
the claim generator (`Anthropic Files 1.0.0`), every action with its software
agent and digital source type, any action description, and the certificate's
subject and issuer — read, **not verified**: no hash is recomputed and no
signature checked.

The label then classifies the file, and the difference matters:

| Origin                           | Meaning                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `created by generative AI`       | an action declares `trainedAlgorithmicMedia` or `compositeWithTrained…`               |
| `file passed through an AI tool` | an AI product opened, provided or signed it — **no claim the content was made by AI** |
| `edited`                         | actions declared, no AI involved                                                      |
| `signed … no actions declared`   | a manifest with nothing in it but its generator                                       |
| `could not be decoded`           | present, unreadable — never reported as absent                                        |

Relay the second one carefully, and in the manifest's own words. `c2pa.opened`
by Claude says a chat assistant handed the file back, and its description often
adds that the assistant "may have created or modified the file contents". So
the manifest leaves both open: it neither shows the chart was drawn by a model,
nor rules it out. Say that, and quote the description `inspect` prints.

**Chunk removal, not re-encoding.** Dropping a PNG chunk leaves every other
chunk's CRC valid, and JPEG's scan is copied verbatim, so two real camera JPEGs
come out byte-identical in their pixels after EXIF and XMP are stripped.

## Video

| Format      | Stripped                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------- |
| **MP4/MOV** | `©too` `©swr` `©day` `©nam` `©cmt` `©ART`, free-form `----`, C2PA/XMP `uuid`             |
|             | **`©xyz`, the GPS location atom**                                                        |
|             | QuickTime `keys`+`ilst`: `make`, `model`, `software`, `location.ISO6709`, `creationdate` |
|             | `mvhd` / `tkhd` / `mdhd` creation and modification timestamps, blanked in place          |

The `keys` path matters because that is what iPhone `.mov` files actually use —
tags named by index into a table, not by four-character code, so a handler that
only knows 4ccs never fires on the files most likely to arrive.

**Refused, with the reason given**: fragmented or indexed files (`moof`, `sidx`,
`saio`, `mfra`), an item whose bytes do not sit inside one box, overlapping
extents, and any offset that would end up pointing into removed bytes. A refusal
that says why beats a plausible broken video.

## Documents

| Format                 | Stripped                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| **DOCX / PPTX / XLSX** | `docProps/core.xml`, `app.xml`, `custom.xml`, any other `docProps/*.xml`   |
|                        | `customXml/item*.xml` — where DLP and SharePoint park identifiers          |
|                        | **tracked-change authors and timestamps**, comments, `word/people.xml`     |
|                        | **RSIDs** — revision save ids that link documents to one machine           |
|                        | **`docProps/thumbnail.*`** — a rendered picture of page one                |
|                        | **EXIF, XMP and C2PA inside `word/media/*`** — including GPS               |
| **ODT**                | `meta.xml`, `Pictures/*` the same way                                      |
| **EPUB**               | OPF `dc:creator`, `dc:contributor`, `dc:publisher`, `dc:date`, `calibre:*` |

EPUB keeps `dc:title`, `dc:language` and `dc:identifier`: the first two describe
the book rather than a person, and the third is what the package's
`unique-identifier` points at — removing it makes the file invalid. The
`dcterms:modified` meta stays for the same reason. All four are reported.

Parts are **emptied, never deleted**. Word reaches `docProps/core.xml` through a
relationship in `_rels/.rels`, and a relationship pointing at a part that is no
longer there is how you get "the file is corrupt and cannot be opened".

Zip timestamps are zeroed on write. A timestamp is metadata like any other.

**Pictures in a Word document are placed.** `inspect` lists every picture in
`word/media/` — marked or not — with the paragraph that anchors it (counted
from 1 over every paragraph of the body, empty ones included) and the caption
beside it: `word/media/image24.png  paragraph 606 — Figure 4. Classification…`.
The caption is read from the picture's own paragraph, else the nearest caption
above or below; when there is one on each side, the one on the same page (as
Word last rendered it) wins, then the side the rest of the document uses. A
picture used only in a header, footer or comment is listed as "not in the
body". The same placement rides on each finding as `placement` in `--json`.

**Not handled**: encrypted zips, ZIP64, multi-disk archives, OLE objects in
`word/embeddings/`, and the _text_ of comments (only their authorship goes).

## PDF

Two paths, and the report always names which one ran.

**Structural rebuild** — the object graph reachable from the catalog is written
out fresh:

- `/Info` unlinked from the trailer, not blanked
- `/Metadata` XMP dropped, along with `/PieceInfo` and `/Names /JavaScript`
- **metadata inside compressed object streams**, which a byte pass cannot see
- **every earlier revision**, because incremental-save history is simply not
  written — this is the one that matters when a black rectangle was called a
  redaction

**Pictures and attachments** — every image XObject reachable from the catalog
is opened:

- `/DCTDecode` alone is a JPEG byte for byte, so EXIF, XMP, IPTC and C2PA come
  off the way they would from a `.jpg`, and the scan data is copied
- a JPEG under another filter (`/FlateDecode /DCTDecode`) or a JPEG 2000
  codestream is searched — C2PA, XMP, EXIF — and **reported, not rewritten**
- raw pixel data (Flate, LZW, CCITT, JBIG2) has nowhere to keep metadata

Attached files are opened too: a C2PA manifest store (`/AFRelationship
/C2PA_Manifest`, or a store found in the bytes) is decoded and unlinked from
`/AF` and the `/EmbeddedFiles` tree; an attached picture is reported.

Every PDF report ends with what was scanned, whether or not anything turned up,
so "nothing found" can be told from "not looked for":

```
scanned: 11 image XObjects (1 JPEG, 10 raw pixel data, which holds no metadata): 0 C2PA, 0 EXIF, 1 XMP
scanned: 0 attached files: 0 C2PA
```

A PDF exported from Pages or Word re-encodes PNG figures as raw pixel data, so
a manifest on a figure in the source document is gone from the PDF — the
coverage line is how you can say so rather than guess. In `--json` it is the
`coverage` array.

Object streams are **expanded, not recompressed**, so no compression mismatch
can corrupt anything. Every other stream's bytes are copied verbatim with its
original filter.

Before the bytes are returned, the output is re-parsed and checked: every xref
offset resolves, the catalog and page tree resolve, the page count matches, every
stream's `/Length` is right, and there is exactly one `%%EOF`. **If any check
fails the rebuild is discarded** and the byte pass runs instead, saying so.

**Byte pass** — the fallback. Values are overwritten with spaces in place, so
nothing moves and nothing can break. It reaches the Info dictionary and XMP
packets that sit outside object streams, and it reports incremental saves rather
than removing them.

**Three refusals**

| Condition                 | What happens                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/Encrypt`                | Nothing is read and nothing is written. Reported `confirmed`.                                                                           |
| `/Sig` or `/ByteRange`    | Unchanged; pictures and attachments are still scanned, read-only. Any edit voids the signature; `--force` proceeds and says it is void. |
| A parse or verify failure | Falls back to the byte pass and states what that leaves behind.                                                                         |

The encryption refusal fixes a bug that shipped: encrypted strings do not match
the byte pass's patterns, so an encrypted PDF used to be reported **clean**.

One known false negative, deliberately: a content stream containing the literal
bytes `%%EOF` fails the "exactly one end-of-file marker" check, and the rebuild
is discarded in favour of the byte pass. That is the check behaving as
specified, and the conservative direction is the right one.

## Text and markup

| Format       | Stripped                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| **SVG**      | `<metadata>`, XMP packets, generator comments, `data-ai*` attributes           |
| **HTML**     | `<meta name="generator">`, `<meta name="*ai-generated">`, provenance JSON-LD   |
| **Markdown** | AI keys in YAML frontmatter only; the body is never touched by the markup pass |
| **Text**     | invisible carriers, stego payloads, chat-window residue                        |

JSON-LD is only removed when it matches **both** a provenance key and a software
creator. Ordinary Article or Product schema is kept.

Across every text format, and on by default because these are marks rather than
style: `?utm_source=chatgpt.com` and its family on cited links, the `【4:0†source】`
citation glyphs, `citeturn0search1` tokens, and `contentReference[oaicite:…]`.
Only parameters whose _value_ names an AI product are removed — a plain
`utm_source=newsletter` is the sender's own analytics and is left alone.

## What `detect` reads

Prose only: **Text, Markdown and HTML** (script and style blocks are skipped,
tags are not read as words). Code blocks, blockquotes, quotations and URLs are
left out of the assessment — quoting a chatbot is not writing like one.

**DOCX**: the body paragraphs of `word/document.xml`. Left out, and counted in
`document.skipped`: data tables (a table cell of 30 words or more is read as
prose — a layout table), captions (by style, or a leading "Figure 4." /
"Tableau 2"), the table of contents, headings (they label the paragraphs that
follow as `location.section`) and everything under a "References" /
"Références" / "Bibliographie" heading until the next heading. Pages come from
Word's rendered page breaks only when they account for the document's page
count, and they are then labelled `Word p. 12` (`location.wordPage: true`):
Word's layout drifts from the printed one by a page or two on a long thesis,
so pass the printed PDF with `--pages` for the pages a reader holds. A title
typed as a plain paragraph — « Résumé », « Serment d'Hippocrate » — starts a
section, and a medical thesis's oath is left out (`skipped.boilerplate`).

**PDF**: page by page, from the text operators and each font's `ToUnicode` map
or encoding. Folios, numbered headings, captions, a table of contents, a
numbered reference list and the oath are left out; a paragraph cut by a page
break is joined back (a hyphen at the break undone); every paragraph keeps the
page it starts on. An encrypted PDF gives no text: `detect` abstains with
`abstainReason: "unreadable"` rather than calling it too short.

`--pages <file.pdf>` places each paragraph of a .docx (or of a text file) on a
page of the printed PDF, by a search that ignores spacing, hyphenation and
ligatures, so a passage reads "p. 29, §2.6.3". When fewer than half the
paragraphs are found in it, `detect` and `sweep` say so on stderr and in the
report: it is probably another document or another version. An image, or a
file with no prose, is refused with exit 2.

## Anything else

A file whose format is not recognised is reported as `unknown` and handed back
**byte for byte**. Nothing is decoded, nothing is edited, no finding is emitted.

That is worth stating because the alternative is not "does less" but "does
damage": the text path decodes UTF-8, edits a string and encodes it back, which
is lossless for text and destructive for everything else — every invalid byte
returns as U+FFFD, three bytes wide. So the check is a strict UTF-8 decode plus
a NUL-byte test, and only what passes both is treated as text.

When you report an `unknown` to a user, say the format was not recognised. Do
not say the file is clean.
