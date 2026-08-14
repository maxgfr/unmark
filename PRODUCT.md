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

- **Nothing is uploaded.** There is no server. The CSP pins `connect-src` to a
  documented allowlist and a build gate fails CI if that changes.
- **Honesty over reassurance.** Robust pixel watermarks (SynthID, Tree-Ring,
  StableSignature) survive this tool, and statistical text watermarks survive
  every deterministic edit it makes. Both are stated on the screen that does the
  removing, not in a footer.
- **Never corrupt real text.** A zero-width joiner between two emoji, or inside
  a Persian word, is not a watermark. Those are reported and kept.
- **No verdict beyond the evidence.** Stylometry can never say "confirmed".

## Voice

Plain, specific, and unhedged. Names what happened and what it means. No
exclamation, no reassurance, no "we". Errors name the problem and the recovery.
