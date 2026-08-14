// The privacy policy, as data.
//
// One module owns it so the header injected into the build and the gate that
// audits the build cannot drift apart. vite.config.ts imports this to write the
// <meta http-equiv="Content-Security-Policy"> tag; scripts/check-network.mjs
// imports it to assert the shipped bundle reaches nowhere else.

// Every origin the app may open a connection to, with the reason it is here.
// Adding a row is the deliberate act of widening the privacy promise — the gate
// prints these reasons when it reports, so an unjustified entry is visible in CI.
export const CONNECT_ALLOWLIST = [
  ["'self'", 'every model, wasm blob and asset is served from our own origin'],
  [
    'https://huggingface.co',
    'opt-in WebLLM weights, fetched only after the user confirms the download',
  ],
  ['https://cdn-lfs.hf.co', 'HuggingFace LFS CDN backing those same weights'],
  ['https://cdn-lfs-us-1.hf.co', 'HuggingFace LFS CDN backing those same weights'],
  [
    'https://raw.githubusercontent.com',
    'mlc-ai/binary-mlc-llm-libs — the WebGPU shader library WebLLM pairs with the weights',
  ],
]

// Hosts allowed to appear as inert strings in the bundle: documentation URLs
// baked into library error messages, XML namespaces, our own canonical address.
// None of them is a fetch target, and the FETCH_LITERAL check still applies.
export const INERT_HOSTS = [
  ['react.dev', 'React minified-error decoder URL inside thrown Error messages'],
  ['tailwindcss.com', 'license banner comment at the top of the generated stylesheet'],
  ['bit.ly', 'Workbox console.warn documentation link (bit.ly/wb-precache)'],
  ['w3.org', 'XML/SVG/XMP namespace declarations, parsed as strings and never dereferenced'],
  ['npmjs.org', 'XMP and OOXML namespace-like constants in vendored parser tables'],
  ['purl.org', 'Dublin Core namespace URI matched inside XMP packets'],
  ['adobe.com', 'Adobe XMP namespace URIs matched inside XMP packets'],
  ['openxmlformats.org', 'OOXML namespace URIs matched inside docProps parts'],
  ['oasis-open.org', 'ODF namespace URIs matched inside meta.xml'],
  ['c2pa.org', 'C2PA manifest namespace, matched when detecting provenance chunks'],
  ['maxgfr.github.io', "the app's own canonical address in meta tags and the manifest"],
  ['github.com', 'the "read the source" link in the footer — an anchor, not a request'],
  [
    'rolldown.rs',
    "documentation URL inside a thrown Error about `require` in the bundler's runtime",
  ],
  [
    'web.dev',
    'cross-origin-isolation guide linked from an onnxruntime-web console.warn about threads',
  ],
  [
    'huggingface.co',
    'provenance of the pinned MI-GAN weights, recorded in scripts/fetch-assets.mjs',
  ],
]

// `wasm-unsafe-eval` is what lets WebAssembly.compile run at all; without it the
// inpainting engines cannot start. It permits compiling wasm, not eval() of
// JavaScript — `unsafe-eval` is deliberately absent.
export const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'connect-src': CONNECT_ALLOWLIST.map(([origin]) => origin),
  'script-src': ["'self'", "'wasm-unsafe-eval'", 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'manifest-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
}

export const CSP = Object.entries(CSP_DIRECTIVES)
  .map(([directive, values]) => `${directive} ${values.join(' ')}`)
  .join('; ')
