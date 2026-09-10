// Sizes and hashes are pinned in scripts/text-model-assets.json.
export const MODEL_ID = 'Qwen3.5-0.8B-q4f16_1-MLC'
export const MODEL_BYTES = 453205372
export const CONTEXT_TOKENS = 4096
export const OUTPUT_TOKENS = 1024
export const MODEL_BASE = 'vendor/text/resolve/0ec13897-025bcaf3/'

export const MODEL_FILES = [
  'model.wasm',
  'mlc-chat-config.json',
  'tensor-cache.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  ...Array.from({ length: 11 }, (_, index) => `params_shard_${index}.bin`),
]

/**
 * The files a visitor's browser actually downloads.
 *
 * `mlc-chat-config.json` declares four tokenizer files and the runtime stops at
 * the first that works, so `vocab.json`, `merges.txt` and `tokenizer_config.json`
 * are pinned, served and allowlisted but never fetched — 10 MB of the 453 MB
 * that no visitor pays for. They stay served because the config names them and a
 * different runtime build may take that fallback path; they are not counted as
 * part of the download, because counting them would overstate it by 10 MB and
 * leave the cached-file count permanently short of its own total.
 */
export const RUNTIME_FILES = MODEL_FILES.filter(
  (file) => !['vocab.json', 'merges.txt', 'tokenizer_config.json'].includes(file),
)
/** Sum of `RUNTIME_FILES` in scripts/text-model-assets.json; a test keeps it true. */
export const RUNTIME_BYTES = 443112645

export const MODEL_LABEL = 'Qwen3.5 0.8B'
/** The pinned in-browser runtime; kept in step with package.json by a test. */
export const RUNTIME_LABEL = 'WebLLM 0.2.85'
export const RUNTIME_VERSION = '0.2.85'

/**
 * The Cache API store WebLLM keeps each file in. The runtime binary and the
 * chat config live apart from the weights; knowing where lets the page report
 * and delete what is on disk without importing the runtime on the main thread.
 */
export function cacheScopeOf(file: string): 'webllm/wasm' | 'webllm/config' | 'webllm/model' {
  if (file === 'model.wasm') return 'webllm/wasm'
  if (file === 'mlc-chat-config.json') return 'webllm/config'
  return 'webllm/model'
}
