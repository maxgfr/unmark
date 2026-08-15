// Calling a model, from the one place in this project that is allowed to.
//
// The page's promise is that nothing is uploaded and nothing can be: a
// Content-Security-Policy pinned to `connect-src 'self'`, a build gate that
// fails on any outbound origin, and a README that records dropping an
// in-browser paraphrase for exactly this reason. None of that changes. This
// file lives in `src/cli`, the page never imports it, and `pnpm check:network`
// walks `dist` and would fail if it ever did.
//
// The default is loopback. `unmark rewrite` talks to Ollama on 127.0.0.1 and
// nothing leaves the machine; `--model` opts into a remote provider and says so;
// `--print-prompt` contacts nothing at all and spends nothing, which is the
// path for anyone who wants to paste the prompt somewhere themselves.
//
// llm-models (github.com/maxgfr/llm-models) is spawned as a process, never
// imported: the skill bundle is verified to have zero bare imports and "one
// file, no install step" is a property this CLI is not giving up for a
// convenience. When it is absent the remote path still works — it just cannot
// price the job, and it says so rather than guessing.

// oxlint-disable no-await-in-loop -- the retry loop is sequential by nature:
// each attempt is aimed at the previous attempt's failures.

import { spawn } from 'node:child_process'
import process from 'node:process'
import { briefToPrompt, verifyRewrite, type Brief, type RewriteVerdict } from '../core/rewrite.ts'

const OLLAMA = 'http://127.0.0.1:11434'

export interface RewriteOptions {
  /** A remote model id. Absent means the local loopback endpoint. */
  model?: string
  /** Emit the prompt and stop. No network, no spend. */
  printPrompt?: boolean
  /** How many times to let the model try before giving up and saying why. */
  attempts?: number
  /** Overridden in tests. */
  endpoint?: string
}

export interface RewriteOutcome {
  kind: 'prompt' | 'accepted' | 'rejected' | 'unavailable'
  text: string
  verdict?: RewriteVerdict | undefined
  attempts: number
  /** Anything the user should know before or after money was spent. */
  notes: string[]
}

/** Run a command and collect stdout, returning undefined if it is not installed. */
function run(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? out : undefined))
    // A registry lookup must never be the reason a rewrite hangs.
    setTimeout(() => {
      child.kill()
      resolve(undefined)
    }, 15_000).unref?.()
  })
}

interface ModelFacts {
  contextLength?: number | undefined
  inputPerMillion?: number | undefined
  outputPerMillion?: number | undefined
}

/**
 * Ask llm-models what this model is and what it costs.
 *
 * Best effort by design. A missing optional tool degrades a feature; it never
 * fails the command.
 */
export async function describeModel(id: string): Promise<ModelFacts | undefined> {
  const raw =
    (await run('llm-models', ['info', id, '--json'])) ??
    (await run('npx', ['--yes', 'llm-models', 'info', id, '--json']))
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const model = (parsed['model'] ?? parsed) as Record<string, unknown>
    const cost = (model['cost'] ?? model['pricing'] ?? {}) as Record<string, unknown>
    const number = (value: unknown) => (typeof value === 'number' ? value : undefined)
    return {
      contextLength: number(model['context_length'] ?? model['contextLength'] ?? model['limit']),
      inputPerMillion: number(cost['input'] ?? cost['prompt']),
      outputPerMillion: number(cost['output'] ?? cost['completion']),
    }
  } catch {
    return undefined
  }
}

/** Roughly four characters per token. Enough to warn, never precise enough to bill. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4)

async function askOllama(endpoint: string, prompt: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env['UNMARK_OLLAMA_MODEL'] ?? 'llama3.1',
        prompt,
        stream: false,
        options: { temperature: 0.7 },
      }),
    })
    if (!response.ok) return undefined
    const parsed = (await response.json()) as { response?: string }
    return parsed.response
  } catch {
    return undefined
  }
}

async function askRemote(model: string, prompt: string): Promise<string | undefined> {
  const base = process.env['UNMARK_API_BASE'] ?? 'https://openrouter.ai/api/v1'
  const key = process.env['UNMARK_API_KEY'] ?? process.env['OPENROUTER_API_KEY']
  if (!key) return undefined

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    })
    if (!response.ok) return undefined
    const parsed = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return parsed.choices?.[0]?.message?.content
  } catch {
    return undefined
  }
}

/**
 * brief -> rewrite -> verify, looping until it passes or the attempts run out.
 *
 * The loop is the point. A single call returns something plausible; the loop
 * returns something that cleared a deterministic gate, or an honest failure
 * naming what it could not fix.
 */
export async function runRewrite(
  text: string,
  brief: Brief,
  options: RewriteOptions = {},
): Promise<RewriteOutcome> {
  const notes: string[] = []
  const prompt = briefToPrompt(text, brief)

  if (options.printPrompt) {
    return { kind: 'prompt', text: prompt, attempts: 0, notes }
  }

  if (options.model) {
    notes.push(`Sending this document to ${options.model}. It leaves this machine.`)
    const facts = await describeModel(options.model)
    // `briefToPrompt` already embeds the whole document, so counting the text
    // again doubled it: the context-length refusal fired at roughly half the
    // model's real capacity, turning jobs that would have worked into an
    // `unavailable`, and the price quoted was twice what it should have been.
    const tokens = estimateTokens(prompt)
    if (facts?.contextLength && tokens > facts.contextLength) {
      return {
        kind: 'unavailable',
        text: '',
        attempts: 0,
        notes: [
          ...notes,
          `The document needs about ${tokens} tokens and ${options.model} holds ${facts.contextLength}. Split it or pick a larger model.`,
        ],
      }
    }
    if (facts?.inputPerMillion !== undefined && facts.outputPerMillion !== undefined) {
      const cost =
        (tokens / 1_000_000) * facts.inputPerMillion +
        (estimateTokens(text) / 1_000_000) * facts.outputPerMillion
      notes.push(`Roughly $${cost.toFixed(4)} per attempt, before this is spent rather than after.`)
    } else {
      notes.push('llm-models is not installed, so this job could not be priced first.')
    }
  } else {
    notes.push('Local only: 127.0.0.1. Nothing leaves this machine.')
  }

  const attempts = Math.max(1, options.attempts ?? 3)
  let last: RewriteVerdict | undefined
  let candidate = ''

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Each retry is told what failed, so it is aimed rather than another roll
    // of the dice.
    const aimed =
      last && last.failures.length > 0
        ? `${prompt}\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR:\n${last.failures
            .map((failure) => `- ${failure.what}: ${failure.detail}`)
            .join('\n')}`
        : prompt

    const answer = options.model
      ? await askRemote(options.model, aimed)
      : await askOllama(options.endpoint ?? OLLAMA, aimed)

    if (answer === undefined) {
      return {
        kind: 'unavailable',
        text: '',
        attempts: attempt - 1,
        notes: [
          ...notes,
          options.model
            ? 'The provider did not answer. Set UNMARK_API_KEY, or use --print-prompt.'
            : `No model answered on ${options.endpoint ?? OLLAMA}. Start Ollama, or use --print-prompt.`,
        ],
      }
    }

    candidate = answer.trim()
    last = verifyRewrite(text, candidate, brief)
    if (last.ok) {
      return { kind: 'accepted', text: candidate, verdict: last, attempts: attempt, notes }
    }
  }

  return { kind: 'rejected', text: candidate, verdict: last, attempts, notes }
}
