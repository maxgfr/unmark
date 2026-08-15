// Deflate, borrowed from the platform rather than from a dependency.
//
// Two formats in this codebase compress with deflate and disagree about the
// wrapper: a zip entry stores the raw stream, a PDF's /FlateDecode stores the
// zlib-framed one. `DecompressionStream` handles both and has been in every
// browser and in Node since 18, which is what keeps the core at zero
// dependencies — see zip.ts for what that constraint was worth.
//
// This lived inside zip.ts until the PDF rebuild needed the same four
// functions. Nothing else moved.
//
// Awaiting inside the collect loop is the shape of a stream, not an oversight:
// chunks arrive one at a time and there is nothing to parallelise.
// oxlint-disable no-await-in-loop

import { concat } from './types.ts'

async function collect(readable: ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  // Sequential by nature: a stream is read one chunk at a time.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value as Uint8Array)
  }
  return concat(chunks)
}

/**
 * Push bytes through a compression stream and collect the result.
 *
 * Written against the stream's two halves rather than `pipeThrough` because the
 * pair's writable side is typed as accepting BufferSource, which does not line
 * up with a `ReadableStream<Uint8Array>` source under TypeScript's generic
 * Uint8Array. Reading starts before the write so a large entry cannot deadlock
 * against the stream's own backpressure.
 */
function through(
  bytes: Uint8Array,
  transform: { readable: ReadableStream; writable: WritableStream },
): Promise<Uint8Array> {
  const collected = collect(transform.readable)
  const written = (async () => {
    const writer = transform.writable.getWriter()
    await writer.write(bytes)
    await writer.close()
  })()

  // A codec handed input it cannot parse fails on both halves. The reader's
  // copy is the one callers act on; the writer's is swallowed, because an
  // unhandled rejection from the half nobody awaited takes the process down
  // while `inflate` below is still deciding whether to retry.
  return Promise.all([collected, written.catch(() => undefined)]).then(([out]) => out)
}

/** Raw deflate, no wrapper: what a zip entry stores. */
export const inflateRaw = (bytes: Uint8Array): Promise<Uint8Array> =>
  through(bytes, new DecompressionStream('deflate-raw'))

export const deflateRaw = (bytes: Uint8Array): Promise<Uint8Array> =>
  through(bytes, new CompressionStream('deflate-raw'))

/** zlib-framed deflate: what a PDF's /FlateDecode is supposed to be. */
export const deflate = (bytes: Uint8Array): Promise<Uint8Array> =>
  through(bytes, new CompressionStream('deflate'))

/**
 * Inflate a /FlateDecode stream, zlib header or not.
 *
 * The spec says the two-byte zlib header is there. Real files disagree often
 * enough that every serious reader has this fallback: writers that emit a raw
 * deflate stream under the FlateDecode name, and streams whose first bytes were
 * lost to a tool that spliced the file without understanding it. Acrobat opens
 * both, so refusing the second would mean declining files that are, in
 * practice, readable. Trying the wrapped form first keeps the spec-correct
 * case exact — a raw stream almost never passes the zlib header check by
 * accident, and a wrapped one never parses as raw.
 */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await through(bytes, new DecompressionStream('deflate'))
  } catch {
    return await through(bytes, new DecompressionStream('deflate-raw'))
  }
}
