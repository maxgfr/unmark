#!/usr/bin/env node
// The human half of the authorship evaluation corpus, fetched from its sources.
//
// A detector is only as honest as the texts it is scored on. Every document here
// was written by people, predates ChatGPT (each revision, snapshot or
// publication is dated before 2022-11-01, so nothing generated can have crept
// in), and carries a licence that lets it live in this repository. Nothing is
// typed by hand: each file is cut from a pinned revision, a Wayback capture or
// an API record, so running this again rebuilds the same bytes.
//
//   node scripts/authorship-corpus/collect-human.mjs
//
// It writes fixtures/authorship/human/<lang>/<id>.md and the manifest entries in
// fixtures/authorship/human-sources.json, then checks the whole set.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = join(ROOT, 'fixtures', 'authorship')
const MANIFEST = join(FIXTURES, 'human-sources.json')

const CUTOFF = '2022-11-01'
// Wiki revisions are read as they stood on this day, well before the cutoff.
const WIKI_AS_OF = '2022-06-01T00:00:00Z'
const MIN_WORDS = 180
const MAX_WORDS = 450
const LICENSES = new Set([
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-SA-3.0',
  'CC-BY-2.5',
  'CC0-1.0',
  'PD',
  'etalab-2.0',
  'OGL-UK-3.0',
])
const USER_AGENT = 'unmark-authorship-corpus/1.0 (https://github.com/maxgfr/unmark)'

/**
 * What to fetch. Every entry pins the exact text it reads: a wiki oldid, a
 * Wayback timestamp, a HAL id, a Federal Register document number, or a
 * Gutenberg ebook and the paragraph its passage starts at. The text is always
 * the first run of whole paragraphs, from that start, that reaches 180 words.
 *
 * How the pins were chosen, so the choice can be repeated:
 * - service-public: everyday fiches, captured closest to 2021-10-15. Two more
 *   were read and set aside, because their branching left instructions for the
 *   page's own widgets and sentences cut off before a removed table: F2265
 *   (congé maternité) and F12006 (aide au logement).
 * - hal: `--discover-hal` lists the first abstract of 180–450 words in each
 *   domain, by halId; these are the first domains in that order. (The filter
 *   against numbered sections set aside artxibo-02987810, whose field held the
 *   paper's introduction, which is how the English set has no shs.)
 * - wiki: the last revision at or before WIKI_AS_OF (checked on every run).
 *   Carcassonne was set aside for Tombouctou: its population is drawn by a data
 *   template at render time, so a 2022 revision printed 2023 figures.
 * - wikinews: namespace-0 pages of at least 4,500 bytes, by title; the first
 *   that yield enough prose, skipping interviews and repeats of a topic.
 * - federal register: abstracts of 180–450 words published 2021-06-01..07,
 *   one per agency, leaving out the boilerplate information-collection notices.
 */
