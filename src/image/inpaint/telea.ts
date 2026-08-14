// Telea inpainting, in TypeScript rather than through OpenCV.js.
//
// The obvious way to get classic inpainting into a browser is opencv.js, which
// is a ~9 MB WebAssembly download for two functions. This is the same algorithm
// — Telea's "An Image Inpainting Technique Based on the Fast Marching Method"
// (2004) — in about two hundred lines, which keeps the project dependency-free
// and, more usefully, testable: an assertion here costs a function call rather
// than a headless browser and a wasm fetch.
//
// The method fills a region from its boundary inwards, always taking the pixel
// closest to known territory next. Each pixel is a weighted average of the
// known pixels near it, where the weights prefer neighbours that are close, on
// the same level set, and in the direction the boundary is travelling — which
// is what continues an edge into the hole instead of blurring across it.

import { at, clamp, cloneRaster, type Raster } from '../raster.ts'

const KNOWN = 0
const BAND = 1
const INSIDE = 2
const INF = 1e6

/** A binary min-heap keyed on arrival time — the fast marching front. */
class Front {
  private readonly heap: { t: number; x: number; y: number }[] = []

  get size(): number {
    return this.heap.length
  }

  push(t: number, x: number, y: number): void {
    this.heap.push({ t, x, y })
    let index = this.heap.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if ((this.heap[parent]?.t ?? 0) <= (this.heap[index]?.t ?? 0)) break
      ;[this.heap[parent], this.heap[index]] = [
        this.heap[index] as { t: number; x: number; y: number },
        this.heap[parent] as { t: number; x: number; y: number },
      ]
      index = parent
    }
  }

  pop(): { t: number; x: number; y: number } | undefined {
    const top = this.heap[0]
    const last = this.heap.pop()
    if (this.heap.length > 0 && last) {
      this.heap[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < this.heap.length && (this.heap[left]?.t ?? 0) < (this.heap[smallest]?.t ?? 0)) {
          smallest = left
        }
        if (
          right < this.heap.length &&
          (this.heap[right]?.t ?? 0) < (this.heap[smallest]?.t ?? 0)
        ) {
          smallest = right
        }
        if (smallest === index) break
        ;[this.heap[smallest], this.heap[index]] = [
          this.heap[index] as { t: number; x: number; y: number },
          this.heap[smallest] as { t: number; x: number; y: number },
        ]
        index = smallest
      }
    }
    return top
  }
}

interface Grid {
  width: number
  height: number
  flag: Uint8Array
  time: Float32Array
}

const idx = (grid: Grid, x: number, y: number) => y * grid.width + x
const inside = (grid: Grid, x: number, y: number) =>
  x >= 0 && y >= 0 && x < grid.width && y < grid.height

/**
 * One step of the eikonal solver: how long the front takes to reach a pixel,
 * given its two already-reached neighbours along each axis.
 */
function solve(grid: Grid, x1: number, y1: number, x2: number, y2: number): number {
  const first = inside(grid, x1, y1) && grid.flag[idx(grid, x1, y1)] !== INSIDE
  const second = inside(grid, x2, y2) && grid.flag[idx(grid, x2, y2)] !== INSIDE

  if (!first && !second) return INF
  if (!second) return 1 + (grid.time[idx(grid, x1, y1)] ?? INF)
  if (!first) return 1 + (grid.time[idx(grid, x2, y2)] ?? INF)

  const t1 = grid.time[idx(grid, x1, y1)] ?? INF
  const t2 = grid.time[idx(grid, x2, y2)] ?? INF
  const discriminant = 2 - (t1 - t2) ** 2

  if (discriminant > 0) {
    const root = Math.sqrt(discriminant)
    let solution = (t1 + t2 - root) / 2
    if (solution >= t1 && solution >= t2) return solution
    solution = (t1 + t2 + root) / 2
    if (solution >= t1 && solution >= t2) return solution
  }
  return 1 + Math.min(t1, t2)
}

const RADIUS = 5

/**
 * Estimate a pixel's value from the known pixels around it.
 *
 * The three weights are Telea's: `dir` prefers neighbours lying along the
 * direction the front is travelling, which is what carries an edge into the
 * hole rather than smearing across it; `dst` prefers near ones; `lev` prefers
 * ones on the same level set of the arrival time.
 */
