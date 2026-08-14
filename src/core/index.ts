// The deterministic core: everything unmark can prove it did.
//
// Nothing here may import from `node:` or touch the DOM. That constraint is the
// whole architecture — it is what lets this exact code run inside the page and
// inside the CLI without a second implementation drifting away from the first.
// Pixel work (canvas, WebGPU, wasm) lives in src/image and is browser-only by
// nature; the CLI says so rather than pretending otherwise.

export const VERSION = '0.1.0'

export * from './report.ts'
