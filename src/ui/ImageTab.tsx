import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  encodableFormats,
  paint,
  rasterFromBlob,
  rasterToBlob,
  requantizeJpeg,
} from '../image/canvas.ts'
import { disrupt, type DisruptionOptions } from '../image/disrupt.ts'
import {
  DEFAULT_QUALITY,
  defaultFormat,
  EXPORT_FORMATS,
  exportName,
  FORMAT_LABEL,
  hasTransparency,
  measureKey,
  mimeOf,
  type ExportFormat,
} from '../image/export.ts'
import { estimateOverlay, type OverlayCandidate, type Rect } from '../image/detect/overlay.ts'
import { estimateShaped } from '../image/detect/coverage.ts'
import { disjoint, removeAll, removeOverlay } from '../image/detect/remove.ts'
import { findOverlays, scanCorners } from '../image/detect/scan.ts'
import { inpaint, rectMask, rectsMask } from '../image/inpaint/telea.ts'
import { inpaintWithMigan, MODEL_BYTES, RUNTIME_BYTES } from '../image/inpaint/migan.ts'
import { ImageWorker, workerAvailable } from '../image/offload.ts'
import type { Raster } from '../image/raster.ts'
import { cleanContainer, type ContainerFormat } from '../core/container/index.ts'
import { summariseOutcomes, type Finding } from '../core/report.ts'
import { saveBlob } from './download.ts'
import { cleanedName, formatBytes } from './format.ts'
import { Choice, FindingsTable, Limits, Section, Slider, Toggle } from './parts.tsx'
import { IconDownload } from './icons.tsx'

