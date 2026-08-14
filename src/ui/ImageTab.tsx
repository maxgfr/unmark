// oxlint-disable no-await-in-loop -- the disruption pipeline is a sequence of
// transforms where each one consumes the previous result.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { paint, rasterFromBlob, rasterToBlob, requantizeJpeg } from '../image/canvas.ts'
import { cropBorder, resample, scrubLowBits, addNoise } from '../image/disrupt.ts'
import {
  estimateOverlay,
  findCornerOverlays,
  unblend,
  type OverlayEstimate,
  type Rect,
} from '../image/detect/overlay.ts'
import { inpaint, rectMask } from '../image/inpaint/telea.ts'
import {
  inpaintWithMigan,
  isMiganLoaded,
  MODEL_BYTES,
  RUNTIME_BYTES,
} from '../image/inpaint/migan.ts'
import type { Raster } from '../image/raster.ts'
import { cleanContainer } from '../core/container/index.ts'
import type { Finding } from '../core/report.ts'
import { FindingsTable, Limits, Section, Toggle } from './parts.tsx'
import { IconDownload } from './icons.tsx'

interface Loaded {
  name: string
  raster: Raster
  metadata: Finding[]
  bytes: number
}

const hex = ([r, g, b]: readonly [number, number, number]) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

const percent = (value: number) => `${Math.round(value * 100)}%`

