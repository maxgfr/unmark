// The privacy policy, as data.
//
// One module owns it so the header injected into the build and the gate that
// audits the build cannot drift apart. vite.config.ts imports this to write the
// <meta http-equiv="Content-Security-Policy"> tag; scripts/check-network.mjs
// imports it to assert the shipped bundle reaches nowhere else.

// Every origin the app may open a connection to, with the reason it is here.
//
// There is exactly one, and it is our own. Everything the page loads — the
// fonts, the ONNX runtime, the 28 MB inpainting model — is served from this
// site, so the browser will refuse a request to anywhere else outright.
//
// An in-browser paraphrase for statistical text watermarks was considered and
// dropped for this: it would have meant permitting huggingface.co and two CDNs
// for *every* visitor, since a CSP is static and cannot be widened only for the
// ones who opt in. A best-effort feature is not worth the only claim on this
// page that the browser itself enforces.
//
// Adding a row here is the deliberate act of widening that promise. The gate
// prints these reasons when it reports, so an unjustified entry is visible in
// CI rather than only in a diff.
export const CONNECT_ALLOWLIST = [
  ["'self'", 'every asset, font, wasm blob and model is served from our own origin'],
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