export const SOURCES = [
  // fr — admin: service-public.fr fiches pratiques, Licence Ouverte 2.0
  {
    id: 'human-fr-admin-carte-identite',
    lang: 'fr',
    genre: 'admin',
    kind: 'service-public',
    fiche: 'F1341',
    timestamp: '20211022134657',
  },
  {
    id: 'human-fr-admin-declaration-naissance',
    lang: 'fr',
    genre: 'admin',
    kind: 'service-public',
    fiche: 'F961',
    timestamp: '20211023034331',
  },
  {
    id: 'human-fr-admin-permis-construire',
    lang: 'fr',
    genre: 'admin',
    kind: 'service-public',
    fiche: 'F1986',
    timestamp: '20211016085649',
  },
  {
    id: 'human-fr-admin-credit-impot-energie',
    lang: 'fr',
    genre: 'admin',
    kind: 'service-public',
    fiche: 'F1224',
    timestamp: '20211020060712',
  },
  {
    id: 'human-fr-admin-legalisation-signature',
    lang: 'fr',
    genre: 'admin',
    kind: 'service-public',
    fiche: 'F1411',
    timestamp: '20211022121245',
  },
  // fr — academic: HAL abstracts
  {
    id: 'human-fr-academic-poussieres-interieures',
    lang: 'fr',
    genre: 'academic',
    kind: 'hal',
    halId: 'anses-03319797',
  },
  {
    id: 'human-fr-academic-sourds-langues',
    lang: 'fr',
    genre: 'academic',
    kind: 'hal',
    halId: 'edutice-01118161',
  },
  {
    id: 'human-fr-academic-ecotoxicite-acv',
    lang: 'fr',
    genre: 'academic',
    kind: 'hal',
    halId: 'emse-01895300',
  },
  {
    id: 'human-fr-academic-capteur-saw',
    lang: 'fr',
    genre: 'academic',
    kind: 'hal',
    halId: 'hal-00486328',
  },
  {
    id: 'human-fr-academic-cristaux-phononiques',
    lang: 'fr',
    genre: 'academic',
    kind: 'hal',
    halId: 'hal-00546843',
  },
  // fr — encyclopedic: a town, a scientist, an animal, an event, a technique
  {
    id: 'human-fr-encyclopedic-tombouctou',
    lang: 'fr',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'fr.wikipedia.org',
    page: 'Tombouctou',
    oldid: 192865507,
  },
  {
    id: 'human-fr-encyclopedic-louis-pasteur',
    lang: 'fr',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'fr.wikipedia.org',
    page: 'Louis Pasteur',
    oldid: 193676362,
  },
  {
    id: 'human-fr-encyclopedic-herisson-europe',
    lang: 'fr',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'fr.wikipedia.org',
    page: 'Erinaceus europaeus',
    oldid: 193258995,
  },
  {
    id: 'human-fr-encyclopedic-prise-bastille',
    lang: 'fr',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'fr.wikipedia.org',
    page: 'Prise de la Bastille',
    oldid: 192889626,
  },
  {
    id: 'human-fr-encyclopedic-vitrail',
    lang: 'fr',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'fr.wikipedia.org',
    page: 'Vitrail',
    oldid: 194157398,
  },
  // fr — news: Wikinews
  {
    id: 'human-fr-news-gilets-jaunes',
    lang: 'fr',
    genre: 'news',
    kind: 'wiki',
    host: 'fr.wikinews.org',
    page: '"Gilets jaunes" : troisième week-end de mobilisation',
    oldid: 806121,
  },
  {
    id: 'human-fr-news-dgse-11-septembre',
    lang: 'fr',
    genre: 'news',
    kind: 'wiki',
    host: 'fr.wikinews.org',
    page: '11 septembre 2001 : les services de renseignements français avaient alerté leurs homologues américains',
    oldid: 849758,
  },
  {
    id: 'human-fr-news-proces-enlevement-imam',
    lang: 'fr',
    genre: 'news',
    kind: 'wiki',
    host: 'fr.wikinews.org',
    page: "26 Américains et 9 Italiens renvoyés devant un tribunal, pour l'enlèvement d'un imam en 2003",
    oldid: 630057,
  },
  {
    id: 'human-fr-news-reconstruction-haiti',
    lang: 'fr',
    genre: 'news',
    kind: 'wiki',
    host: 'fr.wikinews.org',
    page: "5,3 milliards de dollars pour la reconstruction d'Haïti",
    oldid: 205363,
  },
  // fr — fiction: Wikisource, public domain
  {
    id: 'human-fr-fiction-maupassant-parure',
    lang: 'fr',
    genre: 'fiction',
    kind: 'wiki',
    host: 'fr.wikisource.org',
    page: 'Contes du jour et de la nuit (éd. Flammarion, 1885)/La Parure',
    oldid: 10352543,
    author: 'Guy de Maupassant',
  },
  {
    id: 'human-fr-fiction-flaubert-coeur-simple',
    lang: 'fr',
    genre: 'fiction',
    kind: 'wiki',
    host: 'fr.wikisource.org',
    page: 'Trois Contes (Flaubert)/Un Cœur simple',
    oldid: 10180097,
    author: 'Gustave Flaubert',
  },
  {
    id: 'human-fr-fiction-daudet-chevre-seguin',
    lang: 'fr',
    genre: 'fiction',
    kind: 'wiki',
    host: 'fr.wikisource.org',
    page: 'Lettres de mon moulin/La chèvre de monsieur Seguin',
    oldid: 10750359,
    author: 'Alphonse Daudet',
  },
  // en — admin: Federal Register abstracts, US government works
  {
    id: 'human-en-admin-lesser-prairie-chicken',
    lang: 'en',
    genre: 'admin',
    kind: 'federal-register',
    document: '2021-11442',
  },
  {
    id: 'human-en-admin-patent-structured-text',
    lang: 'en',
    genre: 'admin',
    kind: 'federal-register',
    document: '2021-11256',
  },
  {
    id: 'human-en-admin-san-diego-ozone',
    lang: 'en',
    genre: 'admin',
    kind: 'federal-register',
    document: '2021-11524',
  },
  // en — academic: HAL abstracts
  {
    id: 'human-en-academic-nanomaterials-risk',
    lang: 'en',
    genre: 'academic',
    kind: 'hal',
    halId: 'anses-01677748',
  },
  {
    id: 'human-en-academic-optical-aptasensors',
    lang: 'en',
    genre: 'academic',
    kind: 'hal',
    halId: 'anses-02874860',
  },
  {
    id: 'human-en-academic-mycorrhiza-fire-soils',
    lang: 'en',
    genre: 'academic',
    kind: 'hal',
    halId: 'bioemco-00542730',
  },
  // en — encyclopedic: an animal, a scientist, an event
  {
    id: 'human-en-encyclopedic-octopus',
    lang: 'en',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'en.wikipedia.org',
    page: 'Octopus',
    oldid: 1086115622,
  },
  {
    id: 'human-en-encyclopedic-ada-lovelace',
    lang: 'en',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'en.wikipedia.org',
    page: 'Ada Lovelace',
    oldid: 1090798925,
  },
  {
    id: 'human-en-encyclopedic-great-fire-london',
    lang: 'en',
    genre: 'encyclopedic',
    kind: 'wiki',
    host: 'en.wikipedia.org',
    page: 'Great Fire of London',
    oldid: 1081974428,
  },
  // en — news: Wikinews
  {
    id: 'human-en-news-anonymous-scientology',
    lang: 'en',
    genre: 'news',
    kind: 'wiki',
    host: 'en.wikinews.org',
    page: '"Anonymous" plans to protest Church of Scientology on February 10',
    oldid: 4281920,
  },
  {
    id: 'human-en-news-bali-roadmap',
    lang: 'en',
    genre: 'news',
    kind: 'wiki',
    host: 'en.wikinews.org',
    page: '"Bali Roadmap" agreed on, applauded',
    oldid: 739244,
  },
  {
    id: 'human-en-news-gordon-brown-remarks',
    lang: 'en',
    genre: 'news',
    kind: 'wiki',
    host: 'en.wikinews.org',
    page: '"Bigoted woman": controversial Gordon Brown remarks caught on air',
    oldid: 4562174,
  },
  // en — fiction: Project Gutenberg, public domain, dated by first publication
  {
    id: 'human-en-fiction-jane-eyre',
    lang: 'en',
    genre: 'fiction',
    kind: 'gutenberg',
    ebook: 1260,
    startsWith: 'There was no possibility of taking a walk that day.',
    title: 'Jane Eyre: An Autobiography',
    author: 'Charlotte Brontë',
    date: '1847-01-01',
  },
  {
    id: 'human-en-fiction-moby-dick',
    lang: 'en',
    genre: 'fiction',
    kind: 'gutenberg',
    ebook: 2701,
    startsWith: 'Call me Ishmael.',
    title: 'Moby-Dick; or, The Whale',
    author: 'Herman Melville',
    date: '1851-01-01',
  },
]

