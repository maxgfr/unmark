# Signal Binoculars dans l'évaluation d'authorship — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ajouter à `unmark detect` un signal fondé sur un modèle — le score Binoculars servi en local par [binoculars-eu](https://github.com/linagora/binoculars-eu) — branché sur le point d'entrée `external` déjà en place, pour que le verdict puisse enfin conclure là où les habitudes d'écriture seules ne concluent pas.

**Architecture:** le cœur reste pur et synchrone : une fonction pure transforme un score Binoculars en valeur 0–1 et découpe les textes longs. Le CLI (seul endroit autorisé à parler au réseau) appelle un serveur binoculars-eu en **loopback** par défaut, puis passe le résultat à `detectAuthorship(text, { external })`. L'évaluation mesure le signal sur le corpus figé et le corpus binoculars-eu, et la calibration en ajuste le poids. La page web n'y touche pas.

**Tech Stack:** TypeScript (cœur, CLI), vitest, Node ≥ 20 (`fetch`, `node:http` pour les tests), binoculars-eu 0.x (Python ≥ 3.12, PyTorch ≥ 2.4, FastAPI) lancé par l'utilisateur.

**Spec:** pas de spec séparée — ce plan porte la conception (section « Décisions ») ; il prolonge le plan `groovy-foraging-toucan` (détection d'authorship), dont il réalise l'étape « Binoculars : plan suivant ».

## Faits établis (lus dans binoculars-eu, commit `575c9fcd22d905b6cd3765769aec2b4fc40f6c66`)

- API FastAPI : `POST /detect` `{ text (50–20 000 caractères), profile (défaut "fr"), mode ("accuracy" | "low-fpr" | "tpr-at-fpr-1") }` → `{ score (PPL / X-PPL, **bas = plutôt IA**), verdict, confidence, threshold_used, input_tokens, elapsed_ms, … }` ; `GET /profiles` → `[{ code, observer_model, performer_model, thresholds: { accuracy, low_fpr, tpr_at_fpr_1 }, calibration_date, … }]` ; `GET /health`.
- Profils : `fr` (paire Luciole 1B, tourne sur CPU, ~5 Go de VRAM sur GPU) — AUC 0,959 [0,914 ; 0,989], TPR@FPR 1 % 0,480 ; `fr8b` (paire Luciole 8B, nf4, GPU) — AUC 0,988, TPR@FPR 1 % 0,900. Seuils `fr` : `accuracy` 0,955801, `low_fpr` 0,866667.
- **Aucun profil anglais.** Les seuils sont propres au français et ne se réutilisent pas pour une autre langue.
- Limites publiées : textes humains encyclopédiques lus comme IA dans ~50 % des cas (dev) ; littérature classique 56 % ; fragile aux fautes de frappe (ΔAUC −0,242) ; un texte humanisé commercialement passe (TPR 0,31 en `fr8b`).
- Lancement : `uv pip install "binoculars-eu[api]"` puis `uvicorn binoculars_eu.api:app --host 127.0.0.1 --port 8000`.

## Décisions (à valider avant exécution)

1. **Français seulement.** Le signal vaut `null` hors français, avec la raison dans `detail`. Un profil anglais est un autre plan.
2. **CLI seulement.** La page garde `connect-src 'self'` (non négociable de PRODUCT.md) ; aucun import de `src/cli/` depuis la page (garde `check:imports`).
3. **Loopback par défaut.** `http://127.0.0.1:8000`, ou `UNMARK_BINOCULARS_URL`, ou `--binoculars-url`. Une URL hors de la machine est **refusée** sans `--allow-remote`, et le refus dit que le texte partirait.
4. **Valeur du signal** : linéaire par morceaux sur les seuils du profil lus à `GET /profiles` — 1 à `low_fpr` et en dessous, 0,5 à `accuracy`, 0 à `accuracy + (accuracy − low_fpr)` et au-dessus. Monotone, lisible, et ancrée sur la calibration propre de binoculars-eu.
5. **Un signal parmi d'autres.** Id `binoculars`, étiquette `EXTERNAL_MODEL`, poids `CALIBRATION.weights.binoculars` — provisoire à **0,3** jusqu'à l'ajustement de la tâche 5. Il compte pour la garde A comme les autres : à lui seul il ne fait jamais `likely_ai`. Un serveur absent ne change **ni le verdict ni le code de sortie** par rapport à aujourd'hui : il laisse une note sur stderr.
6. **Profil** : `fr` par défaut (tourne sur CPU), `UNMARK_BINOCULARS_PROFILE=fr8b` pour le 8B.
7. **Critère de sortie** (tâche 5) : sur le split de test, 0 document humain `likely_ai` — strate `fr/encyclopedic` comprise, vu la limite publiée — et une AUROC au moins égale à celle d'aujourd'hui (0,763), sinon le poids ajusté est retenu tel quel et le README dit ce qu'il apporte ou n'apporte pas.

## Global Constraints

- `src/core/**` n'importe jamais `node:` et ne touche pas au réseau (erreur de compilation via `tsconfig.app.json`).
- La page ne peut atteindre ni `src/cli/` ni `src/core/text/authorship/` statiquement (`pnpm check:imports`).
- Défaut loopback ; toute sortie réseau hors machine exige `--allow-remote`.
- Aucun verdict `confirmed` ; l'abstention sous 150 mots reste prioritaire (le signal n'est pas demandé sous ce seuil).
- Commits signés (`git log --format='%G?'` = `G`), sans aucune mention de Claude.
- Après chaque tâche touchant `src/core` ou `src/cli` : `pnpm test`, puis `pnpm build:skill && pnpm verify:skill` ; `pnpm verify` à la fin.

