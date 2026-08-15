import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { paint, rasterFromBlob, rasterToBlob, requantizeJpeg } from '../image/canvas.ts'
import { disrupt, type DisruptionOptions } from '../image/disrupt.ts'
import {
  estimateOverlay,
  findCornerOverlays,
  unblend,
  type OverlayEstimate,
  type Rect,
} from '../image/detect/overlay.ts'
import { coverageMap, estimateShaped, unblendVarying } from '../image/detect/coverage.ts'
import { inpaint, rectMask } from '../image/inpaint/telea.ts'
import { inpaintWithMigan, MODEL_BYTES, RUNTIME_BYTES } from '../image/inpaint/migan.ts'
import { ImageWorker, workerAvailable } from '../image/offload.ts'
import type { Raster } from '../image/raster.ts'
import { cleanContainer } from '../core/container/index.ts'
import { summariseOutcomes, type Finding } from '../core/report.ts'
import { saveBlob } from './download.ts'
import { FindingsTable, Limits, Section, Toggle } from './parts.tsx'
import { IconDownload } from './icons.tsx'

interface Loaded {
  name: string
  raster: Raster
  metadata: Finding[]
  bytes: number
}

/**
 * How many steps of undo to keep.
 *
 * Each one is a full-resolution RGBA clone: 48 MB for a 12-megapixel photo. The
 * stack used to be unbounded, so eight operations on a large image was 400 MB
 * of history nobody had asked for and the tab was killed for it.
 */
const UNDO_DEPTH = 8

/** Measured, not guessed: Telea fills about this many pixels a second. */
const TELEA_PIXELS_PER_SECOND = 200_000

/** Past this many pixels the wait is worth warning about rather than starting. */
const HEAVY_SELECTION = 400_000

const hex = ([r, g, b]: readonly [number, number, number]) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

const percent = (value: number) => `${Math.round(value * 100)}%`

const seconds = (pixels: number) => {
  const estimate = pixels / TELEA_PIXELS_PER_SECOND
  return estimate < 10 ? `${Math.round(estimate)} seconds` : `about ${Math.round(estimate)} seconds`
}