// ---------------------------------------------------------------------------
// Text helpers

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  euro: '€',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  acirc: 'â',
  ccedil: 'ç',
  ocirc: 'ô',
  icirc: 'î',
  ucirc: 'û',
  ugrave: 'ù',
  Eacute: 'É',
  oelig: 'œ',
  shy: '\u00ad',
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : +name.slice(1)
      return String.fromCodePoint(code)
    }
    // An entity we do not know would leave "&foo;" in a human text; better to stop.
    if (!(name in NAMED_ENTITIES)) throw new Error(`unknown HTML entity ${match}`)
    return NAMED_ENTITIES[name]
  })
}

/** Plain text of an HTML fragment: tags out, entities decoded, spacing collapsed. */
function htmlToText(html) {
  const text = decodeEntities(html.replace(/<[^>]*>/g, ''))
  // Only ASCII whitespace collapses: no-break spaces are French typography.
  return text.replace(/[ \t\r\n\f]+/g, ' ').trim()
}

const countWords = (text) => text.split(/\s+/).filter(Boolean).length

/**
 * Consecutive paragraphs from the first, until the passage is long enough.
 * Whole paragraphs only: a source whose paragraphs cannot land in the window is
 * a source to replace, not one to cut mid-sentence.
 */
function takeParagraphs(paragraphs, what) {
  const taken = []
  let words = 0
  for (const paragraph of paragraphs) {
    const next = countWords(paragraph)
    if (words + next > MAX_WORDS) break
    taken.push(paragraph)
    words += next
    if (words >= MIN_WORDS) return taken
  }
  throw new Error(`${what}: no run of paragraphs lands in ${MIN_WORDS}–${MAX_WORDS} words`)
}