## Review Focus

1. **Serveur absent, lent ou qui plante** : `detect --binoculars` doit sortir avec le même code qu'avant, signal `null`, une ligne sur stderr qui dit comment lancer le serveur — jamais une trace de pile ni un blocage (timeout).
2. **Texte de plus de 20 000 caractères** : découpé aux paragraphes, scores combinés au prorata des tokens ; un paragraphe géant est coupé, pas envoyé et rejeté en 422.
3. **Texte anglais ou mixte** : aucun appel au serveur pour de l'anglais ; `detail` dit pourquoi.
4. **URL distante sans `--allow-remote`** : refus avant toute requête, avec le nom d'hôte.
5. **Réponse inattendue** (score absent, `NaN`, profil introuvable, HTTP 422/500) : signal `null` avec la raison, jamais une valeur inventée.

---

## Fichiers

- Create: `src/core/text/authorship/binoculars.ts` — valeur du signal, découpage, combinaison, construction de l'`ExternalSignal` (pur).
- Create: `src/core/text/authorship/binoculars.test.ts`
- Modify: `src/core/text/authorship/calibration.ts` — champ `weights.binoculars`.
- Modify: `scripts/eval-authorship.mjs` — en-tête de calibration généré, option `--binoculars`, cache.
- Create: `src/cli/binoculars.ts` — client HTTP (loopback, profils, timeout, validation).
- Create: `src/cli/binoculars.test.ts` — serveur `node:http` de test.
- Modify: `src/cli/main.ts` — options `--binoculars`, `--binoculars-url`, `--allow-remote`.
- Modify: `src/cli/main.test.ts`
- Modify: `scripts/verify-skill-bundle.mjs`, `skills/unmark/SKILL.md`, `skills/unmark/references/authorship.md`, `README.md`, `docs/authorship-eval-<date>.{md,json}`.

---

### Task 1: le signal, pur

**Files:**

- Create: `src/core/text/authorship/binoculars.ts`
- Test: `src/core/text/authorship/binoculars.test.ts`
- Modify: `src/core/text/authorship/index.ts` (réexports)

**Interfaces:**

- Produces:
  - `interface BinocularsThresholds { accuracy: number; low_fpr: number }`
  - `type BinocularsOutcome = { ok: true; score: number; tokens: number; profile: string; thresholds: BinocularsThresholds } | { ok: false; reason: string }`
  - `binocularsValue(score: number, thresholds: BinocularsThresholds): number | null`
  - `chunksOf(text: string, max?: number): string[]` (`max` défaut `BINOCULARS_MAX_CHARS = 20_000`)
  - `combineScores(parts: readonly { score: number; tokens: number }[]): number | null`
  - `binocularsSignal(outcome: BinocularsOutcome, weight: number): ExternalSignal`

- [ ] **Step 1: écrire les tests qui échouent**