export function ImageTab() {
  const [loaded, setLoaded] = useState<Loaded | undefined>()
  const [raster, setRaster] = useState<Raster | undefined>()
  const [selection, setSelection] = useState<Rect | undefined>()
  // The selection the numbers are computed from, which is only ever a settled
  // one. Estimating a shaped overlay walks a 5x5 window over every pixel of the
  // region; doing that on every pointermove of a drag across a large image is
  // several hundred milliseconds per frame, and the figures would be flickering
  // through values nobody asked about anyway.
  const [committed, setCommitted] = useState<Rect | undefined>()
  const [candidates, setCandidates] = useState<OverlayEstimate[]>([])
  const [history, setHistory] = useState<Raster[]>([])
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')

  const [aiPrompt, setAiPrompt] = useState(false)
  const [aiNote, setAiNote] = useState('')
  const [modelReady, setModelReady] = useState(false)
  const [heavyPrompt, setHeavyPrompt] = useState(false)
  const [lowBits, setLowBits] = useState(false)
  const [resampleRound, setResampleRound] = useState(false)
  const [crop, setCrop] = useState(false)
  const [jpeg, setJpeg] = useState(false)
  const [noise, setNoise] = useState(false)

  const canvas = useRef<HTMLCanvasElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const dragStart = useRef<{ x: number; y: number } | undefined>(undefined)
  const worker = useRef<ImageWorker | undefined>(undefined)

  const offload = useCallback(() => {
    worker.current ??= new ImageWorker()
    return worker.current
  }, [])

  useEffect(() => {
    if (canvas.current && raster) paint(canvas.current, raster)
  }, [raster])

  // A worker outlives the component unless it is told not to, and it may be
  // holding a 28 MB model.
  useEffect(() => () => worker.current?.dispose(), [])

  const accept = useCallback(async (file: File) => {
    setError('')
    setBusy('reading')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Metadata first, always: it is the part that can be removed losslessly.
      const stripped = await cleanContainer(bytes, file.name)
      const decoded = await rasterFromBlob(new Blob([bytes as BlobPart]))

      setLoaded({
        name: file.name,
        raster: decoded,
        metadata: [...stripped.findings, ...stripped.preserved],
        bytes: bytes.length,
      })
      setRaster(decoded)
      setHistory([])
      setSelection(undefined)
      setCommitted(undefined)
      setCandidates(findCornerOverlays(decoded))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'that file could not be decoded')
    } finally {
      setBusy('')
    }
  }, [])

  const apply = useCallback((next: Raster, current: Raster) => {
    setHistory((past) => [...past, current].slice(-UNDO_DEPTH))
    setRaster(next)
  }, [])

  /**
   * The two overlay models, in the order they are trusted.
   *
   * estimateOverlay assumes one alpha over the whole rectangle and is exact
   * where that holds. It also returns undefined for every shaped badge — a
   * glyph's own edges add more neighbour detail than the blend removes, so the
   * ratio it measures comes out backwards. estimateShaped is the median-based
   * sibling that survives that, and its alpha is the badge's opacity where it
   * is solid rather than an average over mostly-background.
   */
  const flat = useMemo(
    () => (raster && committed ? estimateOverlay(raster, committed) : undefined),
    [raster, committed],
  )
  const shaped = useMemo(
    () => (raster && committed && !flat ? estimateShaped(raster, committed) : undefined),
    [raster, committed, flat],
  )
  const estimate = flat ?? shaped

  const pointerRect = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, source: Raster) => {
      const box = event.currentTarget.getBoundingClientRect()
      // Scaled through the raster, not through the canvas element: the element
      // is capped at 2048px for display, so its own width is not the picture's.
      return {
        x: Math.round(((event.clientX - box.left) / box.width) * source.width),
        y: Math.round(((event.clientY - box.top) / box.height) * source.height),
      }
    },
    [],
  )

  const endDrag = useCallback(() => {
    dragStart.current = undefined
  }, [])

  const runDisruptions = useCallback(async () => {
    if (!raster) return
    const options: DisruptionOptions = {
      cropPixels: crop ? Math.max(2, Math.round(raster.width * 0.01)) : 0,
      resampleTo: resampleRound ? 0.85 : 1,
      jpegQuality: jpeg ? 0.88 : 0,
      lowBits: lowBits ? 1 : 0,
      noiseAmplitude: noise ? 2 : 0,
      seed: 1,
    }

    setBusy('disrupting')
    setProgress(0)
    try {
      const outcome = workerAvailable()
        ? await offload().disrupt(raster, options)
        : { raster: await disrupt(raster, options, requantizeJpeg), note: '' }
      if (outcome) apply(outcome.raster, raster)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the disruption pass failed')
    } finally {
      setBusy('')
      setProgress(0)
    }
  }, [raster, crop, resampleRound, jpeg, lowBits, noise, apply, offload])

  const download = useCallback(async () => {
    if (!raster || !loaded) return
    const blob = await rasterToBlob(raster)
    saveBlob(blob, `${loaded.name.replace(/\.[^.]+$/, '')}-unmarked.png`)
  }, [raster, loaded])

  const runInpaint = useCallback(async () => {
    if (!raster || !committed) return
    setHeavyPrompt(false)
    setError('')
    const mask = rectMask(raster.width, raster.height, committed)

    setBusy('inpainting')
    setProgress(0)
    try {
      if (workerAvailable()) {
        const outcome = await offload().inpaint(raster, mask, (fraction) => setProgress(fraction))
        // undefined means the Cancel button was pressed. Nothing to report and
        // nothing to apply.
        if (outcome) apply(outcome.raster, raster)
      } else {
        apply(inpaint(raster, mask), raster)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the inpaint failed')
    } finally {
      setBusy('')
      setProgress(0)
    }
  }, [raster, committed, apply, offload])

  const runMigan = useCallback(async () => {
    if (!raster || !committed) return
    setAiPrompt(false)
    setAiNote('')
    setError('')
    const mask = rectMask(raster.width, raster.height, committed)

    setBusy(modelReady ? 'inpainting with MI-GAN' : 'downloading the model')
    setProgress(0)
    try {
      const outcome = workerAvailable()
        ? await offload().migan(raster, mask, (_fraction, note) => note && setBusy(note))
        : await (async () => {
            const result = await inpaintWithMigan(raster, mask, {
              onProgress: (stage) =>
                setBusy(stage === 'model' ? 'downloading the model' : 'inpainting with MI-GAN'),
            })
            return result
              ? {
                  raster: result.raster,
                  note: `Filled from a ${result.window.width}×${result.window.height} window in ${result.milliseconds} ms.`,
                }
              : undefined
          })()

      if (!outcome) return
      setModelReady(true)
      apply(outcome.raster, raster)
      setAiNote(outcome.note)
    } catch (cause) {
      setError(cause instanceof Error ? `MI-GAN failed: ${cause.message}` : 'MI-GAN failed to run')
    } finally {
      setBusy('')
      setProgress(0)
    }
  }, [raster, committed, apply, offload, modelReady])

  const cancel = useCallback(() => {
    worker.current?.cancel()
    setBusy('')
    setProgress(0)
  }, [])

  const runUnblend = useCallback(() => {
    if (!raster || !estimate) return
    // A region the flat estimator is confident about is exactly the case its
    // inverse is exact for, and a coverage map over it can only add measurement
    // noise — about two levels of it. Anything else goes through the map, where
    // a single alpha is worth thirty.
    const restored =
      flat && flat.confidence >= 0.7
        ? unblend(raster, flat)
        : unblendVarying(raster, estimate, coverageMap(raster, estimate.rect, estimate.color))
    apply(restored, raster)
  }, [raster, estimate, flat, apply])

  const undo = useCallback(() => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((past) => past.slice(0, -1))
    setRaster(previous)
  }, [history])

  const anyDisruption = lowBits || resampleRound || crop || jpeg || noise
  const downloadSize = Math.round((MODEL_BYTES + RUNTIME_BYTES) / 1024 / 1024)
  const working = busy !== ''
  const selectedPixels = committed ? committed.width * committed.height : 0

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-12">
      <div className="flex flex-col gap-6">
        <Section
          title={loaded ? loaded.name : 'Drop an image'}
          aside={
            raster ? (
              <span className="tnum font-mono">
                {raster.width}×{raster.height}
              </span>
            ) : undefined
          }
        >
          {raster ? (
            <div className="relative">
              <canvas
                ref={canvas}
                // touch-none is load-bearing. Without it the browser claims the
                // first drag for page scroll and fires pointercancel, and the
                // feature simply does not exist on a phone.
                className="w-full touch-none cursor-crosshair rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)]"
                onPointerDown={(event) => {
                  dragStart.current = pointerRect(event, raster)
                  setSelection(undefined)
                  setCommitted(undefined)
                  // Capture keeps a drag alive once the finger leaves the
                  // canvas, and it throws when the pointer is not one the
                  // browser considers active. It used to run first, so a throw
                  // took the drag with it — an optimisation that could cancel
                  // the thing it was optimising.
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  } catch {
                    /* The drag still works; it just stops at the canvas edge. */
                  }
                }}
                onPointerMove={(event) => {
                  const start = dragStart.current
                  if (!start) return
                  const now = pointerRect(event, raster)
                  setSelection({
                    x: Math.min(start.x, now.x),
                    y: Math.min(start.y, now.y),
                    width: Math.abs(now.x - start.x),
                    height: Math.abs(now.y - start.y),
                  })
                }}
                onPointerUp={() => {
                  endDrag()
                  setCommitted((current) =>
                    selection && selection.width > 8 && selection.height > 8 ? selection : current,
                  )
                }}
                // The gesture the browser took away. Without these two the drag
                // origin survives a cancelled or lost gesture, and the *next*
                // pointer move — a hover, a tap anywhere — carries on drawing a
                // selection anchored to a point the finger left long ago.
                onPointerCancel={() => {
                  endDrag()
                  setSelection(undefined)
                }}
                onLostPointerCapture={endDrag}
              />
              {selection && selection.width > 2 ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute border border-[var(--color-signal)]"
                  style={{
                    left: `${(selection.x / raster.width) * 100}%`,
                    top: `${(selection.y / raster.height) * 100}%`,
                    width: `${(selection.width / raster.width) * 100}%`,
                    height: `${(selection.height / raster.height) * 100}%`,
                  }}
                />
              ) : undefined}
            </div>
          ) : (
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const file = event.dataTransfer.files[0]
                if (file) void accept(file)
              }}
              className="rounded-md border border-dashed border-[var(--color-rule-bright)] p-12 text-center"
            >
              <p className="text-sm text-[var(--color-bone)]">
                Drop an image here, or{' '}
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  className="text-[var(--color-signal)] underline decoration-[var(--color-signal-dim)] underline-offset-4 transition-colors duration-150 hover:decoration-[var(--color-signal)]"
                >
                  choose one
                </button>
                .
              </p>
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Decoded with the browser&rsquo;s own image pipeline. Nothing is uploaded.
              </p>
            </div>
          )}
          <input
            ref={picker}
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void accept(file)
              event.target.value = ''
            }}
            className="sr-only"
          />

          {error ? (
            <p role="alert" className="mt-3 font-mono text-xs text-[var(--color-signal)]">
              {error}
            </p>
          ) : undefined}

          {raster ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={working}
                onClick={() => void download()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconDownload />
                Download PNG
              </button>
              <button
                type="button"
                disabled={working || history.length === 0}
                onClick={undo}
                className="rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Undo
              </button>
              {working ? (
                <>
                  <output className="tnum font-mono text-xs text-[var(--color-muted)]">
                    {busy}
                    {progress > 0 ? ` ${percent(progress)}` : '…'}
                  </output>
                  {/* Indeterminate until the first report arrives, because a bar
                      that sits at 0% reads as stuck rather than as starting. */}
                  <span
                    aria-hidden
                    className="h-0.5 w-24 overflow-hidden rounded-full bg-[var(--color-rule)]"
                  >
                    <span
                      className="block h-full bg-[var(--color-signal)] transition-[width] duration-150"
                      style={{ width: progress > 0 ? `${progress * 100}%` : '15%' }}
                    />
                  </span>
                  <button
                    type="button"
                    onClick={cancel}
                    className="rounded-md border border-[var(--color-signal)] px-2.5 py-1 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <span className="text-xs text-[var(--color-muted)]">
                  Drag on the image to select a region.
                </span>
              )}
            </div>
          ) : undefined}
        </Section>

        {loaded ? (
          <Section title="Metadata in the file" aside={summariseOutcomes(loaded.metadata)}>
            <FindingsTable findings={loaded.metadata} />
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Stripped from the downloaded copy. This is the lossless half — the pixels are not
              touched.
            </p>
          </Section>
        ) : undefined}
      </div>

      <div className="flex flex-col gap-6">
        {/* Shown even when the scan finds nothing, because that is exactly when
            the reader needs to be told what it looked for. An empty panel that
            simply is not there reads as "no watermark here", and on a shaped
            badge — the common case — that is the wrong conclusion. */}
        {raster ? (
          <Section
            title="Possible overlays"
            aside={candidates.length > 0 ? 'found in the corners' : 'nothing flat in the corners'}
          >
            {candidates.length > 0 ? (
              <ul className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                {candidates.map((candidate) => (
                  <li key={`${candidate.rect.x}-${candidate.rect.y}`}>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => {
                        setSelection(candidate.rect)
                        setCommitted(candidate.rect)
                      }}
                      className="tnum flex w-full items-baseline justify-between gap-4 py-2.5 text-left font-mono text-xs transition-colors duration-150 hover:text-[var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span>
                        {candidate.rect.width}×{candidate.rect.height} at {candidate.rect.x},
                        {candidate.rect.y}
                      </span>
                      <span className="text-[var(--color-muted)]">
                        α {percent(candidate.alpha)} · {hex(candidate.color)} ·{' '}
                        {percent(candidate.confidence)} sure
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : undefined}

            {candidates.length > 0 ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                A corner scan proposes regions; it does not measure them. Click one to select it,
                then adjust the edges by dragging — the estimate is recomputed on whatever you
                settle on.
              </p>
            ) : undefined}

            <p className="mt-2 text-xs text-[var(--color-muted)]">
              The scan only finds <span className="text-[var(--color-bone)]">flat</span> overlays:
              one colour at one opacity over a rectangle, like a caption scrim or a tint bar. A
              generator badge usually is not one. A sparkle or a corner mark is a shaped glyph, and
              the detail its own antialiased edges add is the thing that makes the scan read that
              corner as unmarked. Drag a box around it instead — a shaped mark is measured properly
              once it is selected.
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Shaped marks are not proposed automatically because the same measurement flags a road
              sign, a page or a lit window in a corner just as confidently. A list whose wrong
              entries look exactly like its right ones is worse than no list.
            </p>
          </Section>
        ) : undefined}

        {raster && committed && committed.width > 8 ? (
          <Section
            title="Selection"
            aside={
              <span className="tnum font-mono">
                {committed.width}×{committed.height}
              </span>
            }
          >
            {estimate ? (
              <div className="mb-4">
                <p className="font-mono text-sm">
                  <span className="text-[var(--color-signal)]">
                    {percent(estimate.alpha)} opaque
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {' '}
                    · {hex(estimate.color)} · {percent(estimate.confidence)} sure
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {flat
                    ? 'This region behaves like a flat overlay. Unblending inverts the composite exactly — the original pixels come back rather than being guessed at.'
                    : 'This reads as a shaped mark rather than a flat rectangle: a glyph with an antialiased edge, and picture in between. The opacity above is where it is solid. Unblending measures the coverage per pixel and inverts each one by its own alpha, so the parts the mark never touched are left alone.'}
                </p>
              </div>
            ) : (
              <p className="mb-4 text-xs text-[var(--color-muted)]">
                No overlay detected here. Either there is none, or it is not one colour at one
                opacity — inpainting is the option then, and it invents what it fills.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!estimate || working}
                onClick={runUnblend}
                className="rounded-md border border-[var(--color-signal)] px-3 py-1.5 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)] disabled:cursor-not-allowed disabled:border-[var(--color-rule)] disabled:text-[var(--color-muted)]"
              >
                Unblend
              </button>
              <button
                type="button"
                disabled={working}
                onClick={() =>
                  selectedPixels > HEAVY_SELECTION ? setHeavyPrompt(true) : void runInpaint()
                }
                className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Inpaint
              </button>
              <button
                type="button"
                onClick={() => (modelReady ? void runMigan() : setAiPrompt(true))}
                disabled={working}
                className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                AI inpaint
              </button>
            </div>

            {/* Telea is O(area) and this selection is large enough for the wait
                to be worth naming. Starting a fifteen-second freeze because a
                button looked instant is the same mistake as the 41 MB download
                below, in a smaller size. */}
            {heavyPrompt ? (
              <div className="mt-4 border border-[var(--color-rule-bright)] p-3">
                <p className="text-sm text-[var(--color-bone)]">
                  That is {selectedPixels.toLocaleString()} pixels — roughly{' '}
                  {seconds(selectedPixels)}.
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  It runs off the main thread, so the page stays usable and you can stop it. Telea
                  also has less to work with the larger the hole is: it continues the edges inward,
                  and over a region this size that is mostly a smear.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void runInpaint()}
                    className="rounded-md border border-[var(--color-signal)] px-3 py-1.5 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)]"
                  >
                    Run it anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setHeavyPrompt(false)}
                    className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-bone)]"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : undefined}

            {/* The download is a decision, so it is asked for rather than
                started. A page that quietly pulls 41 MB because a button looked
                like the others has spent someone's data without asking. */}
            {aiPrompt ? (
              <div className="mt-4 border border-[var(--color-rule-bright)] p-3">
                <p className="text-sm text-[var(--color-bone)]">
                  MI-GAN needs a one-time {downloadSize} MB download.
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  The model and its runtime are served from this site, not from a third party, and
                  your image is not part of the request — it never leaves the tab. The browser
                  caches both, so this happens once.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void runMigan()}
                    className="rounded-md border border-[var(--color-signal)] px-3 py-1.5 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)]"
                  >
                    Download and run
                  </button>
                  <button
                    type="button"
                    onClick={() => setAiPrompt(false)}
                    className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-bone)]"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : undefined}

            {aiNote ? (
              <p className="tnum mt-3 font-mono text-xs text-[var(--color-muted)]">{aiNote}</p>
            ) : undefined}

            <p className="mt-3 text-xs text-[var(--color-muted)]">
              <span className="text-[var(--color-bone)]">Inpaint</span> continues the edges of the
              hole inward — right for smooth or repeating surroundings, obviously wrong across a
              face or a texture boundary.{' '}
              <span className="text-[var(--color-bone)]">AI inpaint</span> invents plausible content
              instead, and costs a one-time {downloadSize} MB download.
            </p>
          </Section>
        ) : undefined}

        {raster ? (
          <Section title="Signal disruption">
            <p className="mb-3 text-xs text-[var(--color-muted)]">
              For marks encoded in the exact pixel values rather than drawn on top. Every one of
              these is lossy.
            </p>
            <div className="flex flex-col gap-2.5">
              <Toggle
                checked={lowBits}
                onChange={setLowBits}
                hint="Invisible. Destroys LSB payloads."
              >
                Scrub the lowest bit
              </Toggle>
              <Toggle
                checked={resampleRound}
                onChange={setResampleRound}
                hint="Lanczos down and back. Moves every pixel off the grid a mark was embedded against."
              >
                Resample round trip
              </Toggle>
              <Toggle
                checked={crop}
                onChange={setCrop}
                hint="Moves the origin, so a mark keyed to absolute coordinates loses its reference."
              >
                Trim 1% from each edge
              </Toggle>
              <Toggle
                checked={jpeg}
                onChange={setJpeg}
                hint="Discards high-frequency detail in 8×8 blocks. Visible cost."
              >
                JPEG requantise
              </Toggle>
              <Toggle
                checked={noise}
                onChange={setNoise}
                hint="The bluntest option, and the most visible. Offered last for that reason."
              >
                Add noise
              </Toggle>
            </div>
            <button
              type="button"
              disabled={!anyDisruption || working}
              onClick={() => void runDisruptions()}
              className="mt-4 rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply
            </button>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Applied in the order that does least damage — trim, resample, JPEG, low bits, noise —
              not in the order they are listed here.
            </p>
          </Section>
        ) : undefined}

        <Limits>
          <p>
            Robust pixel watermarks — SynthID, Tree-Ring, StableSignature, StegaStamp — survive
            everything on this page. They are designed to survive re-encoding, resizing, cropping
            and inpainting, and no amount of the above removes them. A tool that claims otherwise is
            guessing.
          </p>
          <p className="mt-2">
            Inpainting invents what it fills. Unblending does not — where a region really is a flat
            composite, the original pixels are recovered exactly, which is why it is offered first.
            Where the mark is a shaped glyph rather than a flat rectangle, its solid core is close
            to opaque: almost nothing of the picture underneath was recorded, and unblending it
            recovers almost nothing. Inpainting is the honest option there.
          </p>
        </Limits>
      </div>
    </div>
  )
}