function estimate(raster: Raster, grid: Grid, px: number, py: number): [number, number, number] {
  const center = idx(grid, px, py)

  // The front's normal, as the gradient of arrival time.
  let nx = 0
  let ny = 0
  if (inside(grid, px + 1, py) && inside(grid, px - 1, py)) {
    nx = ((grid.time[center + 1] ?? 0) - (grid.time[center - 1] ?? 0)) / 2
  }
  if (inside(grid, px, py + 1) && inside(grid, px, py - 1)) {
    ny = ((grid.time[center + grid.width] ?? 0) - (grid.time[center - grid.width] ?? 0)) / 2
  }

  const accumulated: [number, number, number] = [0, 0, 0]
  let total = 0

  for (let dy = -RADIUS; dy <= RADIUS; dy += 1) {
    const qy = py + dy
    if (qy < 0 || qy >= grid.height) continue

    for (let dx = -RADIUS; dx <= RADIUS; dx += 1) {
      const qx = px + dx
      if (qx < 0 || qx >= grid.width) continue

      const q = idx(grid, qx, qy)
      if (grid.flag[q] === INSIDE) continue

      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared === 0 || distanceSquared > RADIUS * RADIUS) continue
      const distance = Math.sqrt(distanceSquared)

      // p - q, pointing from the known pixel toward the one being filled.
      const rx = -dx
      const ry = -dy

      const dir = Math.abs((rx * nx + ry * ny) / distance) + 1e-6
      const dst = 1 / distanceSquared
      const lev = 1 / (1 + Math.abs((grid.time[q] ?? 0) - (grid.time[center] ?? 0)))
      const weight = dir * dst * lev

      const sample = at(raster, qx, qy)
      for (let c = 0; c < 3; c += 1) {
        let value = raster.data[sample + c] ?? 0

        // Continue the neighbour's own gradient into the hole. This is what
        // keeps a ramp a ramp instead of flattening it to a local average.
        if (qx + 1 < grid.width && qx - 1 >= 0) {
          const right = grid.flag[q + 1]
          const left = grid.flag[q - 1]
          if (right !== INSIDE && left !== INSIDE) {
            const gx =
              ((raster.data[at(raster, qx + 1, qy) + c] ?? 0) -
                (raster.data[at(raster, qx - 1, qy) + c] ?? 0)) /
              2
            value += gx * rx
          }
        }
        if (qy + 1 < grid.height && qy - 1 >= 0) {
          const down = grid.flag[q + grid.width]
          const up = grid.flag[q - grid.width]
          if (down !== INSIDE && up !== INSIDE) {
            const gy =
              ((raster.data[at(raster, qx, qy + 1) + c] ?? 0) -
                (raster.data[at(raster, qx, qy - 1) + c] ?? 0)) /
              2
            value += gy * ry
          }
        }

        accumulated[c] = (accumulated[c] ?? 0) + weight * value
      }
      total += weight
    }
  }

  if (total === 0) return [0, 0, 0]
  return [
    clamp((accumulated[0] ?? 0) / total, 0, 255),
    clamp((accumulated[1] ?? 0) / total, 0, 255),
    clamp((accumulated[2] ?? 0) / total, 0, 255),
  ]
}

/**
 * Fill every pixel the mask marks, from the boundary inwards.
 *
 * `mask` is one byte per pixel: non-zero means "this is a hole". The alpha
 * channel is left as it was — inpainting reconstructs colour, not coverage.
 */
export function inpaint(raster: Raster, mask: Uint8Array): Raster {
  const out = cloneRaster(raster)
  const grid: Grid = {
    width: raster.width,
    height: raster.height,
    flag: new Uint8Array(raster.width * raster.height),
    time: new Float32Array(raster.width * raster.height),
  }

  let holes = 0
  for (let i = 0; i < grid.flag.length; i += 1) {
    if (mask[i]) {
      grid.flag[i] = INSIDE
      grid.time[i] = INF
      holes += 1
    }
  }
  if (holes === 0 || holes === grid.flag.length) return out

  // The initial front: known pixels touching a hole.
  const front = new Front()
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const i = idx(grid, x, y)
      if (grid.flag[i] !== INSIDE) continue

      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nxp = x + dx
        const nyp = y + dy
        if (!inside(grid, nxp, nyp)) continue
        const n = idx(grid, nxp, nyp)
        if (grid.flag[n] === KNOWN) {
          grid.flag[n] = BAND
          grid.time[n] = 0
          front.push(0, nxp, nyp)
        }
      }
    }
  }

  while (front.size > 0) {
    const current = front.pop()
    if (!current) break
    const { x, y } = current
    grid.flag[idx(grid, x, y)] = KNOWN

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nxp = x + dx
      const nyp = y + dy
      if (!inside(grid, nxp, nyp)) continue

      const n = idx(grid, nxp, nyp)
      if (grid.flag[n] !== INSIDE) continue

      const time = Math.min(
        solve(grid, nxp - 1, nyp, nxp, nyp - 1),
        solve(grid, nxp + 1, nyp, nxp, nyp - 1),
        solve(grid, nxp - 1, nyp, nxp, nyp + 1),
        solve(grid, nxp + 1, nyp, nxp, nyp + 1),
      )
      grid.time[n] = time

      const [r, g, b] = estimate(out, grid, nxp, nyp)
      const target = at(out, nxp, nyp)
      out.data[target] = r
      out.data[target + 1] = g
      out.data[target + 2] = b

      grid.flag[n] = BAND
      front.push(time, nxp, nyp)
    }
  }

  return out
}

/** A rectangular mask, the shape the corner detector and a drag select produce. */
export function rectMask(
  width: number,
  height: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8Array {
  const mask = new Uint8Array(width * height)
  const x1 = Math.min(width, rect.x + rect.width)
  const y1 = Math.min(height, rect.y + rect.height)

  for (let y = Math.max(0, rect.y); y < y1; y += 1) {
    mask.fill(1, y * width + Math.max(0, rect.x), y * width + x1)
  }
  return mask
}