/** Removes every element of `tag` whose opening tag matches `open`, nesting included. */
function removeElements(html, tag, open) {
  let out = html
  for (;;) {
    const start = out.search(open)
    if (start === -1) return out
    const tagPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
    let depth = 0
    let end = -1
    for (const match of out.slice(start).matchAll(tagPattern)) {
      depth += match[1] ? -1 : 1
      if (depth === 0) {
        end = start + match.index + match[0].length
        break
      }
    }
    // Unclosed means it runs past the end of the fragment we were handed.
    out = out.slice(0, start) + (end === -1 ? '' : out.slice(end))
  }
}

// Elements that never close, so they never change the nesting depth.
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'col'])

/** The inner HTML of every <p> that is a direct child of the fragment's root. */
function topLevelParagraphs(html) {
  const paragraphs = []
  let depth = 0
  let open = -1
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [whole, closing, rawName, selfClosing] = match
    const name = rawName.toLowerCase()
    if (VOID.has(name) || selfClosing) continue
    if (closing) {
      depth--
      if (name === 'p' && depth === 1 && open !== -1) {
        paragraphs.push(html.slice(open, match.index))
        open = -1
      }
    } else {
      if (name === 'p' && depth === 1) open = match.index + whole.length
      depth++
    }
  }
  return paragraphs
}

// ---------------------------------------------------------------------------
// Network

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lastRequest = new Map()

async function fetchText(url) {
  const host = new URL(url).host
  let lastError
  // The Wikimedia APIs throttle bursts hard and the Wayback Machine drops the odd
  // request, so requests to one host are spaced, and retried with a backoff.
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = (lastRequest.get(host) ?? 0) + 1500 - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequest.set(host, Date.now())
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
      if (response.ok) return await response.text()
      lastError = new Error(`${response.status} ${response.statusText} for ${url}`)
      if (response.status === 404) break
    } catch (error) {
      lastError = error
    }
    await sleep(5000 * 2 ** attempt)
  }
  throw lastError
}

const fetchJson = async (url) => JSON.parse(await fetchText(url))

// ---------------------------------------------------------------------------
// Sources

const WIKI_LICENSES = {
  // Wikipedia text moved to CC BY-SA 4.0 in June 2023; these revisions predate it.
  wikipedia: () => ({ license: 'CC-BY-SA-3.0', author: 'Wikipedia contributors' }),
  wikinews: () => ({ license: 'CC-BY-2.5', author: 'Wikinews contributors' }),
  // Wikisource hosts the works themselves: public domain, credited to the writer.
  wikisource: (source) => ({ license: 'PD', author: source.author }),
}

async function wikiApi(host, params) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params })
  return fetchJson(`https://${host}/w/api.php?${query}`)
}

