// The local model, as a thing the visitor can see and manage.
//
// Before this panel the model was a sentence: "453 MB, downloads when you
// press Clean text". Whether it had already been downloaded, whether it was
// still occupying the GPU, whether this device could run it at all — none of
// that was anywhere. Now it is a short table with three actions, and it is
// disclosed under Advanced options where it belongs.

import { useEffect, useRef, useState } from 'react'
import {
  CONTEXT_TOKENS,
  MODEL_LABEL,
  OUTPUT_TOKENS,
  RUNTIME_BYTES,
  RUNTIME_FILES,
  RUNTIME_LABEL,
} from '../text-model/manifest.ts'
import type { ModelState } from '../text-model/state.ts'
import { useModelState } from './useModelState.ts'
import { deleteModelStorage, modelStorage, type ModelStorage } from '../text-model/storage.ts'

const button =
  'rounded-md border border-[var(--color-rule)] px-3 py-2 text-sm transition-colors hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40'

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`

function storageLabel(storage: ModelStorage | undefined): string {
  if (!storage) return 'Checking…'
  if (storage.cached === 0) return 'Not downloaded'
  if (storage.cached === storage.total)
    return `Downloaded · ${megabytes(RUNTIME_BYTES)} cached for offline use`
  return `Partial · ${storage.cached} of ${storage.total} files`
}

function memoryLabel(model: ModelState): string {
  switch (model.phase) {
    case 'idle':
      return 'Not loaded'
    case 'loading':
      return model.detail || 'Loading…'
    case 'ready':
      return 'Loaded · ready to rewrite'
    case 'error':
      return `Failed · ${model.detail}`
  }
}

/**
 * `busy` — a rewrite is running, so the worker is not ours to touch.
 * `supported` — decided by the tab, which asks WebGPU when Advanced options
 * opens and when the mode changes, so a device change is noticed.
 * `refresh` — bumped by the tab when Advanced options opens, so what the
 * panel says about the disk is what is on the disk now.
 * `onNote` — one-line outcomes go to the tab's status line, the single live
 * region the page has; a second one would announce over the first.
 */
export function ModelPanel({
  busy,
  supported,
  refresh,
  onNote,
}: {
  busy: boolean
  /** The tab's WebGPU verdict; undefined until it has been asked. */
  supported: boolean | undefined
  /** Changes when the panel is disclosed again; the cached-file count is re-read. */
  refresh: number
  onNote: (text: string) => void
}) {
  const model = useModelState()
  const [storage, setStorage] = useState<ModelStorage>()
  const [working, setWorking] = useState(false)
  const active = useRef<AbortController | undefined>(undefined)

  const refreshStorage = () => {
    void modelStorage().then(setStorage)
  }
  useEffect(() => {
    refreshStorage()
  }, [refresh])
  useEffect(
    () => () => {
      active.current?.abort()
    },
    [],
  )
  // A download that Clean text started shows up here too; count its files when it lands.
  useEffect(() => {
    if (model.phase === 'ready' || model.phase === 'error') refreshStorage()
  }, [model.phase])

  const download = async () => {
    const controller = new AbortController()
    active.current = controller
    setWorking(true)
    onNote('')
    try {
      const { prepareTextModel } = await import('../text-model/client.ts')
      await prepareTextModel(controller.signal)
      onNote('The model is downloaded and loaded. Deep and Ultra will answer without waiting.')
    } catch (error) {
      if (!controller.signal.aborted)
        onNote(error instanceof Error ? error.message : 'The model could not be loaded.')
    } finally {
      setWorking(false)
      active.current = undefined
      refreshStorage()
    }
  }
  const cancel = () => {
    active.current?.abort()
    active.current = undefined
    onNote('Download cancelled. Files already received stay cached.')
  }
  const release = async () => {
    const { releaseTextModel } = await import('../text-model/client.ts')
    releaseTextModel()
    onNote('Model released from memory. Downloaded files remain cached.')
  }
  const remove = async () => {
    const { releaseTextModel } = await import('../text-model/client.ts')
    releaseTextModel()
    const removed = await deleteModelStorage()
    refreshStorage()
    onNote(
      removed
        ? `Deleted ${removed} cached files. The next AI rewrite downloads the model again.`
        : 'No cached model files to delete.',
    )
  }

  const loading = model.phase === 'loading'
  const downloaded = storage !== undefined && storage.cached === storage.total
  const rows: [string, string][] = [
    ['model', `${MODEL_LABEL} · 4-bit weights, f16 compute`],
    [
      'files',
      `${megabytes(RUNTIME_BYTES)} · ${RUNTIME_FILES.length} files, all served from this site`,
    ],
    ['runtime', `${RUNTIME_LABEL} in a worker · WebGPU`],
    [
      'device',
      supported === undefined
        ? 'Checking WebGPU…'
        : supported
          ? 'WebGPU with shader-f16 available'
          : 'This model needs WebGPU with shader-f16. Clean text will use basic cleaning.',
    ],
    ['storage', storageLabel(storage)],
    ['memory', memoryLabel(model)],
    [
      'limits',
      `${CONTEXT_TOKENS.toLocaleString('en')} token context · ${OUTPUT_TOKENS.toLocaleString('en')} token answer`,
    ],
  ]

  return (
    <section
      aria-labelledby="local-model-heading"
      className="border-t border-[var(--color-rule)] pt-4"
    >
      <h3 id="local-model-heading" className="text-sm">
        Local AI model
      </h3>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Used by Deep and Ultra. Downloads when you first press Clean text in those modes, or now.
        Your text is never uploaded.
      </p>
      <dl aria-label="Local model status" className="mt-3 font-mono text-xs">
        {rows.map(([term, value]) => (
          <div key={term} className="flex gap-4 py-0.5">
            <dt className="w-16 shrink-0 text-[var(--color-muted)]">{term}</dt>
            <dd className="tnum break-words text-[var(--color-bone)]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {loading && working ? (
          <button type="button" onClick={cancel} className={button}>
            Cancel download
          </button>
        ) : model.phase === 'ready' ? undefined : (
          <button
            type="button"
            className={button}
            disabled={supported !== true || busy || loading}
            onClick={() => {
              void download()
            }}
          >
            {downloaded ? 'Load model' : 'Download model'}
          </button>
        )}
        {model.phase === 'ready' ? (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              void release()
            }}
          >
            Release model memory
          </button>
        ) : undefined}
        {storage && storage.cached > 0 ? (
          <button
            type="button"
            className={button}
            disabled={busy || loading}
            onClick={() => {
              void remove()
            }}
          >
            Delete downloaded files
          </button>
        ) : undefined}
      </div>
    </section>
  )
}
