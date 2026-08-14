#!/usr/bin/env node
// Turns the privacy promise into a build gate.
//
// "Your text and images never leave your device" is only worth something if
// something other than good intentions checks it. This walks the built bundle
// and fails when it finds an origin outside the declared allowlist, a runtime
// network API, or a CSP that no longer matches what scripts/csp.mjs declares —
// so a dependency that starts phoning home breaks CI instead of shipping.
//
// The Content-Security-Policy in index.html is the actual enforcement; the
// browser refuses the request either way. This scanner is the second line: it
// makes a new origin visible at build time rather than at incident time.
//
// unmark cannot make the stronger "zero origins" claim its siblings make,
// because the opt-in WebLLM rewrite downloads weights from HuggingFace. So the
// gate checks the weaker, still-provable thing: nothing reaches anywhere that
// scripts/csp.mjs has not justified in writing, and the shipped CSP says
// exactly that and nothing more.

import { readdir, readFile } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'
import process from 'node:process'
import { CONNECT_ALLOWLIST, INERT_HOSTS, CSP_DIRECTIVES } from './csp.mjs'

const dist = process.argv[2] ?? 'dist'

// Origins the CSP permits a connection to, reduced to bare hosts for matching.
const CONNECTABLE_HOSTS = CONNECT_ALLOWLIST.map(([origin]) => origin)
  .filter((origin) => origin.startsWith('https://'))
  .map((origin) => origin.slice('https://'.length))

// A host may appear in the bundle either because it is connectable or because
// it is an inert string (a namespace URI, a docs link in an error message).
const ALLOWED_HOSTS = [
  ...CONNECTABLE_HOSTS.map((host) => [host, 'declared in the CSP connect-src allowlist']),
  ...INERT_HOSTS,
]

// Files worth reading. Images, fonts and wasm cannot issue requests on their own.
const SCANNED = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.webmanifest'])

const URL_PATTERN = /(?:https?:)?\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi

// Runtime APIs that can reach the network. None of them belongs in this app:
// every download it makes is a plain fetch of a static asset.
const NETWORK_APIS = [
  [/\bnew\s+WebSocket\s*\(/, 'WebSocket'],
  [/\bnew\s+EventSource\s*\(/, 'EventSource'],
  [/\bnavigator\s*\.\s*sendBeacon\s*\(/, 'navigator.sendBeacon'],
  [/\bnew\s+RTCPeerConnection\s*\(/, 'RTCPeerConnection'],
]

// A literal external URL handed to fetch() or import() is an outbound request.
// Unlike the host scan, an inert-string exception does not excuse it — only an
// origin the CSP would actually let through.
const FETCH_LITERAL = /\b(?:fetch|import)\s*\(\s*["'`]((?:https?:)?\/\/[^"'`]+)/gi

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

const matches = (host, allowed) => host === allowed || host.endsWith(`.${allowed}`)
const isAllowed = (host) => ALLOWED_HOSTS.some(([allowed]) => matches(host, allowed))
const isConnectable = (host) => CONNECTABLE_HOSTS.some((allowed) => matches(host, allowed))

const hostOf = (url) => {
  const bare = url.replace(/^https?:/, '')
  return bare.startsWith('//') ? (bare.slice(2).split(/[/?#]/)[0] ?? '') : ''
}

// The connect-src the build actually shipped must equal the one csp.mjs
// declares — no silent widening between the policy and its documentation.
function auditCsp(html, violations) {
  // The directives contain single quotes ('self', 'none'), so the attribute
  // delimiter has to be captured and back-referenced, not guessed.
  const csp = html.match(
    /http-equiv=["']Content-Security-Policy["']\s+content=(["'])([\s\S]*?)\1/i,
  )?.[2]

  if (!csp) {
    violations.push('index.html: missing Content-Security-Policy meta tag')
    return
  }

  for (const required of ["default-src 'self'", "object-src 'none'", "base-uri 'none'"]) {
    if (!csp.includes(required)) violations.push(`index.html: CSP is missing "${required}"`)
  }

  if (csp.includes("'unsafe-eval'") || csp.includes("'unsafe-inline'; script-src")) {
    violations.push('index.html: CSP allows unsafe script evaluation')
  }

  const shipped = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src '))

  if (!shipped) {
    violations.push('index.html: CSP has no connect-src, so any origin is reachable')
    return
  }

  const declared = new Set(CSP_DIRECTIVES['connect-src'])
  const actual = new Set(shipped.slice('connect-src '.length).split(/\s+/).filter(Boolean))

  for (const origin of actual) {
    if (!declared.has(origin)) {
      violations.push(`index.html: CSP connect-src allows undeclared origin ${origin}`)
    }
  }
  for (const origin of declared) {
    if (!actual.has(origin)) {
      violations.push(`index.html: CSP connect-src is missing declared origin ${origin}`)
    }
  }
}

const violations = []
let scanned = 0
let sawIndexHtml = false

for await (const path of walk(dist)) {
  if (!SCANNED.has(extname(path))) continue
  scanned += 1

  const source = await readFile(path, 'utf8')
  const where = relative(dist, path)

  for (const [match, host] of source.matchAll(URL_PATTERN)) {
    if (!isAllowed(host.toLowerCase())) violations.push(`${where}: external origin ${match}`)
  }

  for (const [match, url] of source.matchAll(FETCH_LITERAL)) {
    if (!isConnectable(hostOf(url).toLowerCase())) {
      violations.push(`${where}: outbound request ${match.slice(0, 70)}`)
    }
  }

  for (const [pattern, name] of NETWORK_APIS) {
    if (pattern.test(source)) violations.push(`${where}: network API ${name}`)
  }

  if (where === 'index.html') {
    sawIndexHtml = true
    auditCsp(source, violations)
  }
}

if (!sawIndexHtml) violations.push(`${dist}/index.html not found — did the build run?`)

// One bundled file can repeat the same host dozens of times.
const unique = [...new Set(violations)]

if (unique.length > 0) {
  console.error(`\n  Privacy gate FAILED — ${unique.length} finding(s) across ${scanned} files:\n`)
  for (const violation of unique) console.error(`   x ${violation}`)
  console.error(
    '\n  Each of these can reach the network. Remove it, or widen the promise\n' +
      '  deliberately: add the origin to CONNECT_ALLOWLIST in scripts/csp.mjs\n' +
      '  with the reason it is there, or to INERT_HOSTS if it is never fetched.\n',
  )
  process.exit(1)
}

console.log(`  Privacy gate passed — ${scanned} built files scanned.`)
console.log(`  connect-src: ${CONNECT_ALLOWLIST.length} declared origin(s), CSP matches exactly.`)
for (const [origin, reason] of CONNECT_ALLOWLIST) console.log(`    ${origin} — ${reason}`)
