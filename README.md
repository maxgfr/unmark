# unmark

Strip watermarks and provenance marks — in your browser, or from your terminal.

**Status: in development.** The scaffold, the privacy gate and the skill packaging are
in place; the engines land milestone by milestone. See [the build order](#build-order).

## Why

Two good open-source projects each solve half of this, and neither runs in a browser:
[`watermarks-remover`](https://github.com/guillaumemeyer/watermarks-remover) covers text
Unicode hygiene and container metadata in Python, and
[`watermark-removal`](https://github.com/zuruoke/watermark-removal) covers visible image
watermarks with TensorFlow and a GPU. Both ask you to install a toolchain before you can
check whether a paragraph you were sent has a zero-width character in it.

`unmark` is one static page that does the whole matrix — text _and_ images — with nothing
ever uploaded, plus the same deterministic engine as a Claude skill.

## What leaves your device

Nothing you give it. There is no server to upload it to: the page is static, all
processing happens in your browser, and the Content-Security-Policy pins
`connect-src` to a short allowlist that [`scripts/csp.mjs`](scripts/csp.mjs) documents
line by line.

That allowlist is not empty, and the README will not pretend otherwise: the **opt-in**
local paraphrase downloads model weights from HuggingFace. It downloads them; it uploads
nothing. Every other asset — the inpainting model, the wasm runtimes — is served from
this site's own origin.

`pnpm check:network` turns that into a build gate: it walks the built bundle, fails on
any origin outside the allowlist, on any runtime network API, and on a shipped CSP that
does not match the declared policy exactly. CI and the deploy workflow both run it, so a
dependency that starts phoning home breaks the build instead of shipping.

## Build order

| #   | Milestone                                                          | Status      |
| --- | ------------------------------------------------------------------ | ----------- |
| 0   | Scaffold, CI, Pages, privacy gate                                  | done        |
| 1   | Text core — invisible Unicode, steganography decoding, stylometry  | in progress |
| 2   | Container core — C2PA/EXIF/XMP across 10 formats                   |             |
| 3   | CLI and Claude skill                                               |             |
| 4–5 | Text and Files UI                                                  |             |
| 6–7 | Image pipeline — masks, classic and AI inpainting, badge detection |             |
| 8   | Opt-in local paraphrase                                            |             |

## Develop

```bash
pnpm install
pnpm dev
pnpm verify   # typecheck · lint · format · test · skill bundle · build · privacy gate
```

## Intended use

Provenance and metadata hygiene on your own files; stripping tracking marks from text you
were sent; and inspecting what is hidden inside a document you received.

`unmark` is not certified to defeat any vendor's detector, and it says so where it
matters rather than in the footer. It is also not a tool for removing authorship marks
from work that isn't yours.

## License

MIT