```ts
import { describe, expect, it } from 'vitest'
import {
  BINOCULARS_MAX_CHARS,
  binocularsSignal,
  binocularsValue,
  chunksOf,
  combineScores,
} from './binoculars.ts'

const FR = { accuracy: 0.955801, low_fpr: 0.866667 }

describe('binocularsValue', () => {
  it('reads a low score as generated, anchored on the profile thresholds', () => {
    expect(binocularsValue(0.8, FR)).toBe(1)
    expect(binocularsValue(0.866667, FR)).toBeCloseTo(1)
    expect(binocularsValue(0.955801, FR)).toBeCloseTo(0.5)
    expect(binocularsValue(1.2, FR)).toBe(0)
  })

  it('refuses a score that is not a number', () => {
    expect(binocularsValue(Number.NaN, FR)).toBeNull()
    expect(binocularsValue(Number.POSITIVE_INFINITY, FR)).toBeNull()
  })
})

describe('chunksOf', () => {
  it('keeps a text under the limit whole', () => {
    expect(chunksOf('Un paragraphe assez long pour être lu par le modèle, voilà.')).toHaveLength(1)
  })

  it('packs paragraphs up to the limit and cuts one that is longer', () => {
    const paragraph = `${'mot '.repeat(3000).trim()}.`
    const chunks = chunksOf([paragraph, paragraph, paragraph, 'x'.repeat(30_000)].join('\n\n'))
    expect(chunks.every((chunk) => chunk.length <= BINOCULARS_MAX_CHARS)).toBe(true)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
  })

  it('drops pieces too short for the server to score', () => {
    expect(chunksOf('Court.')).toEqual([])
  })
})

describe('combineScores', () => {
  it('weights each chunk by its tokens', () => {
    expect(
      combineScores([
        { score: 0.8, tokens: 300 },
        { score: 1.0, tokens: 100 },
      ]),
    ).toBeCloseTo(0.85)
    expect(combineScores([])).toBeNull()
  })
})

describe('binocularsSignal', () => {
  it('turns a result into an external signal with its reason', () => {
    const signal = binocularsSignal(
      { ok: true, score: 0.9, tokens: 400, profile: 'fr', thresholds: FR },
      0.3,
    )
    expect(signal).toMatchObject({ id: 'binoculars', weight: 0.3 })
    expect(signal.value).toBeGreaterThan(0.5)
    expect(signal.detail).toContain('0.900')
  })

  it('carries a failure as an unmeasured signal, never as zero', () => {
    const signal = binocularsSignal({ ok: false, reason: 'no server' }, 0.3)
    expect(signal.value).toBeNull()
    expect(signal.detail).toBe('no server')
  })
})
```

- [ ] **Step 2: vérifier qu'ils échouent**

Run: `npx vitest run src/core/text/authorship/binoculars.test.ts`
Expected: FAIL — `Cannot find module './binoculars.ts'`

- [ ] **Step 3: implémenter**

```ts
// A model's opinion, turned into one signal among the others.
//
// Binoculars compares how surprising a text is to one model with how
// surprising the other model finds it. binoculars-eu serves the score over
// HTTP; the command line fetches it, and this module only does arithmetic on
// what came back, so the core stays pure and never touches a network.
//
// The value is anchored on the profile's own calibration rather than on
// numbers of ours: 1 at its low-false-positive threshold and below, 0.5 at
// its accuracy threshold, 0 as far above it as low_fpr sits below.

import type { ExternalSignal } from './signals.ts'

export interface BinocularsThresholds {
  accuracy: number
  low_fpr: number
}

export type BinocularsOutcome =
  | { ok: true; score: number; tokens: number; profile: string; thresholds: BinocularsThresholds }
  | { ok: false; reason: string }

/** The server refuses more than this per request (binoculars-eu schema). */
export const BINOCULARS_MAX_CHARS = 20_000
/** …and fewer than this. */
export const BINOCULARS_MIN_CHARS = 50

export function binocularsValue(score: number, thresholds: BinocularsThresholds): number | null {
  if (!Number.isFinite(score)) return null
  const span = thresholds.accuracy - thresholds.low_fpr
  if (span <= 0) return score <= thresholds.accuracy ? 1 : 0
  const value = 0.5 + (thresholds.accuracy - score) / (2 * span)
  return Math.min(1, Math.max(0, value))
}

/** Pieces the server accepts: paragraphs packed up to the limit, a long one cut. */
export function chunksOf(text: string, max = BINOCULARS_MAX_CHARS): string[] {
  const pieces: string[] = []
  for (const paragraph of text.split(/\n\s*\n/u)) {
    for (let at = 0; at < paragraph.length; at += max) pieces.push(paragraph.slice(at, at + max))
  }
  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece
    if (joined.length <= max) current = joined
    else {
      if (current) chunks.push(current)
      current = piece
    }
  }
  if (current) chunks.push(current)
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length >= BINOCULARS_MIN_CHARS)
}

export function combineScores(parts: readonly { score: number; tokens: number }[]): number | null {
  const tokens = parts.reduce((sum, part) => sum + part.tokens, 0)
  if (tokens === 0) return null
  return parts.reduce((sum, part) => sum + part.score * part.tokens, 0) / tokens
}

export function binocularsSignal(outcome: BinocularsOutcome, weight: number): ExternalSignal {
  const label = 'Model perplexity (Binoculars)'
  if (!outcome.ok) return { id: 'binoculars', value: null, weight, label, detail: outcome.reason }
  const value = binocularsValue(outcome.score, outcome.thresholds)
  return {
    id: 'binoculars',
    value: value === null ? null : Math.round(value * 1000) / 1000,
    weight,
    label,
    detail:
      value === null
        ? 'the server returned a score that is not a number'
        : `score ${outcome.score.toFixed(3)} on profile ${outcome.profile} over ${outcome.tokens} tokens; its own threshold is ${outcome.thresholds.accuracy.toFixed(3)}, lower reads as generated`,
  }
}
```

