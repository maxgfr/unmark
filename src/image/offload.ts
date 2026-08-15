// Getting the slow half of this app off the main thread.
//
// ImageTab used to call `setBusy('inpainting')`, then `inpaint()`, then
// `setBusy('')` — all synchronously, inside one React batch. React does not
// render between those, so the indicator never appeared: the tab simply froze
// for however long Telea took, and on a large selection that is several
// seconds with no repaint, no scroll and no way out.
//
// The fix is a module worker. The algorithms do not move — telea.ts and
// migan.ts stay exactly where they were, synchronous and testable under Node —
// and worker.ts is a dispatcher around them. That split is deliberate: the
// vitest suite has no Worker at all, so anything that only existed inside one
// would be untested by construction.
//
// Cancellation is a terminate, not a flag. A worker running a synchronous
// function cannot read its own message queue, so a cancel message sent while
// Telea is marching sits unread until Telea finishes — which is precisely the
// wait being cancelled. The usual escape is a SharedArrayBuffer the main thread
// writes and the worker polls, but SharedArrayBuffer needs cross-origin
// isolation, and this site is served from GitHub Pages, which cannot send the
// headers. So Cancel kills the worker outright and a fresh one is spawned for
// the next job. It costs a re-instantiated MI-GAN session next time — the
// weights come back from the HTTP cache, not the network — and it is instant,
// which is the property a Cancel button is judged on.
//
// `inpaint` still takes a cooperative `shouldStop`. That is not dead: it is
// what the synchronous fallback path uses in a browser with no worker, and it
// is what carries the progress callback.

import type { OverlayCandidate } from './detect/overlay.ts'
import type { ScanOptions } from './detect/scan.ts'
import type { DisruptionOptions } from './disrupt.ts'
import type { Raster } from './raster.ts'

/**
 * A raster in the shape postMessage can hand over rather than copy.
 *
 * Only the return leg is genuinely free. Going out, the page still needs its
 * own copy — the raster on screen is the one being edited from — so the buffer
 * is copied once on the way in, which is what a structured clone would have
 * cost anyway. Coming back, the worker's result buffer is transferred and
 * adopted with no copy at all, and that is the leg that carries a full-size
 * result on every operation.
 */
export interface RasterTransfer {
  data: ArrayBuffer
  width: number
  height: number
}

export type WorkRequest =
  | { id: number; kind: 'inpaint'; raster: RasterTransfer; mask: ArrayBuffer }
  | { id: number; kind: 'migan'; raster: RasterTransfer; mask: ArrayBuffer }
  | { id: number; kind: 'disrupt'; raster: RasterTransfer; options: DisruptionOptions }
  | { id: number; kind: 'encode'; raster: RasterTransfer; mime: string; quality: number }
  | { id: number; kind: 'scan'; raster: RasterTransfer; options: ScanOptions }
  | { id: number; kind: 'removeAll'; raster: RasterTransfer; candidates: OverlayCandidate[] }

export type WorkResponse =
  | { id: number; kind: 'progress'; fraction: number; note: string }
  | { id: number; kind: 'done'; raster: RasterTransfer; note: string }
  | { id: number; kind: 'encoded'; blob: Blob }
  | { id: number; kind: 'found'; candidates: OverlayCandidate[] }
  | { id: number; kind: 'failed'; message: string }

/** Copy a raster into a message. The page keeps its own; see RasterTransfer. */
export const copyForTransfer = (raster: Raster): RasterTransfer => ({
  data: raster.data.slice().buffer,
  width: raster.width,
  height: raster.height,
})

/** Adopt a transferred buffer. No copy: this side now owns it. */
export const adoptTransfer = (transfer: RasterTransfer): Raster => ({
  data: new Uint8ClampedArray(transfer.data),
  width: transfer.width,
  height: transfer.height,
})

export interface Progress {
  (fraction: number, note: string): void
}

export interface Outcome {
  raster: Raster
  /** Whatever the worker wants to say about what it did. Empty for most jobs. */
  note: string
}

/**
 * What an encode job comes back with.
 *
 * A separate shape from Outcome because it genuinely is one: measuring a file
 * size produces a file, not a picture, and folding it into `Outcome` would mean
 * every caller carrying a raster field that is never populated.
 */
export interface Encoded {
  blob: Blob
}

/**
 * What a scan comes back with.
 *
 * Its own shape for the same reason as Encoded, plus a practical one: echoing
 * the raster back to fit `done` would be a 48 MB round trip to deliver a few
 * hundred bytes of rectangles.
 */
export interface Found {
  candidates: OverlayCandidate[]
}

export type JobResult = Outcome | Encoded | Found

interface Pending {
  resolve: (result: JobResult | undefined) => void
  reject: (cause: unknown) => void
  onProgress: Progress | undefined
}

/** False in the vitest suite, in a browser too old to matter, and nowhere else. */
export const workerAvailable = (): boolean => typeof Worker !== 'undefined'

/**
 * The main thread's half of the worker.
 *
 * One worker, one job at a time in practice — the UI disables everything while
 * busy — but the id on every message means a stale reply from a job that was
 * cancelled cannot be mistaken for the answer to the next one.
 */
