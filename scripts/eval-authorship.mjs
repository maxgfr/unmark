#!/usr/bin/env node
// How well the authorship assessment separates human from generated text,
// measured on frozen corpora, with intervals.
//
//   node --experimental-strip-types scripts/eval-authorship.mjs [options]
//
//   --split test|train|all   which documents to score (default: test)
//   --corpus pinned|binoculars|all
//                            the committed subset, the fetched binoculars-eu
//                            corpus, or both (default: all that are present)
//   --fit                    fit weights and thresholds on the TRAIN split,
//                            write src/core/text/authorship/calibration.ts and
//                            docs/authorship-eval-<date>.{md,json}, then report
//                            on the test split with the new calibration
//   --write                  write the docs report without fitting
//   --json                   print the summary as JSON
//
// It imports the shipping core, like scripts/synthid-lab/bridge.mjs: an
// evaluation of a second implementation would measure the wrong thing.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { detectAuthorship, weightedScore } from '../src/core/text/authorship/index.ts'
import { decide } from '../src/core/text/authorship/verdict.ts'
import { CALIBRATION } from '../src/core/text/authorship/calibration.ts'
import {
  auroc,
  bootstrapInterval,
  fitLogistic,
  fitThresholds,
  fitWeights,
  splitOfGroup,
  tprAtFpr,
} from '../src/core/text/authorship/evaluate.ts'
import { MIN_AUTHORSHIP_WORDS } from '../src/core/text/authorship/index.ts'
import { CORPUS_DIR, PINNED } from './fetch-authorship-corpus.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'fixtures', 'authorship')
const SIGNALS = ['spans', 'lexicon', 'discourse', 'variation', 'stylometry', 'forensic']
/** Fitted on the four signals that vary; forensic keeps its hand-set share. */
const FITTED = ['spans', 'lexicon', 'discourse', 'variation', 'stylometry']
const SEED = 42

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const split = option('--split', 'test')
const corpusOption = option('--corpus', 'all')
const fit = args.includes('--fit')
const write = fit || args.includes('--write')

// ------------------------------------------------------------------ corpora

const BINOCULARS_GENRE = {
  'wikipedia-fr': 'encyclopedic',
  'presse-fr': 'news',
  linuxfr: 'blog',
  litterature: 'fiction',
  'blog-maudet': 'blog',
}

async function pinnedDocuments() {
  const path = join(FIXTURES, 'manifest.json')
  if (!existsSync(path)) return { documents: [], hash: null }
  const raw = await readFile(path)
  const manifest = JSON.parse(raw.toString('utf8'))
  const documents = await Promise.all(
    manifest.documents.map(async (entry) => ({
      ...entry,
      corpus: 'pinned',
      text: await readFile(join(FIXTURES, entry.path), 'utf8'),
      format: entry.path.endsWith('.md') ? 'Markdown' : 'Text',
    })),
  )
  return { documents, hash: createHash('sha256').update(raw).digest('hex').slice(0, 12) }
}