Dans `src/core/text/authorship/index.ts`, ajouter :

```ts
export {
  BINOCULARS_MAX_CHARS,
  binocularsSignal,
  binocularsValue,
  chunksOf,
  combineScores,
} from './binoculars.ts'
export type { BinocularsOutcome, BinocularsThresholds } from './binoculars.ts'
```

- [ ] **Step 4: vérifier qu'ils passent**

Run: `npx vitest run src/core/text/authorship/binoculars.test.ts && pnpm typecheck`
Expected: PASS, aucune erreur de type.

- [ ] **Step 5: commit**

```bash
git add src/core/text/authorship/binoculars.ts src/core/text/authorship/binoculars.test.ts src/core/text/authorship/index.ts
git commit -m "feat(authorship): turn a Binoculars score into a signal, anchored on its profile"
```

### Task 2: un poids pour ce signal dans la calibration

**Files:**

- Modify: `src/core/text/authorship/calibration.ts` (interface `Calibration.weights`, valeur `CALIBRATION`)
- Modify: `scripts/eval-authorship.mjs` (constante `CALIBRATION_SOURCE_HEADER`, qui recopie l'interface)
- Test: `src/core/text/authorship/verdict.test.ts`, `src/core/text/authorship/index.test.ts`

**Interfaces:**

- Consumes: `binocularsSignal` (tâche 1).
- Produces: `CALIBRATION.weights.binoculars: number` (provisoire `0.3`).

- [ ] **Step 1: test qui échoue** — dans `index.test.ts` :

```ts
import { CALIBRATION } from './calibration.ts'
import { binocularsSignal } from './binoculars.ts'

it('lets a Binoculars result move the score, and leaves it alone when unmeasured', () => {
  const thresholds = { accuracy: 0.955801, low_fpr: 0.866667 }
  const plain = detectAuthorship(AI_FR)
  const weight = CALIBRATION.weights.binoculars
  const flagged = detectAuthorship(AI_FR, {
    external: [
      binocularsSignal({ ok: true, score: 0.8, tokens: 300, profile: 'fr', thresholds }, weight),
    ],
  })
  const missing = detectAuthorship(AI_FR, {
    external: [binocularsSignal({ ok: false, reason: 'no server' }, weight)],
  })
  expect(weight).toBeGreaterThan(0)
  expect(flagged.score).toBeGreaterThan(plain.score as number)
  expect(missing.score).toBe(plain.score)
})
```

- [ ] **Step 2: vérifier l'échec**

Run: `npx vitest run src/core/text/authorship/index.test.ts`
Expected: FAIL — `expected undefined to be greater than 0` (et erreur de type sur `weights.binoculars`).

- [ ] **Step 3: implémenter** — dans l'interface `Calibration` de `calibration.ts` **et** dans `CALIBRATION_SOURCE_HEADER` de `scripts/eval-authorship.mjs`, ajouter la ligne `binoculars: number` après `stylometry: number` ; dans `CALIBRATION.weights`, ajouter :

```ts
    // Provisional: binoculars-eu's own evaluation, not ours. Refitted by
    // `eval-authorship.mjs --fit --binoculars` (task 5).
    binoculars: 0.3,
```

Dans `verdict.test.ts`, compléter l'objet `CAL.weights` avec `binoculars: 1`.

- [ ] **Step 4: vérifier** — Run: `pnpm test && pnpm typecheck` — Expected: tout passe.

- [ ] **Step 5: commit**

```bash
git add src/core/text/authorship/calibration.ts src/core/text/authorship/index.test.ts src/core/text/authorship/verdict.test.ts scripts/eval-authorship.mjs
git commit -m "feat(authorship): give the Binoculars signal a provisional weight"
```

### Task 3: le client HTTP, en loopback

**Files:**

- Create: `src/cli/binoculars.ts`
- Test: `src/cli/binoculars.test.ts`

**Interfaces:**

- Consumes: `chunksOf`, `combineScores`, `BinocularsOutcome` (tâche 1).
- Produces:
  - `BINOCULARS_URL = 'http://127.0.0.1:8000'`
  - `isLoopback(url: string): boolean`
  - `scoreWithBinoculars(text: string, options: { url: string; profile: string; allowRemote: boolean; timeoutMs?: number }): Promise<BinocularsOutcome>`

- [ ] **Step 1: tests qui échouent** (serveur `node:http` réel sur un port libre)

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { isLoopback, scoreWithBinoculars } from './binoculars.ts'

let server: Server | undefined
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())))

