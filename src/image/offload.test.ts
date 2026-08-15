import { describe, expect, it } from 'vitest'
import { adoptTransfer, copyForTransfer, workerAvailable } from './offload.ts'
import { at, createRaster } from './raster.ts'

// There is no Worker in Node, so the class itself cannot be exercised here —
// that is the whole reason the algorithms stayed out of worker.ts. What can be
// tested is the part that is easy to get wrong and silent when it is: whether
// the page keeps its own pixels when it hands a copy to the worker.

const picture = () => {
  const raster = createRaster(8, 4)
  for (let i = 0; i < raster.data.length; i += 1) raster.data[i] = i % 251
  return raster
}

describe('copyForTransfer', () => {
  it('copies rather than handing over the buffer the page is using', () => {
    // Transferring the raster the canvas is showing would detach it: the page
    // would be left holding a zero-length buffer and the picture would vanish
    // the moment an operation started.
    const raster = picture()
    const message = copyForTransfer(raster)

    expect(message.width).toBe(8)
    expect(message.height).toBe(4)
    expect(message.data).not.toBe(raster.data.buffer)
    expect(message.data.byteLength).toBe(raster.data.length)
    expect([...new Uint8ClampedArray(message.data)]).toEqual([...raster.data])
  })

  it('leaves the original untouched when the copy is written to', () => {
    const raster = picture()
    const message = copyForTransfer(raster)
    new Uint8ClampedArray(message.data)[0] = 200
    expect(raster.data[0]).toBe(0)
  })
})

describe('adoptTransfer', () => {
  it('takes over a buffer without copying it again', () => {
    // The return leg is the one that is genuinely free, and it has to be: it
    // carries a full-size result on every operation.
    const raster = picture()
    const message = copyForTransfer(raster)
    const adopted = adoptTransfer(message)

    expect(adopted.data.buffer).toBe(message.data)
    expect([adopted.width, adopted.height]).toEqual([8, 4])
    expect(adopted.data[at(adopted, 3, 2)]).toBe(raster.data[at(raster, 3, 2)])
  })

  it('round-trips a raster unchanged', () => {
    const raster = picture()
    expect([...adoptTransfer(copyForTransfer(raster)).data]).toEqual([...raster.data])
  })
})

describe('workerAvailable', () => {
  it('is false under the test suite, which is why the sync path exists', () => {
    expect(workerAvailable()).toBe(false)
  })
})
