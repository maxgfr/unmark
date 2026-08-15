# fixtures/real

Drop real files here. Everything in this directory except this README is
gitignored, so nothing you put in it is committed, published or uploaded — the
test suite reads it locally and that is all.

## What to drop in

Images you actually got out of a generator, with the badge still on them:
a Gemini sparkle in the corner, a Firefly mark, a Sora frame, a stock-library
watermark. The more awkward the better — a badge over a face, a badge on a
gradient, a badge that survived a JPEG round trip.

**PNG only.** The decoder in `src/image/png.ts` exists because the test suite
runs under Node, where there is no `createImageBitmap`, and it handles PNG and
nothing else: JPEG would mean writing a DCT and a Huffman decoder to read a
format the app itself never parses. A JPEG left here is reported as skipped,
not as a failure. Re-save it as PNG if you want it covered.

## What the tests do with them

`src/image/real.test.ts` runs the whole pipeline over each file — corner scan,
shaped estimate, coverage map, unblend, Telea inpaint, the disruption chain —
and asserts the invariants that hold without a ground truth:

- nothing throws,
- the output keeps the input's dimensions,
- every pixel outside the region being edited is byte-identical afterwards.

It does not assert that the badge is gone. There is no un-badged original to
compare against, and a test that scored the result would be scoring a guess.
For measured removal quality, see `src/image/detect/coverage.test.ts`, which
builds a badge it knows the truth about.

With the directory empty the tests skip and say so.

Files are read through Vite's `?inline` import, which is resolved when the test
module is loaded — so after adding a file, restart vitest rather than relying on
watch mode to notice it.