/** A stand-in for binoculars-eu: fixed thresholds, a score per request. */
async function fake(respond: (body: { text: string }) => { status: number; json: unknown }) {
  server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      if (request.url === '/profiles') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            {
              code: 'fr',
              thresholds: { accuracy: 0.955801, low_fpr: 0.866667, tpr_at_fpr_1: 0.866667 },
            },
          ]),
        )
        return
      }
      const { status, json } = respond(JSON.parse(raw) as { text: string })
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(json))
    })
  })
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

const TEXT = 'Un texte français assez long pour que le serveur accepte de le noter sans rechigner.'

describe('isLoopback', () => {
  it('knows this machine from another', () => {
    expect(isLoopback('http://127.0.0.1:8000')).toBe(true)
    expect(isLoopback('http://localhost:8000')).toBe(true)
    expect(isLoopback('http://[::1]:8000')).toBe(true)
    expect(isLoopback('https://binoculars.example.com')).toBe(false)
  })
})

describe('scoreWithBinoculars', () => {
  it('returns the score, the tokens and the profile thresholds', async () => {
    const url = await fake(() => ({ status: 200, json: { score: 0.9, input_tokens: 40 } }))
    expect(
      await scoreWithBinoculars(TEXT, { url, profile: 'fr', allowRemote: false }),
    ).toMatchObject({
      ok: true,
      score: 0.9,
      tokens: 40,
      thresholds: { accuracy: 0.955801, low_fpr: 0.866667 },
    })
  })

  it('refuses a server off this machine unless told to send the text there', async () => {
    const outcome = await scoreWithBinoculars(TEXT, {
      url: 'https://binoculars.example.com',
      profile: 'fr',
      allowRemote: false,
    })
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome.ok ? '' : outcome.reason).toMatch(/binoculars\.example\.com.*--allow-remote/)
  })

  it('says how to start the server when nothing answers', async () => {
    const outcome = await scoreWithBinoculars(TEXT, {
      url: 'http://127.0.0.1:9',
      profile: 'fr',
      allowRemote: false,
    })
    expect(outcome.ok ? '' : outcome.reason).toMatch(/uvicorn binoculars_eu\.api:app/)
  })

  it('refuses a response without a usable score', async () => {
    const url = await fake(() => ({ status: 200, json: { score: 'n/a', input_tokens: 40 } }))
    const outcome = await scoreWithBinoculars(TEXT, { url, profile: 'fr', allowRemote: false })
    expect(outcome.ok).toBe(false)
  })

  it('names an HTTP error and a missing profile', async () => {
    const url = await fake(() => ({ status: 422, json: { detail: 'too short' } }))
    const failed = await scoreWithBinoculars(TEXT, { url, profile: 'fr', allowRemote: false })
    expect(failed.ok ? '' : failed.reason).toMatch(/422/)
    const unknown = await scoreWithBinoculars(TEXT, { url, profile: 'de', allowRemote: false })
    expect(unknown.ok ? '' : unknown.reason).toMatch(/profile "de"/)
  })
})
```

- [ ] **Step 2: vérifier l'échec** — Run: `npx vitest run src/cli/binoculars.test.ts` — Expected: FAIL, module introuvable.

- [ ] **Step 3: implémenter**

```ts
// The Binoculars score, fetched from a binoculars-eu server.
//
// Loopback by default, like the rewrite loop's Ollama: the text goes to a
// process on this machine and nowhere else. A server anywhere else is refused
// until the user says, by flag, that the text may leave. Every failure comes
// back as a reason rather than a throw — a missing server must not change what
// `detect` already answers without it.

import {
  chunksOf,
  combineScores,
  type BinocularsOutcome,
  type BinocularsThresholds,
} from '../core/text/authorship/binoculars.ts'

export const BINOCULARS_URL = 'http://127.0.0.1:8000'
const START =
  'start it with: uv pip install "binoculars-eu[api]" && uvicorn binoculars_eu.api:app --host 127.0.0.1 --port 8000'

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...init, signal })
  if (!response.ok) throw new Error(`binoculars-eu answered HTTP ${response.status} at ${url}`)
  return response.json()
}