async function fromWiki(source) {
  const { host, page, oldid } = source
  // The pin has to be the revision a fresh lookup would choose.
  const history = await wikiApi(host, {
    action: 'query',
    prop: 'revisions',
    titles: page,
    rvstart: WIKI_AS_OF,
    rvdir: 'older',
    rvlimit: '1',
    rvprop: 'ids|timestamp',
  })
  const revision = history.query.pages[0].revisions?.[0]
  if (revision?.revid !== oldid) {
    throw new Error(
      `${page}: pinned oldid ${oldid}, last revision before cutoff is ${revision?.revid}`,
    )
  }
  const parsed = await wikiApi(host, {
    action: 'parse',
    oldid: String(oldid),
    prop: 'text',
    disablelimitreport: '1',
  })
  const project = host.split('.')[1]
  const paragraphs = takeParagraphs(extractWikiParagraphs(parsed.parse.text, project), page)
  // The old wikitext is rendered with today's templates. Most render as they did,
  // but a data template can print figures newer than the revision; a year past
  // WIKI_AS_OF is the tell (a year merely past the revision can be a forecast).
  const asOfYear = +WIKI_AS_OF.slice(0, 4)
  const later = paragraphs
    .join(' ')
    .match(/\b20\d\d\b/g)
    ?.find((year) => +year > asOfYear)
  if (later) throw new Error(`${page}: renders ${later}, later than ${asOfYear}`)
  return {
    title: parsed.parse.title,
    url: `https://${host}/w/index.php?oldid=${oldid}`,
    date: revision.timestamp.slice(0, 10),
    ...WIKI_LICENSES[project](source),
    paragraphs,
  }
}

const WIKI_CHROME = [
  // Footnote calls, [réf. nécessaire] and the like are all classed <sup>; a bare
  // <sup> is typography ("XIXe") and stays.
  ['sup', /<sup\b[^>]*class="[^"]*"/i],
  ['style', /<style\b/i],
  ['span', /<span\b[^>]*class="[^"]*(?:mw-editsection|noprint)[^"]*"/i],
  // French Wikinews opens its first paragraph with the date line.
  ['small', /<small><span style="color:#72777d">Publié le/],
]

// English Wikinews gives the date line a paragraph of its own.
const WIKINEWS_DATELINE =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \w+ \d{1,2}, \d{4}$/

function extractWikiParagraphs(html, project) {
  let body = html
  for (const [tag, open] of WIKI_CHROME) body = removeElements(body, tag, open)
  // Wikisource wraps its prose in the scanned pages' containers, so every <p>
  // counts there; elsewhere only the article's own, not a caption's or a box's.
  const paragraphs = project === 'wikisource' ? allParagraphs(body) : topLevelParagraphs(body)
  return (
    paragraphs
      .map(htmlToText)
      // A footnote number or a "needed" tag still in brackets is a marker some
      // template drew without a class. A bracketed letter stays: in a quote,
      // "[a] million" is the writer's own insertion.
      .map((text) => text.replace(/ ?\[(?:\d+|réf\. nécessaire|citation needed)\]/g, ''))
      .filter((text) => text && !WIKINEWS_DATELINE.test(text))
  )
}

/** Every <p>, wherever it sits. */
function allParagraphs(html) {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => match[1])
}

const HAL_LICENSES = {
  'https://creativecommons.org/licenses/by/4.0/': 'CC-BY-4.0',
  'https://creativecommons.org/licenses/by-sa/4.0/': 'CC-BY-SA-4.0',
  'https://creativecommons.org/publicdomain/zero/1.0/': 'CC0-1.0',
}

function halQuery(lang, filters, fields, rows) {
  const query = new URLSearchParams({
    q: '*:*',
    wt: 'json',
    sort: 'halId_s asc',
    rows: String(rows),
  })
  for (const filter of filters) query.append('fq', filter)
  query.set('fl', fields.join(','))
  return fetchJson(`https://api.archives-ouvertes.fr/search/?${query}`)
}

const HAL_FIELDS = (lang) => [
  'halId_s',
  'title_s',
  `${lang}_abstract_s`,
  'licence_s',
  'producedDate_s',
  'submittedDate_s',
  'domain_s',
  'authFullName_s',
]

// The selection filters, shared by --discover-hal and the per-record fetch so a
// pinned record that no longer qualifies is caught.
const halFilters = (lang) => [
  `licence_s:(${Object.keys(HAL_LICENSES)
    .map((url) => `"${url}"`)
    .join(' OR ')})`,
  `language_s:${lang}`,
  'producedDateY_i:[2010 TO 2021]',
  // Deposited before the cutoff too, not just produced before it.
  `submittedDate_tdate:[* TO ${CUTOFF}T00:00:00Z}`,
  'docType_s:(ART OR COMM OR REPORT)',
]

