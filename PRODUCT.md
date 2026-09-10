# unmark — product truth

## What it is

A static page that finds, decodes and removes watermarks and provenance marks
from text, documents and images, entirely in the visitor's browser. The same
deterministic engine also ships as a terminal tool and a Claude skill.

## Who it is for

Someone who has been handed a file or a paragraph and wants to know what is in
it before they pass it on. Three concrete scenes:

- A paragraph pasted out of a chat window that may carry zero-width characters
  encoding an account id.
- A document received from outside the company, whose properties still name the
  author, the company and the software.
- An image with a generator badge in the corner, or metadata claiming an origin.

They are technically literate but not necessarily a developer. They are
suspicious of any tool that would ask them to upload the file.

## The use scene

A laptop, one browser tab, in a working context — not a phone on the move. Often
alongside the document or the chat window the content came from, which is why
paste is the primary input and the output must be copyable in one action.

Dark by decision, not by category: the page is read next to a terminal and a
code editor, and the findings table is closer to a log than to a document.

## What makes it different

Every comparable tool is a single "upload → magic → download" button that asks
to be trusted. unmark inverts that: every mark is named, located, classified by
confidence, and shown before anything is stripped. It decodes hidden payloads
rather than only deleting the characters carrying them — the payload usually
says who marked the text. And it states plainly what it cannot remove.

## Non-negotiables

- **Nothing is uploaded, and nothing can be.** There is no server, and
  `connect-src 'self'` means the browser refuses any request to any other
  origin — including from a dependency that decides to phone home. Every asset,
  down to the 28 MB inpainting model, is served from this site. Two build gates
  fail CI if that ever stops being true: one walks the bundle for outbound
  origins, the other follows the import graph and refuses to let the page reach
  the code that calls a model. That code exists, in the terminal, where a
  network is expected and asked for; it is loopback-only unless told otherwise.
- **Honesty over reassurance.** Robust pixel watermarks (SynthID, Tree-Ring,
  StableSignature) survive this tool, and statistical text watermarks are not
  checked by its deterministic edits. Both are stated on the screen that does the
  removing, not in a footer. Rewriting has no guaranteed effect on a watermark.
  No vendor detector is used; the separate lab measures a public test key.
- **A refusal beats a plausible broken file.** An encrypted PDF is reported as
  unread rather than as clean. A signed one is left alone unless you force it. A
  fragmented video is refused rather than rebuilt on a guess.
- **Never corrupt real text.** A zero-width joiner between two emoji, or inside
  a Persian word, is not a watermark. Those are reported and kept.
- **No verdict beyond the evidence.** Stylometry can never say "confirmed".

## Voice

Plain, specific, and unhedged. Names what happened and what it means. No
exclamation, no reassurance, no "we". Errors name the problem and the recovery.

## Text workflow

Paste, Clean text, copy. The source remains intact and every action can be undone.
The button defaults to supported-mark removal plus typography and wording
simplification. Advanced settings and inspection details are disclosed on demand.

Deep clean is opt-in WebLLM inference on the visitor's WebGPU device, using one
small Qwen3.5 0.8B model (4-bit/f16, requiring shader-f16). Its files and runtime are served from this site's origin;
only model files are cached. A rejected or unavailable rewrite leaves the basic
cleaning result available. The browser never imports CLI provider transports.
The Local AI model panel under Advanced options reports the model, download
size, runtime, device support, cached files and memory state, with actions to
download ahead of time, release memory and delete the cached files; the cache
check reads the runtime's own stores and never loads the runtime. The download
figure counts the 15 files the runtime fetches, not the 18 pinned: the model
config names four tokenizer files and the runtime stops at the first that
works, so three are served and allowlisted but never downloaded. Deleting
removes all 18, since an older runtime could have cached the other three.

Ultra is an opt-in preset in the same mode selector as Standard and Deep. It
applies all safe deterministic passes, tries a local rewrite up to three times,
and cleans each candidate before checking facts, quotations and protected code.
Paranoid removal and confusable-letter conversion stay off; leaving Ultra restores
the visitor's custom settings. Failed rewrites leave the deterministic result.
The same small model and short-passage limits apply; checks do not prove semantic
identity or removal of statistical watermarks.

Build information shows the actual Git revision and UTC build time, with a format
count sourced from the supported-format catalog. On-device processing describes
the privacy model; it is not an upload counter. Unsupported files are explicitly
uninspected and can only be downloaded as originals. A loaded image offers a
visible Change image action.

The browser prompt is short and asks for minimal edits in the source language.
Model commentary is rejected; unchanged output is reported as such. Failures name
the content check and retain the cleaned source. Qwen3.5 0.8B remains a lightweight
local option with limited rewriting quality. The shared content gate rejects
detected language changes, excluding quotations and code. Ambiguous short text
can remain undetermined; the check does not guarantee language or meaning.
The memory target is under 2 GB: the measured Chromium process RSS peak was
1.93 GB on the development machine, not a universal browser memory guarantee.