export function ImageTab() {
  const [loaded, setLoaded] = useState<Loaded | undefined>()
  const [raster, setRaster] = useState<Raster | undefined>()
  const [selection, setSelection] = useState<Rect | undefined>()
  const [candidates, setCandidates] = useState<OverlayEstimate[]>([])
  const [history, setHistory] = useState<Raster[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const [aiPrompt, setAiPrompt] = useState(false)
  const [aiNote, setAiNote] = useState('')
  const [lowBits, setLowBits] = useState(false)
  const [resampleRound, setResampleRound] = useState(false)
  const [crop, setCrop] = useState(false)
  const [jpeg, setJpeg] = useState(false)
  const [noise, setNoise] = useState(false)

  const canvas = useRef<HTMLCanvasElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const dragStart = useRef<{ x: number; y: number } | undefined>(undefined)

  useEffect(() => {
    if (canvas.current && raster) paint(canvas.current, raster)
  }, [raster])

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
      setCandidates(findCornerOverlays(decoded))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'that file could not be decoded')
    } finally {
      setBusy('')
    }
  }, [])

  const apply = useCallback((next: Raster, current: Raster) => {
    setHistory((past) => [...past, current])
    setRaster(next)
  }, [])

  const estimate = useMemo(
    () => (raster && selection ? estimateOverlay(raster, selection) : undefined),
    [raster, selection],
  )

  const pointerRect = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const element = event.currentTarget
    const box = element.getBoundingClientRect()
    const scale = element.width / box.width
    return {
      x: Math.round((event.clientX - box.left) * scale),
      y: Math.round((event.clientY - box.top) * scale),
    }
  }, [])

  const runDisruptions = useCallback(async () => {
    if (!raster) return
    setBusy('disrupting')
    try {
      let next = raster
      if (crop) next = cropBorder(next, Math.max(2, Math.round(next.width * 0.01)))
      if (resampleRound) {
        const { width } = next
        next = resample(next, 0.85)
        next = resample(next, width / next.width)
      }
      if (jpeg) next = await requantizeJpeg(next, 0.88)
      if (lowBits) next = scrubLowBits(next, 1)
      if (noise) next = addNoise(next, 2, 1)
      apply(next, raster)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the disruption pass failed')
    } finally {
      setBusy('')
    }
  }, [raster, crop, resampleRound, jpeg, lowBits, noise, apply])

  const download = useCallback(async () => {
    if (!raster || !loaded) return
    const blob = await rasterToBlob(raster)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${loaded.name.replace(/\.[^.]+$/, '')}-unmarked.png`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [raster, loaded])

  const runMigan = useCallback(async () => {
    if (!raster || !selection) return
    setAiPrompt(false)
    setAiNote('')
    setBusy(isMiganLoaded() ? 'inpainting with MI-GAN' : 'downloading the model')

    try {
      const mask = rectMask(raster.width, raster.height, selection)
      const result = await inpaintWithMigan(raster, mask, (stage) => {
        setBusy(
          stage === 'runtime'
            ? 'downloading the runtime'
            : stage === 'model'
              ? 'downloading the model'
              : 'inpainting with MI-GAN',
        )
      })
      if (!result) {
        setAiNote('Nothing was selected to fill.')
        return
      }
      apply(result.raster, raster)
      setAiNote(
        `Filled from a ${result.window.width}×${result.window.height} window in ${result.milliseconds} ms.`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? `MI-GAN failed: ${cause.message}` : 'MI-GAN failed to run')
    } finally {
      setBusy('')
    }
  }, [raster, selection, apply])

  const anyDisruption = lowBits || resampleRound || crop || jpeg || noise
  const downloadSize = Math.round((MODEL_BYTES + RUNTIME_BYTES) / 1024 / 1024)

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
                className="w-full cursor-crosshair rounded-md border border-[var(--color-rule)] bg-[var(--color-panel)]"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  dragStart.current = pointerRect(event)
                  setSelection(undefined)
                }}
                onPointerMove={(event) => {
                  const start = dragStart.current
                  if (!start) return
                  const now = pointerRect(event)
                  setSelection({
                    x: Math.min(start.x, now.x),
                    y: Math.min(start.y, now.y),
                    width: Math.abs(now.x - start.x),
                    height: Math.abs(now.y - start.y),
                  })
                }}
                onPointerUp={() => {
                  dragStart.current = undefined
                }}
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
                onClick={() => void download()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] hover:bg-[var(--color-panel)]"
              >
                <IconDownload />
                Download PNG
              </button>
              <button
                type="button"
                disabled={history.length === 0}
                onClick={() => {
                  const previous = history.at(-1)
                  if (!previous) return
                  setHistory((past) => past.slice(0, -1))
                  setRaster(previous)
                }}
                className="rounded-md border border-[var(--color-rule)] px-2.5 py-1 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Undo
              </button>
              {busy ? (
                <span className="font-mono text-xs text-[var(--color-muted)]">{busy}…</span>
              ) : undefined}
              <span className="text-xs text-[var(--color-muted)]">
                Drag on the image to select a region.
              </span>
            </div>
          ) : undefined}
        </Section>

        {loaded ? (
          <Section title="Metadata in the file" aside={`${loaded.metadata.length} found`}>
            <FindingsTable findings={loaded.metadata} />
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              Stripped from the downloaded copy. This is the lossless half — the pixels are not
              touched.
            </p>
          </Section>
        ) : undefined}
      </div>

      <div className="flex flex-col gap-6">
        {candidates.length > 0 ? (
          <Section title="Possible overlays" aside="found in the corners">
            <ul className="divide-y divide-[var(--color-rule)] border-y border-[var(--color-rule)]">
              {candidates.map((candidate) => (
                <li key={`${candidate.rect.x}-${candidate.rect.y}`}>
                  <button
                    type="button"
                    onClick={() => setSelection(candidate.rect)}
                    className="tnum flex w-full items-baseline justify-between gap-4 py-2.5 text-left font-mono text-xs transition-colors duration-150 hover:text-[var(--color-signal)]"
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
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              A corner scan proposes regions; it does not measure them. Click one to select it, then
              adjust the edges by dragging — the estimate is recomputed on whatever you settle on.
            </p>
          </Section>
        ) : undefined}

        {raster && selection && selection.width > 8 ? (
          <Section
            title="Selection"
            aside={
              <span className="tnum font-mono">
                {selection.width}×{selection.height}
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
                  This region behaves like a flat overlay. Unblending inverts the composite exactly
                  — the original pixels come back rather than being guessed at.
                </p>
              </div>
            ) : (
              <p className="mb-4 text-xs text-[var(--color-muted)]">
                No flat overlay detected here. Either there is none, or it is not a single colour at
                one opacity — inpainting is the option then, and it invents what it fills.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!estimate}
                onClick={() => estimate && raster && apply(unblend(raster, estimate), raster)}
                className="rounded-md border border-[var(--color-signal)] px-3 py-1.5 text-xs text-[var(--color-signal)] transition-colors duration-150 hover:bg-[var(--color-signal-dim)] disabled:cursor-not-allowed disabled:border-[var(--color-rule)] disabled:text-[var(--color-muted)]"
              >
                Unblend
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!raster) return
                  setBusy('inpainting')
                  const mask = rectMask(raster.width, raster.height, selection)
                  apply(inpaint(raster, mask), raster)
                  setBusy('')
                }}
                className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)]"
              >
                Inpaint
              </button>
              <button
                type="button"
                onClick={() => (isMiganLoaded() ? void runMigan() : setAiPrompt(true))}
                disabled={busy !== ''}
                className="rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                AI inpaint
              </button>
            </div>

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
              disabled={!anyDisruption || busy !== ''}
              onClick={() => void runDisruptions()}
              className="mt-4 rounded-md border border-[var(--color-rule)] px-3 py-1.5 text-xs text-[var(--color-bone)] transition-colors duration-150 hover:border-[var(--color-rule-bright)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Apply
            </button>
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
          </p>
        </Limits>
      </div>
    </div>
  )
}
