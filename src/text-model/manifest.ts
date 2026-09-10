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

export const MODEL_LABEL = 'Qwen3.5 0.8B'