export class ImageWorker {
  private worker: Worker | undefined
  private readonly pending = new Map<number, Pending>()
  private next = 1

  private ensure(): Worker {
    if (this.worker) return this.worker

    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkResponse>) => {
      const message = event.data
      const waiting = this.pending.get(message.id)
      if (!waiting) return

      if (message.kind === 'progress') {
        waiting.onProgress?.(message.fraction, message.note)
        return
      }
      this.pending.delete(message.id)
      if (message.kind === 'done') {
        waiting.resolve({ raster: adoptTransfer(message.raster), note: message.note })
      } else if (message.kind === 'encoded') {
        waiting.resolve({ blob: message.blob })
      } else if (message.kind === 'found') {
        waiting.resolve({ candidates: message.candidates })
      } else {
        waiting.reject(new Error(message.message))
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      // A worker that fails to load fails every job, and silently leaving them
      // pending would leave the UI busy forever.
      const cause = new Error(event.message || 'the image worker failed to start')
      for (const waiting of this.pending.values()) waiting.reject(cause)
      this.pending.clear()
      this.worker = undefined
    }

    this.worker = worker
    return worker
  }

  private send<T extends JobResult>(
    build: (id: number) => WorkRequest,
    transfer: Transferable[],
    onProgress?: Progress,
  ): Promise<T | undefined> {
    const id = this.next
    this.next += 1
    const request = build(id)

    return new Promise<T | undefined>((resolve, reject) => {
      // The one cast in this file. Which response shape a job produces is
      // fixed by its `kind`, and the pending map cannot express that without a
      // second map per shape — which would buy nothing but three more places
      // for a stale id to be forgotten in.
      this.pending.set(id, {
        resolve: resolve as Pending['resolve'],
        reject,
        onProgress,
      })
      this.ensure().postMessage(request, transfer)
    })
  }

  /** Resolves with undefined when the job was cancelled. */
  inpaint(raster: Raster, mask: Uint8Array, onProgress?: Progress): Promise<Outcome | undefined> {
    const carried = copyForTransfer(raster)
    const carriedMask = mask.slice().buffer
    return this.send<Outcome>(
      (id) => ({ id, kind: 'inpaint', raster: carried, mask: carriedMask }),
      [carried.data, carriedMask],
      onProgress,
    )
  }

  migan(raster: Raster, mask: Uint8Array, onProgress?: Progress): Promise<Outcome | undefined> {
    const carried = copyForTransfer(raster)
    const carriedMask = mask.slice().buffer
    return this.send<Outcome>(
      (id) => ({ id, kind: 'migan', raster: carried, mask: carriedMask }),
      [carried.data, carriedMask],
      onProgress,
    )
  }

  disrupt(
    raster: Raster,
    options: DisruptionOptions,
    onProgress?: Progress,
  ): Promise<Outcome | undefined> {
    const carried = copyForTransfer(raster)
    return this.send<Outcome>(
      (id) => ({ id, kind: 'disrupt', raster: carried, options }),
      [carried.data],
      onProgress,
    )
  }

  /**
   * Encode the raster to a file, off the main thread.
   *
   * The size the download panel shows is this blob's size, and the blob it
   * shows the size of is the one that gets saved. Encoding a 40-megapixel
   * raster to PNG is a second or more of solid arithmetic, which on the main
   * thread is a second of a frozen tab every time a slider moves.
   */
  encode(raster: Raster, mime: string, quality: number): Promise<Encoded | undefined> {
    const carried = copyForTransfer(raster)
    return this.send<Encoded>(
      (id) => ({ id, kind: 'encode', raster: carried, mime, quality }),
      [carried.data],
    )
  }

  /**
   * Look for overlays, off the main thread.
   *
   * Even the corner scan belongs here. It runs on every file that is opened and
   * costs a couple of hundred milliseconds on a 12-megapixel photo, which it
   * used to spend frozen inside the drop handler.
   */
  scan(raster: Raster, options: ScanOptions, onProgress?: Progress): Promise<Found | undefined> {
    const carried = copyForTransfer(raster)
    return this.send<Found>(
      (id) => ({ id, kind: 'scan', raster: carried, options }),
      [carried.data],
      onProgress,
    )
  }

  removeAll(
    raster: Raster,
    candidates: readonly OverlayCandidate[],
    onProgress?: Progress,
  ): Promise<Outcome | undefined> {
    const carried = copyForTransfer(raster)
    return this.send<Outcome>(
      (id) => ({ id, kind: 'removeAll', raster: carried, candidates: [...candidates] }),
      [carried.data],
      onProgress,
    )
  }

  /**
   * Stop whatever is running, now.
   *
   * Every outstanding job resolves with undefined rather than rejecting: the
   * caller asked for this, so it is not an error, and making it one would mean
   * a try/catch around every call whose only job is to swallow it.
   */
  cancel(): void {
    this.worker?.terminate()
    this.worker = undefined
    for (const waiting of this.pending.values()) waiting.resolve(undefined)
    this.pending.clear()
  }

  dispose(): void {
    this.cancel()
  }
}