async function binocularsDocuments(committedBinoculars = []) {
  if (!existsSync(join(CORPUS_DIR, 'binoculars-eu-corpus-fr-v1.1.jsonl'))) return []
  const read = async (file) =>
    (await readFile(join(CORPUS_DIR, file), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const documents = []
  for (const row of await read('binoculars-eu-corpus-fr-v1.1.jsonl')) {
    documents.push({
      id: `bin-${row.id}`,
      label: row.label === 'human' ? 'human' : 'ai',
      lang: 'fr',
      genre: row.label === 'human' ? (BINOCULARS_GENRE[row.source] ?? row.source) : 'generated',
      source: row.source,
      text: row.text,
      parent: row.meta?.twin_of,
    })
  }
  for (const file of [
    'binoculars-eu-corpus-fr-v01-ood.jsonl',
    'binoculars-eu-corpus-fr-v02-ood.jsonl',
  ]) {
    for (const row of await read(file)) {
      documents.push({
        id: `bin-${row.id}`,
        label: 'ai',
        lang: 'fr',
        genre: 'ood',
        source: row.source,
        text: row.text,
        parent: row.meta?.twin_of,
      })
    }
  }
  for (const row of await read('binoculars-eu-corpus-fr-v02-ood-humanized.jsonl')) {
    documents.push({
      id: `bin-${row.id}`,
      label: 'humanized',
      lang: 'fr',
      genre: 'humanized',
      source: row.source,
      text: row.text,
      parent: row.meta?.source_id,
    })
  }
  // Split by group, not by document: a twin goes where its human original
  // goes, a humanised text where its generated source goes. Groups that also
  // sit in the committed corpus are left out here, so no document or subject
  // is counted twice under two splits.
  const byId = new Map(documents.map((doc) => [doc.id, doc]))
  const parentOf = (id) => {
    const parent = byId.get(id)?.parent
    return parent ? `bin-${parent}` : undefined
  }
  const rootOf = (id) => {
    let root = id
    const seen = new Set([root])
    for (let next = parentOf(root); next && !seen.has(next); next = parentOf(root)) {
      seen.add(next)
      root = next
    }
    return root
  }
  const committed = new Set(committedBinoculars.map((id) => rootOf(`bin-${id}`)))
  return documents
    .filter((doc) => !committed.has(rootOf(doc.id)))
    .map((doc) => ({
      ...doc,
      corpus: 'binoculars',
      format: 'Text',
      split: splitOfGroup(doc.id, parentOf),
    }))
}

// ------------------------------------------------------------------ scoring

function measure(doc, calibration) {
  const report = detectAuthorship(doc.text, {
    format: doc.format,
    calibration,
    ...(doc.mixedSpans ? { allSpans: true } : {}),
  })
  const values = Object.fromEntries(
    SIGNALS.map((id) => [id, report.signals.find((s) => s.id === id)?.value ?? null]),
  )
  return {
    id: doc.id,
    corpus: doc.corpus,
    label: doc.label,
    lang: doc.lang,
    genre: doc.genre,
    split: doc.split,
    words: report.words,
    verdict: report.verdict,
    abstainReason: report.abstainReason,
    residue: report.findings.some((f) => f.category === 'residue'),
    technical: report.technicalMarks.length > 0,
    values,
    signals: report.signals,
    spans: doc.mixedSpans ? report.spans : undefined,
    mixedSpans: doc.mixedSpans,
  }
}

/** The document's score under `calibration`, abstention or not. */
function scoreOf(sample, calibration) {
  const signals = sample.signals.map((signal) => ({
    ...signal,
    weight: calibration.weights[signal.id] ?? signal.weight,
  }))
  return weightedScore(signals, sample.residue, calibration.thresholds.ai)
}

/**
 * The verdict under `calibration`, from the stored signals, through the same
 * `decide` the detector uses: a second copy of the rules would drift, and the
 * confusion table is meant to show what a user sees.
 */
function verdictOf(sample, calibration) {
  const signals = sample.signals.map((signal) => ({
    ...signal,
    weight: calibration.weights[signal.id] ?? signal.weight,
  }))
  return decide({
    words: sample.words,
    unsupported: sample.abstainReason === 'unsupported_language',
    signals,
    residue: sample.residue,
    technical: sample.technical,
    calibration,
  }).verdict
}

// ------------------------------------------------------------------ fitting

function fitCalibration(train, corpusId) {
  const rows = train.filter((s) => s.label === 'human' || s.label === 'ai')
  const means = Object.fromEntries(
    FITTED.map((id) => {
      const present = rows.map((s) => s.values[id]).filter((v) => v !== null)
      return [id, present.length ? present.reduce((a, b) => a + b, 0) / present.length : 0]
    }),
  )
  const x = rows.map((s) => FITTED.map((id) => s.values[id] ?? means[id]))
  const y = rows.map((s) => (s.label === 'ai' ? 1 : 0))
  const { coefficients } = fitLogistic(x, y)
  const share = 1 - CALIBRATION.weights.forensic
  const fitted = fitWeights(coefficients)
  const weights = {
    ...Object.fromEntries(
      FITTED.map((id, at) => [id, Math.round(fitted[at] * share * 1000) / 1000]),
    ),
    forensic: CALIBRATION.weights.forensic,
  }

  const draft = { ...CALIBRATION, weights }
  // Thresholds only ever apply to documents long enough for a verdict, so they
  // are fitted on those when there are enough to fit on. Fitted on everything,
  // the many short generated texts with no tell at all pulled the human
  // threshold to zero, and nothing could ever read as "few signals".
  const long = rows.filter((s) => s.words >= MIN_AUTHORSHIP_WORDS)
  const enough = ['human', 'ai'].every(
    (label) => long.filter((s) => s.label === label).length >= 20,
  )
  const pool = enough ? long : rows
  const human = pool.filter((s) => s.label === 'human').map((s) => scoreOf(s, draft))
  const ai = pool.filter((s) => s.label === 'ai').map((s) => scoreOf(s, draft))
  const date = new Date().toISOString().slice(0, 10)
  const thresholds = fitThresholds(human, ai)
  // The parameters are part of the name: the same corpus fitted by a changed
  // detector gives different weights, and one id must mean one calibration.
  const parameters = createHash('sha256')
    .update(JSON.stringify({ weights, thresholds }))
    .digest('hex')
    .slice(0, 6)
  return {
    id: `fit-${date}-${corpusId}-${parameters}`,
    calibrated: true,
    date,
    corpus: corpusId,
    weights,
    thresholds,
    coefficients: Object.fromEntries(
      FITTED.map((id, at) => [id, Math.round(coefficients[at] * 1000) / 1000]),
    ),
  }
}

function calibrationSource(calibration) {
  const original = CALIBRATION_SOURCE_HEADER
  const body = {
    id: calibration.id,
    calibrated: calibration.calibrated,
    date: calibration.date,
    corpus: calibration.corpus,
    weights: calibration.weights,
    thresholds: calibration.thresholds,
  }
  return `${original}\nexport const CALIBRATION: Calibration = ${JSON.stringify(body, undefined, 2)}\n`
}

const CALIBRATION_SOURCE_HEADER = `// GENERATED by scripts/eval-authorship.mjs --fit. Do not edit by hand:
// rerun the evaluation, which rewrites this file and the report beside it.
//
// Every report carries this id, so a verdict can always be traced to the
// weights and thresholds behind it, and those to the corpus they were fitted on.

export interface Calibration {
  /** Named in every report. */
  id: string
  /** False until weights and thresholds were fitted on a labelled corpus. */
  calibrated: boolean
  /** When the fit ran, ISO date. */
  date: string | null
  /** Which corpus it ran on, by manifest hash. */
  corpus: string | null
  weights: {
    spans: number
    lexicon: number
    discourse: number
    variation: number
    stylometry: number
    forensic: number
  }
  thresholds: { human: number; ai: number }
}
`

// ------------------------------------------------------------------ report

const VERDICTS = ['likely_ai', 'uncertain', 'likely_human', 'insufficient_evidence']
const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null)

function summarise(samples, calibration) {
  const scored = samples.map((s) => ({
    ...s,
    score: scoreOf(s, calibration),
    verdictNow: verdictOf(s, calibration),
  }))
  const human = scored.filter((s) => s.label === 'human').map((s) => s.score)
  const ai = scored.filter((s) => s.label === 'ai').map((s) => s.score)
  const humanized = scored.filter((s) => s.label === 'humanized').map((s) => s.score)
  const tpr = (fpr) => (p, n) => tprAtFpr(p, n, fpr).tpr

  const confusion = {}
  for (const s of scored) {
    confusion[s.label] ??= Object.fromEntries(VERDICTS.map((v) => [v, 0]))
    confusion[s.label][s.verdictNow] += 1
  }

  const strata = new Map()
  for (const s of scored.filter((x) => x.label === 'human')) {
    const key = `${s.lang}/${s.genre}`
    const entry = strata.get(key) ?? { stratum: key, n: 0, likelyAi: 0, abstained: 0 }
    entry.n += 1
    if (s.verdictNow === 'likely_ai') entry.likelyAi += 1
    if (s.verdictNow === 'insufficient_evidence') entry.abstained += 1
    strata.set(key, entry)
  }

  // Sentence level, on documents with an AI passage spliced into human prose.
  const positives = []
  const negatives = []
  for (const s of scored.filter((x) => x.mixedSpans && x.spans)) {
    for (const span of s.spans) {
      const generated = s.mixedSpans.some((m) => span.start < m.end && span.end > m.start)
      ;(generated ? positives : negatives).push(span.score)
    }
  }

  const long = scored.filter((s) => s.words >= MIN_AUTHORSHIP_WORDS)
  return {
    documents: {
      total: scored.length,
      human: human.length,
      ai: ai.length,
      humanized: humanized.length,
      atLeast150Words: long.length,
    },
    auroc: {
      value: round(auroc(ai, human)),
      ci: bootstrapInterval(ai, human, auroc, { seed: SEED }).map(round),
    },
    tprAt1Fpr: {
      value: round(tpr(0.01)(ai, human)),
      ci: bootstrapInterval(ai, human, tpr(0.01), { seed: SEED }).map(round),
      threshold: round(tprAtFpr(ai, human, 0.01).threshold),
    },
    tprAt5Fpr: {
      value: round(tpr(0.05)(ai, human)),
      ci: bootstrapInterval(ai, human, tpr(0.05), { seed: SEED }).map(round),
    },
    humanized: humanized.length
      ? {
          auroc: round(auroc(humanized, human)),
          reachingAiThreshold: round(
            humanized.filter((x) => x >= calibration.thresholds.ai).length / humanized.length,
          ),
        }
      : null,
    confusion,
    strata: [...strata.values()]
      .map((e) => ({ ...e, fpr: round(e.likelyAi / e.n) }))
      .sort((a, b) => a.stratum.localeCompare(b.stratum)),
    mixed:
      positives.length && negatives.length
        ? {
            sentenceAuroc: round(auroc(positives, negatives)),
            sentences: positives.length + negatives.length,
          }
        : null,
  }
}

function markdown(summary, meta) {
  const ci = (m) => (m.ci?.every((v) => v !== null) ? ` (95 % CI ${m.ci[0]}–${m.ci[1]})` : '')
  const lines = [
    `# Authorship evaluation — ${meta.date}`,
    '',
    `Calibration \`${meta.calibration.id}\` · split \`${meta.split}\` · corpora: ${meta.corpora.join(', ')} · bootstrap 1000 rounds, seed ${SEED}.`,
    '',
    'Scores are computed for every document, including those under 150 words that the verdict abstains on; verdict counts are as a user would see them. None of this is a guarantee on text from another model, another genre or another decade.',
    '',
    '## Separation',
    '',
    `- AUROC human vs generated: **${summary.auroc.value}**${ci(summary.auroc)}`,
    `- True-positive rate at 1 % false positives: **${summary.tprAt1Fpr.value}**${ci(summary.tprAt1Fpr)}`,
    `- True-positive rate at 5 % false positives: **${summary.tprAt5Fpr.value}**${ci(summary.tprAt5Fpr)}`,
    ...(summary.humanized
      ? [
          `- Humanised generated text: AUROC ${summary.humanized.auroc}; ${Math.round(summary.humanized.reachingAiThreshold * 100)} % still reach the AI threshold`,
        ]
      : []),
    ...(summary.mixed
      ? [
          `- Sentence-level AUROC on mixed documents: ${summary.mixed.sentenceAuroc} (${summary.mixed.sentences} sentences)`,
        ]
      : []),
    '',
    `Documents: ${summary.documents.total} (${summary.documents.human} human, ${summary.documents.ai} generated, ${summary.documents.humanized} humanised; ${summary.documents.atLeast150Words} of 150 words or more).`,
    '',
    '## Verdicts',
    '',
    `| Label | ${VERDICTS.join(' | ')} |`,
    `| --- | ${VERDICTS.map(() => '---:').join(' | ')} |`,
    ...Object.entries(summary.confusion).map(
      ([label, row]) => `| ${label} | ${VERDICTS.map((v) => row[v]).join(' | ')} |`,
    ),
    '',
    '## False positives by stratum (human documents called `likely_ai`)',
    '',
    '| Stratum | Documents | `likely_ai` | FPR | Abstained |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...summary.strata.map(
      (s) => `| ${s.stratum} | ${s.n} | ${s.likelyAi} | ${s.fpr} | ${s.abstained} |`,
    ),
    '',
  ]
  if (meta.fitted) {
    lines.push(
      '## Fitted calibration',
      '',
      `Fitted on the train split (${meta.fitted.trainDocuments} documents). Weights: ${Object.entries(
        meta.fitted.weights,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(
          ', ',
        )}. Thresholds: human ${meta.fitted.thresholds.human}, AI ${meta.fitted.thresholds.ai}. Logistic coefficients: ${Object.entries(
        meta.fitted.coefficients,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}.`,
      '',
    )
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ main

const pinned =
  corpusOption === 'binoculars' ? { documents: [], hash: null } : await pinnedDocuments()
// binoculars-eu rows copied into the committed corpus, by their original id.
const committedBinoculars = pinned.documents
  .map((doc) => /^binoculars-eu@\S+ (\S+)$/.exec(doc.source ?? '')?.[1])
  .filter(Boolean)
const binoculars = corpusOption === 'pinned' ? [] : await binocularsDocuments(committedBinoculars)
const documents = [...pinned.documents, ...binoculars]
if (documents.length === 0) {
  console.error(
    '  No corpus found. Commit fixtures/authorship/manifest.json or run scripts/fetch-authorship-corpus.mjs.',
  )
  process.exit(1)
}

const corpora = [
  ...(pinned.documents.length ? [`pinned ${pinned.hash}`] : []),
  ...(binoculars.length ? [`binoculars-eu ${PINNED.commit.slice(0, 12)}`] : []),
]
const corpusId = createHash('sha256').update(corpora.join('+')).digest('hex').slice(0, 12)

const samples = documents.map((doc) => measure(doc, CALIBRATION))
let calibration = CALIBRATION
let fitted
if (fit) {
  const train = samples.filter((s) => s.split === 'train')
  fitted = { ...fitCalibration(train, corpusId), trainDocuments: train.length }
  calibration = fitted
  await writeFile(
    join(ROOT, 'src', 'core', 'text', 'authorship', 'calibration.ts'),
    calibrationSource(fitted),
  )
}

const chosen = split === 'all' ? samples : samples.filter((s) => s.split === split)
const summary = summarise(chosen, calibration)
const date = new Date().toISOString().slice(0, 10)
const meta = { date, split, corpora, calibration: { id: calibration.id }, fitted }

if (args.includes('--json')) console.log(JSON.stringify({ meta, summary }, undefined, 2))
else console.log(markdown(summary, meta))

if (fit && pinned.documents.length > 0) {
  // What eval.test.ts holds the committed corpus to from now on.
  const test = samples.filter((s) => s.corpus === 'pinned' && s.split === 'test')
  const baseline = {
    calibration: calibration.id,
    testAuroc: round(
      auroc(
        test.filter((s) => s.label === 'ai').map((s) => scoreOf(s, calibration)),
        test.filter((s) => s.label === 'human').map((s) => scoreOf(s, calibration)),
      ),
    ),
  }
  await writeFile(join(FIXTURES, 'baseline.json'), `${JSON.stringify(baseline, undefined, 2)}\n`)
}

if (write) {
  await writeFile(join(ROOT, 'docs', `authorship-eval-${date}.md`), `${markdown(summary, meta)}\n`)
  await writeFile(
    join(ROOT, 'docs', `authorship-eval-${date}.json`),
    `${JSON.stringify({ meta, summary }, undefined, 2)}\n`,
  )
}