export async function scoreWithBinoculars(
  text: string,
  options: { url: string; profile: string; allowRemote: boolean; timeoutMs?: number },
): Promise<BinocularsOutcome> {
  const base = options.url.replace(/\/+$/, '')
  if (!isLoopback(base) && !options.allowRemote) {
    const host = (() => {
      try {
        return new URL(base).host
      } catch {
        return base
      }
    })()
    return {
      ok: false,
      reason: `refused: ${host} is not this machine, and the text would leave it; pass --allow-remote to send it there`,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
  try {
    const profiles = (await json(`${base}/profiles`, {}, controller.signal)) as {
      code?: string
      thresholds?: Partial<BinocularsThresholds>
    }[]
    const profile = Array.isArray(profiles)
      ? profiles.find((p) => p.code === options.profile)
      : undefined
    const accuracy = profile?.thresholds?.accuracy
    const lowFpr = profile?.thresholds?.low_fpr
    if (typeof accuracy !== 'number' || typeof lowFpr !== 'number') {
      return {
        ok: false,
        reason: `binoculars-eu has no profile "${options.profile}" with thresholds`,
      }
    }

    const parts: { score: number; tokens: number }[] = []
    for (const chunk of chunksOf(text)) {
      // oxlint-disable-next-line no-await-in-loop -- one model, one request at a time
      const answer = (await json(
        `${base}/detect`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: chunk, profile: options.profile, mode: 'accuracy' }),
        },
        controller.signal,
      )) as { score?: unknown; input_tokens?: unknown }
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
        return { ok: false, reason: 'binoculars-eu returned no usable score' }
      }
      const tokens =
        typeof answer.input_tokens === 'number' ? answer.input_tokens : chunk.length / 4
      parts.push({ score: answer.score, tokens })
    }

    const score = combineScores(parts)
    if (score === null)
      return { ok: false, reason: 'the text is too short for binoculars-eu to score' }
    return {
      ok: true,
      score,
      tokens: Math.round(parts.reduce((sum, part) => sum + part.tokens, 0)),
      profile: options.profile,
      thresholds: { accuracy, low_fpr: lowFpr },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted)
      return { ok: false, reason: `binoculars-eu did not answer in time at ${base}` }
    if (/HTTP \d+/.test(message)) return { ok: false, reason: message }
    return { ok: false, reason: `no binoculars-eu server at ${base} — ${START}` }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: vérifier** — Run: `npx vitest run src/cli/binoculars.test.ts && pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add src/cli/binoculars.ts src/cli/binoculars.test.ts
git commit -m "feat(cli): fetch a Binoculars score from a local binoculars-eu server"
```

### Task 4: `detect --binoculars`

**Files:**

- Modify: `src/cli/main.ts` — `USAGE`, `Options`, `KNOWN_FLAGS`, liste de consommation par index, contrôle « option sans valeur », `commandDetect`.
- Test: `src/cli/main.test.ts`

**Interfaces:**

- Consumes: `scoreWithBinoculars`, `BINOCULARS_URL` (tâche 3) ; `binocularsSignal`, `CALIBRATION` (tâches 1–2).
- Produces: options CLI `--binoculars`, `--binoculars-url <url>`, `--allow-remote` ; variables `UNMARK_BINOCULARS_URL`, `UNMARK_BINOCULARS_PROFILE`.

- [ ] **Step 1: tests qui échouent** — en tête de `main.test.ts`, ajouter les imports et l'helper, puis les tests dans le bloc `describe('detect')` :

```ts
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'

// A real English text of more than 150 words: Wikipedia, "Octopus", revision
// before 2022-06 (CC BY-SA 3.0), from the committed corpus.
const ENGLISH_150_WORDS = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    'fixtures',
    'authorship',
    'human',
    'en',
    'human-en-encyclopedic-octopus.md',
  ),
  'utf8',
)

let binoculars: Server | undefined
afterEach(() => new Promise<void>((done) => (binoculars ? binoculars.close(() => done()) : done())))

/** A stand-in binoculars-eu answering every text with `score`; `onDetect` counts calls. */
async function fakeBinoculars(score: number, onDetect: () => void = () => {}): Promise<string> {
  binoculars = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/profiles') {
        response.end(
          JSON.stringify([{ code: 'fr', thresholds: { accuracy: 0.955801, low_fpr: 0.866667 } }]),
        )
        return
      }
      onDetect()
      response.end(JSON.stringify({ score, input_tokens: 200 }))
    })
  })
  await new Promise<void>((done) => binoculars?.listen(0, '127.0.0.1', done))
  const address = binoculars.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}
```

```ts
it('adds the Binoculars signal when a local server answers', async () => {
  const url = await fakeBinoculars(0.8)
  await main([
    'detect',
    await file('draft.md', LOADED),
    '--json',
    '--binoculars',
    '--binoculars-url',
    url,
  ])
  const signal = parse().signals.find((s: { id: string }) => s.id === 'binoculars')
  expect(signal.value).toBe(1)
})

it('answers exactly as before when no server answers, and says why on stderr', async () => {
  const path = await file('draft.md', LOADED)
  const without = await main(['detect', path, '--json'])
  const before = parse()
  out = []
  const withIt = await main([
    'detect',
    path,
    '--json',
    '--binoculars',
    '--binoculars-url',
    'http://127.0.0.1:9',
  ])
  expect(withIt).toBe(without)
  expect(parse().verdict).toBe(before.verdict)
  expect(stderr()).toMatch(/Binoculars not used — no binoculars-eu server/)
})

it('does not call the server for English', async () => {
  let calls = 0
  const url = await fakeBinoculars(0.8, () => (calls += 1))
  await main([
    'detect',
    await file('en.md', ENGLISH_150_WORDS),
    '--json',
    '--binoculars',
    '--binoculars-url',
    url,
  ])
  expect(calls).toBe(0)
  expect(stderr()).toMatch(/French profile only/)
})

it('refuses a remote server without --allow-remote', async () => {
  await main([
    'detect',
    await file('draft.md', LOADED),
    '--binoculars',
    '--binoculars-url',
    'https://example.com',
  ])
  expect(stderr()).toMatch(/--allow-remote/)
})
```

