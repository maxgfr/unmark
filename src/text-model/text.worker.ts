import { MLCEngine } from '@mlc-ai/web-llm'
import { Tokenizer } from '@mlc-ai/web-tokenizers'
import { MODEL_ID, MODEL_BASE, MODEL_FILES, CONTEXT_TOKENS, OUTPUT_TOKENS } from './manifest.ts'

import { modelText } from './response.ts'

const root = new URL(`${import.meta.env.BASE_URL}${MODEL_BASE}`, self.location.origin)
const permitted = new Set(MODEL_FILES.map((file) => new URL(file, root).href))
// Model requests are static downloads only. Even a dependency cannot put a
// user's prompt into a URL or request body on this origin.
const fetchAsset = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    url.origin !== root.origin ||
    url.search ||
    !permitted.has(url.href)
  ) {
    return Promise.reject(new Error('Only local model assets may be downloaded.'))
  }
  return fetchAsset(request)
}

const engine = new MLCEngine({
  appConfig: {
    cacheBackend: 'cache',
    model_list: [
      {
        model_id: MODEL_ID,
        required_features: ['shader-f16'],
        model: root.href,
        model_lib: new URL('model.wasm', root).href,
        overrides: { context_window_size: CONTEXT_TOKENS, max_history_size: 1 },
      },
    ],
  },
  initProgressCallback: ({ text }) => self.postMessage({ kind: 'progress', text }),
})
let tokenizer: Tokenizer | undefined
let loaded = false

async function loadTokenizer(): Promise<Tokenizer> {
  if (tokenizer) return tokenizer
  // Share the pinned WebLLM Cache API store so preflight also works offline.
  const cache = await caches.open('webllm/model')
  const url = new URL('tokenizer.json', root).href
  let response = await cache.match(url)
  if (!response) {
    response = await fetch(url)
    if (!response.ok)
      throw new Error('The tokenizer could not be downloaded. Retry when connected.')
    await cache.put(url, response.clone())
  }
  tokenizer = await Tokenizer.fromJSON(await response.arrayBuffer())
  return tokenizer
}

async function loadModel(): Promise<void> {
  if (loaded) return
  await engine.reload(MODEL_ID)
  loaded = true
}

type Job = { id: number; kind: 'prepare' } | { id: number; prompt: string }

self.onmessage = async (event: MessageEvent<Job>) => {
  const { id } = event.data
  try {
    if ('kind' in event.data) {
      await loadTokenizer()
      await loadModel()
      self.postMessage({ kind: 'ready', id, text: '' })
      return
    }
    const { prompt } = event.data
    const encoder = await loadTokenizer()
    // Reserve output and chat-template tokens; never let WebLLM slide away
    // the beginning of a document to make a too-long prompt fit.
    if (encoder.encode(prompt).length + OUTPUT_TOKENS + 128 > CONTEXT_TOKENS) {
      throw new Error(
        'This passage is too long for Deep clean. Try a shorter passage; basic cleaning is ready.',
      )
    }
    await loadModel()
    const reply = await engine.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: OUTPUT_TOKENS,
      seed: 41,
      extra_body: { enable_thinking: false },
    })
    const choice = reply.choices[0]
    if (choice?.finish_reason === 'length')
      throw new Error('The rewrite reached its length limit. Try a shorter passage.')
    const text = choice?.message.content
    if (typeof text !== 'string') throw new Error('The model returned no text.')
    self.postMessage({ kind: 'answer', id, text: modelText(text) })
  } catch (error) {
    self.postMessage({
      kind: 'error',
      id,
      text: error instanceof Error ? error.message : 'Local rewrite failed.',
    })
  }
}
