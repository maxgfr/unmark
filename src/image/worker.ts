// The worker side. A dispatcher, not an implementation.
//
// Everything here delegates: Telea from inpaint/telea.ts, MI-GAN from
// inpaint/migan.ts, the disruption chain from disrupt.ts, all unchanged and all
// still runnable synchronously on the main thread. offload.ts explains why the
// split is drawn here rather than moving the algorithms in.
//
// This is the one file in src/image other than canvas.ts that is allowed to
// touch the platform — it imports canvas.ts for the JPEG round trip, which
// needs an OffscreenCanvas and which workers have. Nothing imports *this*, so
// the rule that keeps the algorithms testable is not weakened by it.
//
// The types come in with `import type` on purpose. A value import of offload.ts
// would pull its `new Worker(new URL('./worker.ts', ...))` into the worker's
// own bundle, leaving Vite emitting a chunk that references itself.

import { requantizeJpeg } from './canvas.ts'
import { disrupt, type DisruptionOptions } from './disrupt.ts'
import { inpaintWithMigan } from './inpaint/migan.ts'
import { inpaint } from './inpaint/telea.ts'
import type { RasterTransfer, WorkRequest, WorkResponse } from './offload.ts'
import type { Raster } from './raster.ts'

/**
 * A worker's global scope, described rather than imported.
 *
 * lib.webworker.d.ts cannot be loaded alongside lib.dom.d.ts, and the app's
 * tsconfig needs the DOM one for everything else. Two members is a smaller
 * price than a second tsconfig for one file.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkRequest>) => void) | null
  postMessage: (message: WorkResponse, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

const adopt = (transfer: RasterTransfer): Raster => ({
  data: new Uint8ClampedArray(transfer.data),
  width: transfer.width,
  height: transfer.height,
})

const handOver = (raster: Raster): RasterTransfer => ({
  data: raster.data.buffer,
  width: raster.width,
  height: raster.height,
})

const report = (id: number, fraction: number, note = '') =>
  scope.postMessage({ id, kind: 'progress', fraction, note })

function finish(id: number, raster: Raster, note = ''): void {
  const transfer = handOver(raster)
  scope.postMessage({ id, kind: 'done', raster: transfer, note }, [transfer.data])
}

async function run(request: WorkRequest): Promise<void> {
  const raster = adopt(request.raster)

  if (request.kind === 'inpaint') {
    const mask = new Uint8Array(request.mask)
    // No shouldStop here: a cancel message cannot be read while this is
    // running, so cancelling is a terminate. offload.ts says why.
    finish(request.id, inpaint(raster, mask, { onProgress: (f) => report(request.id, f) }))
    return
  }

  if (request.kind === 'migan') {
    const mask = new Uint8Array(request.mask)
    const result = await inpaintWithMigan(raster, mask, {
      onProgress: (stage) =>
        report(
          request.id,
          0,
          stage === 'runtime'
            ? 'downloading the runtime'
            : stage === 'model'
              ? 'downloading the model'
              : 'inpainting with MI-GAN',
        ),
    })
    if (!result) {
      scope.postMessage({ id: request.id, kind: 'failed', message: 'nothing was selected to fill' })
      return
    }
    finish(
      request.id,
      result.raster,
      `Filled from a ${result.window.width}×${result.window.height} window in ${result.milliseconds} ms.`,
    )
    return
  }

  const options: DisruptionOptions = request.options
  report(request.id, 0, 'disrupting')
  finish(request.id, await disrupt(raster, options, requantizeJpeg))
}

scope.onmessage = (event: MessageEvent<WorkRequest>) => {
  const request = event.data
  void run(request).catch((cause: unknown) => {
    scope.postMessage({
      id: request.id,
      kind: 'failed',
      message: cause instanceof Error ? cause.message : 'the image worker failed',
    })
  })
}