/**
 * Whether an abstract field holds an abstract: 180–450 words, and no numbered
 * sections ("1.1. Survey's overall aims"), which mean the depositor pasted the
 * paper's opening, footnote calls and all.
 */
function isAbstract(text) {
  const words = countWords(text)
  return words >= MIN_WORDS && words <= MAX_WORDS && !/(?:^|\s)\d+\.\d+\.\s/.test(text)
}

/** HAL dates are "2021", "2018-10" or "2015-06-13"; the manifest wants a full day. */
function halDate(partial) {
  if (/^\d{4}$/.test(partial)) return `${partial}-01-01`
  if (/^\d{4}-\d{2}$/.test(partial)) return `${partial}-01`
  if (/^\d{4}-\d{2}-\d{2}/.test(partial)) return partial.slice(0, 10)
  throw new Error(`unreadable HAL date ${partial}`)
}

async function fromHal(source) {
  const { halId, lang } = source
  const result = await halQuery(
    lang,
    [...halFilters(lang), `halId_s:"${halId}"`],
    HAL_FIELDS(lang),
    1,
  )
  const record = result.response.docs[0]
  if (!record) throw new Error(`${halId}: not found, or no longer passes the selection filters`)
  const abstract = decodeEntities(record[`${lang}_abstract_s`][0])
  const paragraphs = abstract
    .split(/\r?\n/)
    .map((text) => text.replace(/[ \t\r\n\f]+/g, ' ').trim())
    .filter(Boolean)
  // An abstract is taken whole or not at all.
  if (!isAbstract(abstract)) throw new Error(`${halId}: the abstract does not qualify`)
  return {
    title: decodeEntities(record.title_s[0]),
    url: `https://hal.science/${halId}`,
    date: halDate(record.producedDate_s),
    license: HAL_LICENSES[record.licence_s],
    author: record.authFullName_s.join(', '),
    paragraphs,
  }
}

async function discoverHal(lang) {
  const result = await halQuery(lang, halFilters(lang), HAL_FIELDS(lang), 400)
  const seen = new Set()
  for (const record of result.response.docs) {
    const abstract = decodeEntities(record[`${lang}_abstract_s`]?.[0] ?? '')
    const domain = record.domain_s?.[0]
    if (seen.has(domain) || !isAbstract(abstract)) continue
    seen.add(domain)
    const title = decodeEntities(record.title_s[0])
    const words = countWords(abstract)
    console.log(`${lang}  ${domain.padEnd(10)} ${record.halId_s.padEnd(20)} ${words}  ${title}`)
  }
}