- [ ] **Step 2: vérifier l'échec** — Run: `npx vitest run src/cli/main.test.ts` — Expected: FAIL (option inconnue → exit 2).

- [ ] **Step 3: implémenter** — dans `main.ts` :
  - `KNOWN_FLAGS` += `'--binoculars'`, `'--binoculars-url'`, `'--allow-remote'` ; liste de consommation par index += `'--binoculars-url'` ; contrôle « needs a value » += `'--binoculars-url'`.
  - `Options` += `binoculars: boolean; binocularsUrl?: string; allowRemote: boolean`, remplis par `flags.has('--binoculars')`, `value('--binoculars-url')`, `flags.has('--allow-remote')`.
  - `USAGE`, bloc DETECT :

```
  --binoculars        add a model-based signal from a local binoculars-eu server
                      (French only; http://127.0.0.1:8000, or UNMARK_BINOCULARS_URL)
  --binoculars-url <u>  another server; off this machine it needs --allow-remote,
                      and the text LEAVES YOUR MACHINE
```

- Dans `commandDetect`, remplacer l'appel unique à `detectAuthorship` par :

```ts
const lang = options.lang ?? 'auto'
let report = detectAuthorship(textual.text, { format: textual.format, lang })
if (options.binoculars && report.verdict !== 'insufficient_evidence') {
  const outcome =
    report.language.document === 'fr'
      ? await scoreWithBinoculars(textual.text, {
          url: options.binocularsUrl ?? process.env['UNMARK_BINOCULARS_URL'] ?? BINOCULARS_URL,
          profile: process.env['UNMARK_BINOCULARS_PROFILE'] ?? 'fr',
          allowRemote: options.allowRemote,
        })
      : ({ ok: false, reason: 'binoculars-eu has a French profile only' } as const)
  if (!outcome.ok) process.stderr.write(`unmark: Binoculars not used — ${outcome.reason}\n`)
  report = detectAuthorship(textual.text, {
    format: textual.format,
    lang,
    external: [binocularsSignal(outcome, CALIBRATION.weights.binoculars)],
  })
}
```

(imports : `scoreWithBinoculars`, `BINOCULARS_URL` depuis `./binoculars.ts` ; `binocularsSignal`, `CALIBRATION` depuis `../core/text/authorship/index.ts`.)

- [ ] **Step 4: vérifier** — Run: `pnpm test && pnpm build:skill && pnpm verify:skill` — Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add src/cli/main.ts src/cli/main.test.ts skills/unmark/scripts/unmark.mjs
git commit -m "feat(cli): detect --binoculars, a model signal from a local server"
```

### Task 5: mesurer, puis ajuster le poids

Tâche d'opérateur : elle demande un serveur binoculars-eu qui tourne. Profil `fr` sur CPU : compter de l'ordre de quelques secondes par texte ; sur GPU, ~60 ms (chiffre binoculars-eu, L4).

**Files:**

- Modify: `scripts/eval-authorship.mjs` — option `--binoculars <url>`, cache, signal dans les échantillons, `FITTED` et `SIGNALS` += `'binoculars'`.
- Create (générés) : `src/core/text/authorship/calibration.ts`, `fixtures/authorship/baseline.json`, `docs/authorship-eval-<date>.{md,json}`.

**Interfaces:**

- Consumes: `scoreWithBinoculars` (tâche 3), `binocularsSignal` (tâche 1).

- [ ] **Step 1: brancher le signal dans l'éval** — dans `measure(doc, calibration)`, accepter un paramètre `external` et le passer à `detectAuthorship` ; au démarrage, si `--binoculars <url>` est donné, calculer pour chaque document français (`doc.lang === 'fr'`) :

```js
import { scoreWithBinoculars } from '../src/cli/binoculars.ts'
import { binocularsSignal } from '../src/core/text/authorship/binoculars.ts'

