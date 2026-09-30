// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStable } from './useStable.ts'

// React only runs act() warnings-free when told it is in a test environment.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const seen: string[] = []

function Probe({ value }: { value: string }) {
  seen.push(useStable(value, 400))
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  root = createRoot(container)
  seen.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

describe('useStable', () => {
  it('hands back a value only once it has stopped changing for the delay', () => {
    act(() => root.render(<Probe value="a" />))
    act(() => root.render(<Probe value="ab" />))
    act(() => vi.advanceTimersByTime(200))
    act(() => root.render(<Probe value="abc" />))
    act(() => vi.advanceTimersByTime(399))
    expect(seen.at(-1)).toBe('a')
    act(() => vi.advanceTimersByTime(1))
    expect(seen.at(-1)).toBe('abc')
    // The intermediate value was never handed back: nothing computed it.
    expect(seen).not.toContain('ab')
  })
})
