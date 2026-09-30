import { useEffect, useState } from 'react'

/**
 * `value`, once it has stopped changing for `delay` milliseconds.
 *
 * For work too heavy to redo on every keystroke. `useDeferredValue` lets a
 * render be interrupted, but a synchronous computation inside it cannot be:
 * the authorship assessment ran in full on each character typed while its
 * section was open. This hands back the last value that held still, so the
 * work happens once per pause, and the caller can compare it with the live
 * value to say its result is out of date.
 */
export function useStable<T>(value: T, delay: number): T {
  const [stable, setStable] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setStable(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return stable
}