interface Loaded {
  name: string
  raster: Raster
  metadata: Finding[]
  bytes: number
  /**
   * The original file with its metadata removed, and nothing else touched.
   *
   * `cleanContainer` produced this on the way in and it used to be discarded,
   * which meant the one case the tab handles most often — "take the EXIF off
   * this photo" — re-encoded the pixels for no reason and handed back a file
   * five times the size of the one that went in.
   */
  output: Uint8Array
  container: ContainerFormat
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

/**
 * How long the quality slider has to sit still before the file is encoded.
 *
 * Encoding is the measurement — the number shown is a real blob's size, not a
 * model of one — so it is not free, and a drag across the slider is thirty
 * values nobody asked the size of.
 */
const MEASURE_SETTLE_MS = 250

/** A candidate's identity, which is its rectangle. Two scans agree on this. */
const keyOf = (candidate: OverlayCandidate) =>
  `${candidate.rect.x},${candidate.rect.y},${candidate.rect.width},${candidate.rect.height}`

/**
 * Where a region sits, in words.
 *
 * `120x40 at 880,12` is precise and tells a reader nothing about which mark on
 * their screen it means. The corner or edge it is in does, and the numbers stay
 * on the row underneath for anyone who wants them.
 */
function placeOf(rect: Rect, raster: Raster): string {
  const spansX = rect.width >= raster.width * 0.9
  const spansY = rect.height >= raster.height * 0.9
  if (spansX && spansY) return 'the whole frame'

  const middleX = rect.x + rect.width / 2
  const middleY = rect.y + rect.height / 2
  const across =
    middleX < raster.width / 3 ? 'left' : middleX > (raster.width * 2) / 3 ? 'right' : ''
  const down =
    middleY < raster.height / 3 ? 'top' : middleY > (raster.height * 2) / 3 ? 'bottom' : ''

  if (spansX) return `${down || 'middle'} band`
  if (spansY) return `${across || 'middle'} column`
  if (across && down) return `${down} ${across}`
  return across || down || 'centre'
}

/**
 * A rectangle drawn over the canvas, in the picture's own coordinates.
 *
 * Percentages rather than pixels, because the canvas element is capped at
 * 2048px for display and a 40-megapixel raster is drawn much smaller than it
 * is. A box positioned in raster pixels would land somewhere else entirely.
 */
function RegionBox({
  rect,
  raster,
  tone,
}: {
  rect: Rect
  raster: Raster
  tone: 'faint' | 'bright' | 'selected'
}) {
  const border =
    tone === 'faint'
      ? 'border-[var(--color-rule-bright)]'
      : tone === 'bright'
        ? 'border-[var(--color-bone)]'
        : 'border-[var(--color-signal)]'

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute border transition-colors duration-150 ${border}`}
      style={{
        left: `${(rect.x / raster.width) * 100}%`,
        top: `${(rect.y / raster.height) * 100}%`,
        width: `${(rect.width / raster.width) * 100}%`,
        height: `${(rect.height / raster.height) * 100}%`,
      }}
    />
  )
}

/**
 * The cost of a large fill, named before it is paid.
 *
 * Telea is O(area) and a big region is a wait worth stating rather than
 * starting. Rendered beside whichever button asked for it: a warning about a
 * batch that appeared under the single-selection panel would be a warning the
 * reader has to go and find, and on a picture with no committed selection that
 * panel is not on the screen at all.
 */
function HeavyPrompt({
  pixels,
  onRun,
  onCancel,
}: {
  pixels: number
  onRun: () => void
  onCancel: () => void
}) {
  return (
    <div className="mt-4 border border-[var(--color-rule-bright)] p-3">
      <p className="text-sm text-[var(--color-bone)]">
        That is {pixels.toLocaleString()} pixels — roughly {seconds(pixels)}.
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        It runs off the main thread, so the page stays usable and you can stop it. Telea also has
        less to work with the larger the hole is: it continues the edges inward, and over a region
        this size that is mostly a smear.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onRun}
          className="rounded-md border border-[var(--color-signal)] px-3 py-1.5 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)]"
        >
          Run it anyway
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-bone)]"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

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
  const [candidates, setCandidates] = useState<OverlayCandidate[]>([])
  // Which candidates a batch action would touch, keyed by rectangle. An index
  // would point at a different region the moment a wider scan reorders the list.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [hovered, setHovered] = useState<string | undefined>()
  const [scanned, setScanned] = useState<'corners' | 'whole'>('corners')
  const [batchNote, setBatchNote] = useState('')
  const [history, setHistory] = useState<Raster[]>([])
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')

  // What the download will be. `keepOriginal` is a preference, not the whole
  // answer: it only holds while the pixels are untouched, and the render below
  // resolves the two into one mode.
  const [keepOriginal, setKeepOriginal] = useState(true)
  const [format, setFormat] = useState<ExportFormat>('png')
  const [quality, setQuality] = useState(DEFAULT_QUALITY)
  const [encodable, setEncodable] = useState<ReadonlySet<ExportFormat>>()
  const [measured, setMeasured] = useState<ReadonlyMap<string, Blob>>(new Map())
  const [measuring, setMeasuring] = useState(false)

  const [aiPrompt, setAiPrompt] = useState(false)
  const [aiNote, setAiNote] = useState('')
  const [modelReady, setModelReady] = useState(false)
  const [heavyPrompt, setHeavyPrompt] = useState<'' | 'selection' | 'batch'>('')
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
    // A scan still running belongs to the file being replaced. The id map keeps
    // its reply from being mistaken for another job's, but not from being
    // applied to a picture the visitor has already moved on from.
    worker.current?.cancel()
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
        output: stripped.output,
        container: stripped.format,
      })
      setRaster(decoded)
      setHistory([])
      setSelection(undefined)
      setCommitted(undefined)
      setCandidates(scanCorners(decoded))
      setTicked(new Set())
      setScanned('corners')
      // Do not change the kind of file someone brought you: a photograph
      // arrives lossy and leaves lossy, and a screenshot stays a PNG.
      setFormat(defaultFormat(stripped.format))
      setQuality(DEFAULT_QUALITY)
      setKeepOriginal(true)
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

  /**
   * Whether any pixel has been touched.
   *
   * By identity, not by a flag: every operation here returns a fresh Raster and
   * `undo` puts the previous object back, so this is exact and costs nothing.
   * It is what decides whether handing back the original file is still an
   * honest offer or would quietly throw an edit away.
   */
  const edited = loaded !== undefined && raster !== loaded.raster
  const lossless = keepOriginal && !edited

  useEffect(() => {
    void encodableFormats().then(setEncodable)
  }, [])

  // Any edit invalidates every measurement, including the one on screen.
  useEffect(() => setMeasured(new Map()), [raster])

  const encodeNow = useCallback(
    async (source: Raster, chosen: ExportFormat, level: number): Promise<Blob | undefined> => {
      const mime = mimeOf(chosen)
      if (!workerAvailable()) {
        return rasterToBlob(source, mime, chosen === 'png' ? undefined : level)
      }
      const outcome = await offload().encode(source, mime, level)
      return outcome?.blob
    },
    [offload],
  )

  /**
   * What has to be encoded, in the order it is wanted.
   *
   * The chosen format first, because that is the number the reader is waiting
   * on. PNG second, and only when it is not already the choice, because the
   * comparison — "PNG would be 19.4 MB" — is what makes the old default's cost
   * visible rather than merely absent.
   */
  const wanted = useMemo(
    () => (format === 'png' ? ['png'] : [measureKey(format, quality), 'png']),
    [format, quality],
  )

  useEffect(() => {
    if (!raster || lossless || busy !== '') return

    const pending = wanted.find((key) => !measured.has(key))
    if (!pending) return

    const target: ExportFormat = pending === 'png' ? 'png' : format
    let live = true
    const timer = setTimeout(() => {
      setMeasuring(true)
      void encodeNow(raster, target, quality)
        .then((blob) => {
          // A cancel elsewhere terminates the shared worker and resolves this
          // with nothing. There is no result and no failure to report.
          if (live && blob) setMeasured((known) => new Map(known).set(pending, blob))
        })
        .catch(() => {
          if (live) setError('this browser could not encode that format')
        })
        .finally(() => {
          if (live) setMeasuring(false)
        })
    }, MEASURE_SETTLE_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [raster, lossless, busy, wanted, measured, format, quality, encodeNow])

  const download = useCallback(async () => {
    if (!raster || !loaded) return

    if (lossless) {
      saveBlob(new Blob([loaded.output as BlobPart]), cleanedName(loaded.name))
      return
    }

    // The blob whose size was shown is the blob that is saved. Encoding a
    // second time to produce the file would risk handing over something other
    // than the thing that was measured.
    const key = measureKey(format, quality)
    const blob = measured.get(key) ?? (await encodeNow(raster, format, quality))
    if (!blob) return
    saveBlob(blob, exportName(loaded.name, format))
  }, [raster, loaded, lossless, format, quality, measured, encodeNow])

  /**
   * Look everywhere, on request.
   *
   * A button rather than part of opening a file, and the panel says why: over
   * the whole frame the flat model reads a patch of smooth sky as a strongly
   * opaque overlay, more confidently than it reads some real marks. That is a
   * list worth offering to someone who asked for it and worth refusing to
   * volunteer.
   */
  const runWideScan = useCallback(async () => {
    if (!raster) return
    setError('')
    setBusy('scanning the whole image')
    setProgress(0)
    try {
      const found = workerAvailable()
        ? await offload().scan(raster, { wide: true, shaped: true }, (fraction) =>
            setProgress(fraction),
          )
        : { candidates: findOverlays(raster, { wide: true, shaped: true }) }

      if (!found) return
      setCandidates(found.candidates)
      // Flat candidates start ticked, shaped ones do not. The difference is
      // measured, not stylistic: coverage.test.ts records a shaped estimate
      // that cannot tell a badge from a road sign.
      setTicked(new Set(found.candidates.filter((c) => c.kind === 'flat').map((c) => keyOf(c))))
      setScanned('whole')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the scan failed')
    } finally {
      setBusy('')
      setProgress(0)
    }
  }, [raster, offload])

  const chosen = useMemo(
    () => candidates.filter((candidate) => ticked.has(keyOf(candidate))),
    [candidates, ticked],
  )

  /**
   * Undo every ticked region, as one operation and one undo step.
   *
   * `disjoint` first: two regions that share a pixel would have it inverted
   * twice, which is worse than leaving the mark alone. It drops rather than
   * trims, and the count it drops is reported rather than swallowed.
   */
  const runRemoveAll = useCallback(async () => {
    if (!raster || chosen.length === 0) return
    setError('')
    const safe = disjoint(chosen)

    setBusy(`removing ${safe.length === 1 ? 'one region' : `${safe.length} regions`}`)
    setProgress(0)
    try {
      const outcome = workerAvailable()
        ? await offload().removeAll(raster, safe, (fraction) => setProgress(fraction))
        : { raster: removeAll(raster, safe), note: '' }

      if (!outcome) return
      apply(outcome.raster, raster)
      setBatchNote(
        safe.length < chosen.length
          ? `Removed ${safe.length} of ${chosen.length}. The rest overlapped a region already undone, and inverting a pixel twice damages it more than the mark did.`
          : '',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the removal failed')
    } finally {
      setBusy('')
      setProgress(0)
    }
  }, [raster, chosen, apply, offload])

  const chosenPixels = useMemo(
    () =>
      chosen.reduce(
        (pixels, candidate) => pixels + candidate.rect.width * candidate.rect.height,
        0,
      ),
    [chosen],
  )

  /** Fill every ticked region in one Telea pass over the union of them. */
  const runInpaintAll = useCallback(async () => {
    if (!raster || chosen.length === 0) return
    setError('')
    setBatchNote('')
    setHeavyPrompt('')
    const mask = rectsMask(
      raster.width,
      raster.height,
      chosen.map((candidate) => candidate.rect),
    )

    setBusy('inpainting')
    setProgress(0)
    try {
      const outcome = workerAvailable()
        ? await offload().inpaint(raster, mask, (fraction) => setProgress(fraction))
        : { raster: inpaint(raster, mask), note: '' }
      if (outcome) apply(outcome.raster, raster)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the inpaint failed')
    } finally {
      setBusy('')
      setProgress(0)
    }
  }, [raster, chosen, apply, offload])

  const runInpaint = useCallback(async () => {
    if (!raster || !committed) return
    setHeavyPrompt('')
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
    // The routing lives in remove.ts now, shared with the batch. It used to be
    // written out here, which was fine while removal was one region at a time
    // and became a second copy of the same decision the moment it was not.
    apply(
      removeOverlay(raster, {
        ...estimate,
        kind: flat ? 'flat' : 'shaped',
        source: 'selection',
      }),
      raster,
    )
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

  const current = measured.get(measureKey(format, quality))
  const asPng = measured.get('png')
  // Scanned once per edit rather than per render: this walks every pixel, and
  // a 40-megapixel raster does not want that on a slider drag.
  const transparent = useMemo(() => (raster ? hasTransparency(raster) : false), [raster])

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
              {/* Every proposed region, drawn faintly, and the hovered one
                  brightly. This is the change that makes the list legible: a
                  row reading `120x40 at 880,12` is a fact about a picture the
                  reader is looking at, and until now it was the only place that
                  fact appeared. */}
              {candidates.map((candidate) => (
                <RegionBox
                  key={keyOf(candidate)}
                  rect={candidate.rect}
                  raster={raster}
                  tone={hovered === keyOf(candidate) ? 'bright' : 'faint'}
                />
              ))}
              {selection && selection.width > 2 ? (
                <RegionBox rect={selection} raster={raster} tone="selected" />
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

        {raster && loaded ? (
          <Section
            title="Download"
            aside={<span className="tnum font-mono">arrived at {formatBytes(loaded.bytes)}</span>}
          >
            <Choice
              name="download-mode"
              label="What to download"
              value={lossless ? 'original' : 'reencode'}
              onChange={(next) => setKeepOriginal(next === 'original')}
              options={[
                {
                  value: 'original',
                  label: 'Original file',
                  unavailable: edited
                    ? 'The pixels have been edited. The original file does not contain those edits.'
                    : undefined,
                },
                { value: 'reencode', label: 'Re-encode' },
              ]}
            />

            {lossless ? (
              <div className="mt-3">
                <p className="tnum font-mono text-sm">
                  <span className="text-[var(--color-bone)]">
                    {formatBytes(loaded.output.length)}
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {' '}
                    · {loaded.container} · not re-encoded
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  The file that arrived, minus its metadata. Every pixel is byte for byte the one it
                  came with, and nothing is compressed a second time — which is why this is the
                  smallest honest answer while the picture is untouched.
                </p>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                <Choice
                  name="download-format"
                  label="Format"
                  value={format}
                  onChange={setFormat}
                  options={EXPORT_FORMATS.map((candidate) => ({
                    value: candidate,
                    label: FORMAT_LABEL[candidate],
                    // Probed, not assumed. Safari answers a request for WebP
                    // with a PNG rather than a refusal, so an option left
                    // enabled here is a file that lies about what is in it.
                    unavailable:
                      encodable && !encodable.has(candidate)
                        ? `This browser cannot encode ${FORMAT_LABEL[candidate]}. It would hand back a PNG under that name.`
                        : undefined,
                  }))}
                />

                {format === 'png' ? undefined : (
                  <Slider
                    label="Quality"
                    min={30}
                    max={100}
                    step={1}
                    value={Math.round(quality * 100)}
                    reading={String(Math.round(quality * 100))}
                    onChange={(next) => setQuality(next / 100)}
                  />
                )}

                <p className="tnum font-mono text-sm">
                  {/* An <output>, because that is what this is: a figure the
                      page computed rather than one the visitor typed. It also
                      gives the number a name to be announced under when it
                      changes, which a <span> that silently swaps 19.4 MB for
                      2.1 MB does not. */}
                  <output
                    className={current ? 'text-[var(--color-bone)]' : 'text-[var(--color-muted)]'}
                  >
                    {current
                      ? formatBytes(current.size)
                      : measuring
                        ? 'measuring…'
                        : busy !== ''
                          ? 'waiting'
                          : '—'}
                  </output>
                  {format !== 'png' && asPng ? (
                    <span className="text-[var(--color-muted)]">
                      {' '}
                      · PNG would be {formatBytes(asPng.size)}
                    </span>
                  ) : undefined}
                </p>

                <p className="text-xs text-[var(--color-muted)]">
                  PNG is lossless, and on a photograph that makes it the largest file the browser
                  knows how to write. JPEG and WebP compress a picture that was already compressed
                  once — at 85 the second generation is hard to see, below about 70 the 8×8 blocks
                  start showing on flat gradients.
                </p>

                {format === 'jpeg' && transparent ? (
                  <p className="text-xs text-[var(--color-signal)]">
                    This image has transparent pixels and JPEG has no alpha channel. They will come
                    out black, not clear. PNG and WebP keep them.
                  </p>
                ) : undefined}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={working || (!lossless && !current && measuring)}
                onClick={() => void download()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconDownload />
                Download
              </button>
              <span className="tnum truncate font-mono text-xs text-[var(--color-muted)]">
                {lossless ? cleanedName(loaded.name) : exportName(loaded.name, format)}
              </span>
            </div>
          </Section>
        ) : undefined}

        {loaded ? (
          <Section title="Metadata in the file" aside={summariseOutcomes(loaded.metadata)}>
            <FindingsTable findings={loaded.metadata} />
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              {lossless
                ? 'Removed from the download above, which is otherwise the file you dropped in. This is the lossless half — the pixels are not touched.'
                : 'A re-encode drops all of this on its own: the encoder writes a new file from the pixels and nothing else survives the trip.'}
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
            title="Overlay scan"
            aside={
              <span className="tnum font-mono">
                {scanned === 'whole' ? 'whole image' : '4 corners'} ·{' '}
                {candidates.length === 0
                  ? 'nothing'
                  : `${candidates.length} ${candidates.length === 1 ? 'region' : 'regions'}`}
              </span>
            }
          >
            <p className="mb-3 text-xs text-[var(--color-muted)]">
              An <span className="text-[var(--color-bone)]">overlay</span> is something composited
              on top of the picture — a caption scrim, a tint bar, a generator badge. Where it is
              one flat colour at one opacity, it can be undone exactly: the original pixels are
              still underneath, contracted toward the overlay&rsquo;s colour, not replaced by it.
              This lists the regions that measure that way. Nothing here has been changed yet.
            </p>

            {candidates.length > 0 ? (
              <ul className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
                {candidates.map((candidate, index) => {
                  const key = keyOf(candidate)
                  const previous = candidates[index - 1]
                  const opensShaped = candidate.kind === 'shaped' && previous?.kind !== 'shaped'

                  return (
                    <li key={key}>
                      {opensShaped ? (
                        <p className="pt-3 pb-1 text-xs text-[var(--color-signal)]">
                          Shaped marks — a glyph rather than a rectangle. Left unticked on purpose:
                          the same measurement reads a road sign, a page or a lit window exactly as
                          confidently. Check each against the picture before removing it.
                        </p>
                      ) : undefined}
                      <div
                        className="flex items-start gap-2.5 py-2.5"
                        onPointerEnter={() => setHovered(key)}
                        onPointerLeave={() => setHovered(undefined)}
                      >
                        <input
                          type="checkbox"
                          checked={ticked.has(key)}
                          disabled={working}
                          aria-label={`Include the ${placeOf(candidate.rect, raster)} region`}
                          onChange={(event) =>
                            setTicked((current) => {
                              const next = new Set(current)
                              if (event.target.checked) next.add(key)
                              else next.delete(key)
                              return next
                            })
                          }
                          className="mt-1 h-3.5 w-3.5 shrink-0 appearance-none rounded-sm border border-[var(--color-rule-bright)] transition-colors duration-150 checked:border-[var(--color-signal)] checked:bg-[var(--color-signal)] disabled:opacity-40"
                        />
                        <button
                          type="button"
                          disabled={working}
                          onFocus={() => setHovered(key)}
                          onBlur={() => setHovered(undefined)}
                          onClick={() => {
                            setSelection(candidate.rect)
                            setCommitted(candidate.rect)
                          }}
                          className="min-w-0 flex-1 text-left transition-colors duration-150 hover:text-[var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span>{placeOf(candidate.rect, raster)}</span>
                            <span className="font-mono text-xs text-[var(--color-muted)]">
                              {candidate.kind === 'shaped' ? 'shaped' : 'flat'} ·{' '}
                              {percent(candidate.alpha)} opaque
                            </span>
                          </span>
                          <span className="tnum mt-0.5 block font-mono text-xs text-[var(--color-muted)]">
                            {candidate.rect.width}×{candidate.rect.height} at {candidate.rect.x},
                            {candidate.rect.y} · {hex(candidate.color)} ·{' '}
                            {percent(candidate.confidence)} sure
                          </span>
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : undefined}

            {candidates.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={working || chosen.length === 0}
                  onClick={() => void runRemoveAll()}
                  className="rounded-md border border-[var(--color-signal)] px-3 py-1.5 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)] disabled:cursor-not-allowed disabled:border-[var(--color-rule)] disabled:text-[var(--color-muted)]"
                >
                  Unblend{' '}
                  {chosen.length === 1 ? 'the ticked region' : `all ${chosen.length} ticked`}
                </button>
                <button
                  type="button"
                  disabled={working || chosen.length === 0}
                  onClick={() =>
                    chosenPixels > HEAVY_SELECTION ? setHeavyPrompt('batch') : void runInpaintAll()
                  }
                  className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Inpaint them instead
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    setTicked(
                      ticked.size === candidates.length
                        ? new Set()
                        : new Set(candidates.map((candidate) => keyOf(candidate))),
                    )
                  }
                  className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-bone)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {ticked.size === candidates.length ? 'Untick all' : 'Tick all'}
                </button>
              </div>
            ) : undefined}

            {heavyPrompt === 'batch' ? (
              <HeavyPrompt
                pixels={chosenPixels}
                onRun={() => void runInpaintAll()}
                onCancel={() => setHeavyPrompt('')}
              />
            ) : undefined}

            {batchNote ? (
              <p className="mt-2 text-xs text-[var(--color-signal)]">{batchNote}</p>
            ) : undefined}

            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Click a row to select that region on the picture and adjust its edges by dragging —
              the estimate is recomputed on whatever you settle on. Hovering a row outlines it.
            </p>

            {scanned === 'corners' ? (
              <>
                <p className="mt-3 text-xs text-[var(--color-muted)]">
                  The automatic pass looks in the four corners only, for{' '}
                  <span className="text-[var(--color-bone)]">flat</span> overlays. That is where
                  generator badges are, and searching only there is what lets it find nothing at all
                  in a photograph that carries nothing.
                </p>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void runWideScan()}
                  className="mt-3 rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Scan the whole image
                </button>
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  Bands across the frame, marks in the middle, and shaped glyphs as well as flat
                  rectangles. It takes a few seconds and it is much less precise — read the note it
                  leaves before removing anything.
                </p>
              </>
            ) : (
              <p className="mt-3 text-xs text-[var(--color-signal)]">
                A whole-image scan is a report, not a verdict. Over the full frame this measurement
                cannot tell an overlay from a genuinely smooth part of the picture: a patch of sky,
                a wall, an out-of-focus background reads as a strongly opaque region — measurably
                more confidently than some real marks do. Everything above is a place to look, and
                the ones that are wrong look exactly like the ones that are right.
              </p>
            )}

            {candidates.length === 0 ? (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Nothing measured as a flat overlay. That is not the same as &ldquo;this image is
                clean&rdquo;: a mark that is a shaped glyph, one that covers the whole picture
                evenly, or one encoded in the pixel values rather than drawn on top would all leave
                this empty. Drag a box around anything you can see.
              </p>
            ) : undefined}
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
                  selectedPixels > HEAVY_SELECTION ? setHeavyPrompt('selection') : void runInpaint()
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

            {heavyPrompt === 'selection' ? (
              <HeavyPrompt
                pixels={selectedPixels}
                onRun={() => void runInpaint()}
                onCancel={() => setHeavyPrompt('')}
              />
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
