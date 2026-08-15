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
  StableSignature) survive this tool, and statistical text watermarks survive
  every deterministic edit it makes. Both are stated on the screen that does the
  removing, not in a footer. A rewrite reduces a score; it does not remove a
  watermark, and no vendor's detector has been tested against.
- **A refusal beats a plausible broken file.** An encrypted PDF is reported as
  unread rather than as clean. A signed one is left alone unless you force it. A
  fragmented video is refused rather than rebuilt on a guess.
- **Never corrupt real text.** A zero-width joiner between two emoji, or inside
  a Persian word, is not a watermark. Those are reported and kept.
- **No verdict beyond the evidence.** Stylometry can never say "confirmed".

## Voice

Plain, specific, and unhedged. Names what happened and what it means. No
exclamation, no reassurance, no "we". Errors name the problem and the recovery.
