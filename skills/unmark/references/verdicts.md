# Reading a report

Two columns answer two different questions, and a report that carries only one
leaves the reader to guess at the other.

## Verdict — how sure the engine is

| Verdict                 | Means                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| `confirmed`             | Structurally certain — a C2PA manifest, a tag-char run that decodes to ASCII |
| `probable`              | Consistent with a mark, but a human could have produced it                   |
| `informational`         | Present, not evidence of anything — EXIF from a camera                       |
| `likely_false_positive` | Matched, but context says it is legitimate; kept by default                  |

**Report `confirmed` findings as facts. Report `probable` ones as what they
are.** "This text contains a zero-width payload that decodes to `recipient-4417`"
is a fact. "This text has a non-breaking space in it" is not evidence of
anything, and saying otherwise trains people to ignore the tool.

## Outcome — what was actually done

| Outcome     | Means                                                         |
| ----------- | ------------------------------------------------------------- |
| `removed`   | Stripped from the output                                      |
| `kept`      | Matched, deliberately left in place; the reason is on the row |
| `available` | A style pass would act on this, and the option is off         |
| `reported`  | Named only; nothing here removes it                           |

A `confirmed` emoji joiner is `kept`. A merely `probable` XMP packet is
`removed`. The two columns are independent and you need both to say what
happened.

## Never `confirmed`

Nothing in the `stylometry` kind can be `confirmed`, at any threshold, ever. Style
is not evidence. A tool that says "confirmed: written by AI" on the strength of
an em-dash count is lying, and people have been failed by exactly that guess.

The strongest thing the style report may say is that several independent tells
co-occur, which is a pattern and not proof. When you relay it, keep that shape.

## Exit codes

| Command   | 0                       | 1                                       | 2              |
| --------- | ----------------------- | --------------------------------------- | -------------- |
| `inspect` | nothing `confirmed`     | something `confirmed` is present        | bad usage      |
| `decode`  | a payload was recovered | nothing hidden found                    | bad usage      |
| `audit`   | the tree is clean       | at least one file carries a mark        | bad usage      |
| `verify`  | the rewrite passed      | it was rejected; the reasons are listed | no `--against` |
| `rewrite` | accepted, or a prompt   | rejected, or no model answered          | bad usage      |

They compose, so `unmark inspect x && ship` does what it looks like.