// What sits inside a fiche without being its prose: the "Autres cas ?" pointer,
// the "Où s'adresser ?" directories, infographic modals, online-service boxes,
// tab labels, screen-reader labels, the "À savoir" box titles, the "your
// situation" questionnaires, tables, and the accordion's headings and buttons.
//
// A fiche also branches: tabs for each situation, choice trees for each case.
// Reading every branch would repeat the same sentences with small changes, so
// only the tab shown by default and the first case of each tree are kept.
const SERVICE_PUBLIC_CHROME = [
  ['div', /<div id="autreCas"/],
  ['div', /<div class="tab-pane"/],
  ['div', /(?<=<\/div>)<div class="choice-tree-item"/],
  ['div', /<div[^>]*class="choice-notice-tab"/],
  ['div', /<div data-ou-s-adresser/],
  ['div', /<div[^>]*class="modal\b/],
  ['div', /<div class="fiche-item-demarche/],
  ['ul', /<ul class="nav nav-tabs/],
  ['span', /<span class="sr-only"/],
  ['p', /<p class="bloc-edito-title"/],
  // A paragraph that is nothing but a link is a "see also", not a sentence.
  ['p', /<p><a [^>]*>[^<]*<\/a><\/p>/],
  ...['form', 'table', 'figure', 'svg', 'button', 'h2', 'h3', 'h4', 'h5', 'script'].map((tag) => [
    tag,
    new RegExp(`<${tag}\\b`),
  ]),
]

async function fromServicePublic(source) {
  const { fiche, timestamp } = source
  const page = `https://www.service-public.fr/particuliers/vosdroits/${fiche}`
  // `id_` asks the Wayback Machine for the capture as served, without its toolbar.
  const html = await fetchText(`https://web.archive.org/web/${timestamp}id_/${page}`)
  // The licence has to be on the capture itself: the footer line saying so
  // arrived during 2021, and only captures that carry it are used.
  const footer = 'Sauf mention contraire, tous les textes de ce site sont sous licence etalab-2.0'
  const pageText = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')
  if (!pageText.includes(footer)) {
    throw new Error(`${fiche}: the capture does not state the etalab-2.0 licence`)
  }
  const title = htmlToText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1])
  // The fiche runs from the end of its header (title, "Vérifié le...") to the
  // first block that is not the main one ("Textes de référence", "Et aussi"...).
  const start = html.indexOf('</header>', html.indexOf('<h1'))
  const end = html.slice(start).search(/<div class="fiche-bloc(?! bloc-principal)[^"]*"/)
  if (start === -1 || end === -1) throw new Error(`${fiche}: fiche body not found`)
  let body = html.slice(start, start + end)
  for (const [tag, open] of SERVICE_PUBLIC_CHROME) body = removeElements(body, tag, open)
  // Block boundaries become the line breaks, so each paragraph and list item ends
  // up on a line of its own; the markup's own newlines mean nothing.
  const lines = body
    .replace(/<\/?(?:p|li|ul|ol|div|section|br)\b[^>]*>/gi, '\u0001')
    .split('\u0001')
    .map(htmlToText)
    // Collapsed accordions repeat their reminder lines back to back.
    .filter((line, index, all) => line && line !== all[index - 1])
  return {
    title,
    url: `https://web.archive.org/web/${timestamp}/${page}`,
    date: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
    license: 'etalab-2.0',
    author: 'DILA (service-public.fr)',
    paragraphs: takeParagraphs(lines, fiche),
  }
}

async function fromFederalRegister(source) {
  const { document } = source
  const fields = ['abstract', 'title', 'publication_date', 'agencies', 'html_url']
  const query = fields.map((field) => `fields[]=${field}`).join('&')
  const record = await fetchJson(
    `https://www.federalregister.gov/api/v1/documents/${document}.json?${query}`,
  )
  const paragraphs = record.abstract
    .split(/\r?\n/)
    .map((text) => text.replace(/[ \t\r\n\f]+/g, ' ').trim())
    .filter(Boolean)
  const words = countWords(record.abstract)
  if (words < MIN_WORDS || words > MAX_WORDS) throw new Error(`${document}: ${words} words`)
  return {
    title: record.title,
    url: record.html_url,
    date: record.publication_date,
    // Written by federal employees in their duties: no copyright (17 U.S.C. § 105).
    license: 'PD',
    author: record.agencies.map((agency) => agency.name).join(', '),
    paragraphs,
  }
}

async function fromGutenberg(source) {
  const { ebook, startsWith } = source
  const url = `https://www.gutenberg.org/cache/epub/${ebook}/pg${ebook}.txt`
  const raw = (await fetchText(url)).replace(/\r\n/g, '\n')
  // Only the book: Project Gutenberg's header and licence stay out.
  const book = raw.slice(raw.search(/^\*\*\* START OF TH/m), raw.search(/^\*\*\* END OF TH/m))
  // Hard-wrapped lines are joined back into the paragraphs they were cut from.
  const paragraphs = book
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
  const from = paragraphs.findIndex((text) => text.startsWith(startsWith))
  if (from === -1) throw new Error(`ebook ${ebook}: no paragraph starts with "${startsWith}"`)
  return {
    title: source.title,
    url: `https://www.gutenberg.org/ebooks/${ebook}`,
    date: source.date,
    license: 'PD',
    author: source.author,
    paragraphs: takeParagraphs(paragraphs.slice(from), `ebook ${ebook}`),
  }
}

// ---------------------------------------------------------------------------

const FETCHERS = {
  wiki: fromWiki,
  hal: fromHal,
  'service-public': fromServicePublic,
  'federal-register': fromFederalRegister,
  gutenberg: fromGutenberg,
}

const SOURCE_NAMES = {
  wiki: (source) => source.host,
  hal: () => 'hal',
  'service-public': () => 'service-public.fr',
  'federal-register': () => 'federalregister.gov',
  gutenberg: () => 'gutenberg',
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function collect(source) {
  const fetched = await FETCHERS[source.kind](source)
  const text = `${fetched.paragraphs.join('\n\n')}\n`
  const words = countWords(text)
  const path = `human/${source.lang}/${source.id}.md`
  const bytes = Buffer.from(text, 'utf8')
  await mkdir(join(FIXTURES, 'human', source.lang), { recursive: true })
  await writeFile(join(FIXTURES, path), bytes)
  return {
    id: source.id,
    path,
    label: 'human',
    lang: source.lang,
    genre: source.genre,
    source: SOURCE_NAMES[source.kind](source),
    title: fetched.title,
    url: fetched.url,
    date: fetched.date,
    license: fetched.license,
    author: fetched.author,
    words,
    sha256: sha256(bytes),
  }
}

/** Everything the manifest promises, checked against the files on disk. */
async function verify(documents) {
  const failures = []
  const ids = new Set()
  for (const entry of documents) {
    const fail = (why) => failures.push(`${entry.id}: ${why}`)
    if (ids.has(entry.id)) fail('duplicate id')
    ids.add(entry.id)
    if (!/^human-(fr|en)-(admin|academic|encyclopedic|news|fiction)-[a-z0-9-]+$/.test(entry.id)) {
      fail('id does not read human-<lang>-<genre>-<slug>')
    }
    if (!entry.id.startsWith(`human-${entry.lang}-${entry.genre}-`)) {
      fail('id disagrees with lang/genre')
    }
    if (entry.path !== `human/${entry.lang}/${entry.id}.md`) fail(`unexpected path ${entry.path}`)
    if (!LICENSES.has(entry.license)) fail(`licence ${entry.license} is not allowed`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || entry.date >= CUTOFF) fail(`date ${entry.date}`)
    if (!entry.title || !entry.url || !entry.author) fail('missing title, url or author')
    let bytes
    try {
      bytes = await readFile(join(FIXTURES, entry.path))
    } catch {
      fail('file missing')
      continue
    }
    const text = bytes.toString('utf8')
    const words = countWords(text)
    if (sha256(bytes) !== entry.sha256) fail('sha256 does not match the file')
    if (words !== entry.words) fail(`manifest says ${entry.words} words, file has ${words}`)
    if (words < MIN_WORDS || words > MAX_WORDS) fail(`${words} words`)
    if (!text.endsWith('\n') || text.endsWith('\n\n')) fail('must end with exactly one newline')
    if (/<[a-z/][^>]*>|&[a-z]+;|\[\d+\]/i.test(text)) fail('markup or a reference marker left in')
  }
  return failures
}

function printTable(documents) {
  const rows = documents.map((entry) => [
    entry.id,
    entry.source,
    entry.license,
    entry.date,
    String(entry.words),
  ])
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('  '))
  }
  const counts = new Map()
  for (const { lang, genre } of documents) {
    const key = `${lang} ${genre}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const summary = [...counts].map(([key, n]) => `${key} ×${n}`).join(', ')
  console.log(`\n${documents.length} documents: ${summary}`)
}

async function main() {
  if (process.argv.includes('--discover-hal')) {
    await discoverHal('fr')
    await discoverHal('en')
    return
  }
  // Ids on the command line refetch just those; the rest keep their entries.
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  let previous = []
  try {
    previous = JSON.parse(await readFile(MANIFEST, 'utf8')).documents
  } catch {
    // First run: there is no manifest yet.
  }
  const documents = []
  for (const source of SOURCES) {
    const kept = previous.find((entry) => entry.id === source.id)
    if (only.length && !only.includes(source.id) && kept) {
      documents.push(kept)
      continue
    }
    const entry = await collect(source)
    console.log(`fetched ${entry.id}`)
    documents.push(entry)
  }
  await writeFile(MANIFEST, `${JSON.stringify({ documents }, null, 2)}\n`)

  console.log('')
  printTable(documents)
  const failures = await verify(documents)
  if (failures.length) {
    console.error(`\n${failures.map((failure) => `  ${failure}`).join('\n')}\n`)
    process.exit(1)
  }
  console.log('verified: word counts, checksums, dates, licences, ids')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
