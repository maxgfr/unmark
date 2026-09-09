// Uses the shipping core directly; the lab must not reimplement its cleaner.
import { inspectTextDocument, PLAIN } from '../../src/core/text/index.ts'
import { buildBrief, briefToPrompt, verifyRewrite } from '../../src/core/rewrite.ts'
let raw = ''
for await (const chunk of process.stdin) raw += chunk
const { text, candidate } = JSON.parse(raw)
const brief = buildBrief(text)
process.stdout.write(
  JSON.stringify({
    basic: inspectTextDocument(text).cleaned.output,
    plain: inspectTextDocument(text, PLAIN).cleaned.output,
    prompt: briefToPrompt(text, brief),
    ...(candidate !== undefined ? { verdict: verifyRewrite(text, candidate, brief) } : {}),
  }),
)