const CACHE = join(CORPUS_DIR, '..', 'binoculars-scores.json')
const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {}
async function binocularsFor(doc, url) {
  if (doc.lang !== 'fr') return { ok: false, reason: 'binoculars-eu has a French profile only' }
  const key = createHash('sha256').update(`fr\0${doc.text}`).digest('hex')
  cache[key] ??= await scoreWithBinoculars(doc.text, { url, profile: 'fr', allowRemote: false })
  return cache[key]
}
// après la boucle : await writeFile(CACHE, JSON.stringify(cache))
```

et ajouter `'binoculars'` à `SIGNALS` et à `FITTED` quand l'option est présente (le poids de `forensic` reste fixé, comme aujourd'hui).

- [ ] **Step 2: lancer le serveur, puis l'éval sans ajustement**

Run :

```bash
uvicorn binoculars_eu.api:app --host 127.0.0.1 --port 8000 &
node scripts/fetch-authorship-corpus.mjs
node --experimental-strip-types scripts/eval-authorship.mjs --binoculars http://127.0.0.1:8000 --split test
```

Expected: un tableau « Separation » où le signal `binoculars` figure ; noter l'AUROC et le FPR de `fr/encyclopedic`.

- [ ] **Step 3: ajuster sur le split d'entraînement**

Run: `node --experimental-strip-types scripts/eval-authorship.mjs --binoculars http://127.0.0.1:8000 --fit --split test`
Expected: `calibration.ts` régénéré avec `weights.binoculars` ajusté, `baseline.json` et `docs/authorship-eval-<date>.*` réécrits.

- [ ] **Step 4: critère de sortie**

Vérifier dans le rapport généré : 0 document humain `likely_ai` sur le test, strate `fr/encyclopedic` comprise, et AUROC ≥ 0,763. Puis `pnpm test` (le test du corpus figé relit `baseline.json`).
Expected: PASS. Si le critère `fr/encyclopedic` échoue, ne pas monter le poids à la main : consigner le résultat, garder le poids ajusté, et dire dans le README (tâche 6) sur quelles strates le signal nuit.

- [ ] **Step 5: commit**

```bash
git add scripts/eval-authorship.mjs src/core/text/authorship/calibration.ts fixtures/authorship/baseline.json docs/authorship-eval-*.md docs/authorship-eval-*.json
git commit -m "feat(eval): measure the Binoculars signal and fit its weight"
```

### Task 6: skill, docs, garde du bundle

**Files:**

- Modify: `scripts/verify-skill-bundle.mjs`, `skills/unmark/SKILL.md`, `skills/unmark/references/authorship.md`, `README.md`

- [ ] **Step 1: garde qui échoue** — dans `verify-skill-bundle.mjs`, après les vérifications `detect` :

```js
// Sans serveur (le cas de la CI), --binoculars ne change ni le verdict ni le
// code de sortie, et dit pourquoi.
const plainCode = unmark(['detect', at('brouillon.md')]).code
const noServer = unmark([
  'detect',
  at('brouillon.md'),
  '--binoculars',
  '--binoculars-url',
  'http://127.0.0.1:9',
])
check('detect --binoculars', noServer.code === plainCode, 'must answer as before with no server')
check('detect --binoculars', /Binoculars not used/.test(noServer.err), 'should say why on stderr')
```

L'helper `unmark()` du script jette stderr quand le code vaut 0 (`execFileSync` ne rend que stdout). Le remplacer par une version qui garde les deux flux :

```js
import { spawnSync } from 'node:child_process'

/** Run the bundle and return { code, out, err } without throwing, stderr kept either way. */
function unmark(args) {
  const run = spawnSync(process.execPath, [BUNDLE, ...args], {
    timeout: 30_000,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: run.status ?? 1, out: run.stdout ?? '', err: run.stderr ?? '' }
}
```

- [ ] **Step 2: vérifier l'échec** — Run: `pnpm build:skill && pnpm verify:skill` — Expected: échec tant que l'helper ne capture pas stderr.

- [ ] **Step 3: docs**
  - `skills/unmark/SKILL.md`, section « Was this written by AI? », étape 1 : « Si un serveur binoculars-eu tourne en local, ajouter `--binoculars` ; le signal `binoculars` est un signal de plus, jamais une preuve, et vaut `null` pour l'anglais. »
  - `references/authorship.md` : ligne `EXTERNAL_MODEL` dans le tableau des étiquettes de preuve ; la limite publiée (textes encyclopédiques humains lus comme IA) dans « What is not evidence ».
  - `README.md`, section « Authorship assessment » : comment lancer binoculars-eu, les options, la politique loopback, et les chiffres mesurés à la tâche 5 (avec IC et strates), y compris là où le signal nuit.

- [ ] **Step 4: vérifier** — Run: `pnpm verify` — Expected: exit 0.

- [ ] **Step 5: commit**

```bash
git add scripts/verify-skill-bundle.mjs skills/unmark README.md skills/unmark/scripts/unmark.mjs
git commit -m "docs: the Binoculars signal — how to run it, what it adds, where it misleads"
```
